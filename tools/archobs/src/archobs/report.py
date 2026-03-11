from __future__ import annotations

from dataclasses import dataclass
import html
import json
from pathlib import Path

import pandas as pd

from archobs.config.reporting import ReportRenderOptions
from archobs.graph_viz import export_graph, write_graph_html
from archobs.suggestions import (
    _normalize_suggestion_payload,
    _rule_based_change_suggestions,
    build_change_suggestions,
    format_suggestion_markdown,
    suggestion_engine_label,
    suggestion_error_label,
    suggestions_html,
)


@dataclass(frozen=True, slots=True)
class RenderedReportResult:
    """Report result containing summary, metrics, and drift data."""

    summary: dict[str, object]
    file_metrics: pd.DataFrame
    cluster_metrics: pd.DataFrame
    drift_df: pd.DataFrame


def _ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def _report_dir(base: str | Path) -> Path:
    return _ensure_dir(Path(base) / "report")


def _write_json(data: dict, base: str | Path, name: str) -> Path:
    target = Path(base) / f"{name}.json"
    _ensure_dir(target.parent)
    target.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return target


# ---------------------------------------------------------------------------
# HTML report helpers
# ---------------------------------------------------------------------------


def _table(df: pd.DataFrame) -> str:
    if df.empty:
        return "<p>No data.</p>"
    return df.to_html(index=False, classes="table", border=0)


def _format_metric(value: object) -> str:
    if isinstance(value, float):
        if abs(value) < 0.005:
            return "0.00"
        return f"{value:.2f}"
    return str(value)


def _status_tone(label: str) -> str:
    return {
        "Act now": "danger",
        "Needs focus": "warn",
        "Healthy": "good",
    }.get(label, "neutral")


def _risk_level(summary: dict[str, object], cluster_metrics_df: pd.DataFrame, file_metrics_df: pd.DataFrame, unresolved_df: pd.DataFrame) -> tuple[str, str]:
    node_count = int(summary.get("node_count", 0))
    cluster_count = int(summary.get("cluster_count", 0))
    top_leakage = float(cluster_metrics_df["leakage"].max()) if not cluster_metrics_df.empty else 0.0
    top_risk = float(file_metrics_df["risk"].max()) if not file_metrics_df.empty else 0.0
    top_xnbr = float(file_metrics_df["xnbr"].max()) if not file_metrics_df.empty else 0.0
    unresolved_count = len(unresolved_df)

    if unresolved_count > 0 or top_leakage >= 0.40 or top_xnbr >= 0.50:
        return "Act now", "The report found boundary issues that are likely to affect the next refactor or bug fix."
    if cluster_count <= 1 and node_count >= 10:
        return "Needs focus", "The subsystem map collapsed into one large cluster, so the next step is to sharpen scope before trusting the boundaries."
    if top_risk >= 0.45:
        return "Needs focus", "A few files concentrate most of the change risk and should be reviewed before the next large edit."
    return "Healthy", "No urgent structural issues stand out in this snapshot; use the queue below to guide the next review pass."


def _recommendations(summary: dict[str, object], cluster_metrics_df: pd.DataFrame, file_metrics_df: pd.DataFrame, unresolved_df: pd.DataFrame, drift_df: pd.DataFrame) -> list[dict[str, str]]:
    actions: list[dict[str, str]] = []
    node_count = int(summary.get("node_count", 0))
    cluster_count = int(summary.get("cluster_count", 0))

    if cluster_count <= 1 and node_count >= 10:
        actions.append(
            {
                "priority": "High",
                "title": "Recover subsystem boundaries",
                "why": f"This run grouped {node_count} files into a single subsystem, which makes the map hard to act on.",
                "next_step": "Rerun on product directories only or exclude tests/tooling paths so the clustering can separate real boundaries.",
            }
        )

    if not cluster_metrics_df.empty:
        top_cluster = cluster_metrics_df.sort_values(["leakage", "risk_max"], ascending=[False, False]).iloc[0]
        if float(top_cluster["leakage"]) >= 0.20:
            actions.append(
                {
                    "priority": "High" if float(top_cluster["leakage"]) >= 0.40 else "Medium",
                    "title": f"Contain leakage in cluster {int(top_cluster['cluster_id'])}",
                    "why": f"Leakage is {float(top_cluster['leakage']):.0%}, which suggests cross-boundary coupling is pulling the cluster apart.",
                    "next_step": "Open the graph view, inspect the cross-cluster connectors, and move shared helpers behind a narrower interface.",
                }
            )

    if not file_metrics_df.empty:
        top_file = file_metrics_df.sort_values(["risk", "xnbr", "hubness"], ascending=[False, False, False]).iloc[0]
        path = str(top_file["path"])
        if float(top_file["xnbr"]) >= 0.35:
            actions.append(
                {
                    "priority": "High" if float(top_file["xnbr"]) >= 0.50 else "Medium",
                    "title": f"Split mixed concerns in {path}",
                    "why": f"The semantic boundary violation rate is {float(top_file['xnbr']):.0%}, which suggests this file belongs to more than one concern.",
                    "next_step": "Review imports and responsibilities in this file first, then extract the cross-boundary logic into a dedicated module.",
                }
            )
        elif float(top_file["hubness"]) >= 0.45:
            actions.append(
                {
                    "priority": "Medium",
                    "title": f"Reduce blast radius around {path}",
                    "why": f"This file has the strongest hub signal in the current graph and is likely to amplify future change risk.",
                    "next_step": "Add coverage before editing it again, and consider wrapping high-fan-in logic behind a smaller facade.",
                }
            )
        elif float(top_file["volatility"]) >= 0.60:
            actions.append(
                {
                    "priority": "Medium",
                    "title": f"Stabilize churn in {path}",
                    "why": "This file is changing often enough to merit extra safeguards before the next refactor.",
                    "next_step": "Add regression tests around the current behavior before you move code out of it.",
                }
            )

    if len(unresolved_df) > 0:
        sample = ", ".join(unresolved_df["source_path"].head(3).tolist())
        actions.append(
            {
                "priority": "Medium",
                "title": f"Resolve {len(unresolved_df)} internal imports",
                "why": "Unresolved imports weaken the dependency layer and can hide real architecture edges.",
                "next_step": f"Start with: {sample}",
            }
        )

    if drift_df.empty:
        actions.append(
            {
                "priority": "Low",
                "title": "Add a drift baseline",
                "why": "The current report is a snapshot, so it cannot yet tell you whether architecture health is improving or decaying over time.",
                "next_step": "Keep this report artifact and compare it after the next structural change or weekly on the main branch.",
            }
        )

    if not actions:
        actions.append(
            {
                "priority": "Low",
                "title": "Use the graph to validate boundaries",
                "why": "This snapshot looks structurally healthy enough that the next step is confirmation, not remediation.",
                "next_step": "Open the graph view and review the top five risk files before the next architectural change.",
            }
        )

    priority_rank = {"High": 0, "Medium": 1, "Low": 2}
    actions.sort(key=lambda item: (priority_rank.get(item["priority"], 9), item["title"]))
    return actions[:4]


def _file_reason(row: pd.Series) -> tuple[str, str]:
    if float(row["xnbr"]) >= 0.50:
        return "Cross-boundary semantics", "Split responsibilities or move boundary logic out."
    if float(row["hubness"]) >= 0.45:
        return "Blast-radius hub", "Put tests around this file before broad edits."
    if float(row["volatility"]) >= 0.60:
        return "High churn", "Stabilize behavior before refactoring."
    return "Monitor", "Keep this file on the review queue."


def _cluster_reason(row: pd.Series, total_clusters: int) -> tuple[str, str]:
    if float(row["leakage"]) >= 0.40:
        return "Boundary erosion", "Inspect the graph and reduce cross-cluster edges."
    if int(row["size"]) >= 10 and total_clusters <= 2:
        return "Coarse subsystem", "Narrow scope or exclude support code and rerun."
    return "Stable boundary", "Monitor rather than restructure."


def _metric_cards(summary: dict[str, object]) -> str:
    metrics = [
        ("Files", summary.get("node_count", 0)),
        ("Edges", summary.get("edge_count", 0)),
        ("Subsystems", summary.get("cluster_count", 0)),
        ("Hub Dominance", summary.get("hub_deg", 0)),
        ("Modularity", summary.get("modularity", 0)),
        ("Semantic Signal", summary.get("embedding_provider", "unknown")),
    ]
    return "\n".join(
        f"<div class='card'><div class='label'>{html.escape(label)}</div><div class='value'>{html.escape(_format_metric(value))}</div></div>"
        for label, value in metrics
    )


def _actions_html(actions: list[dict[str, str]]) -> str:
    return "\n".join(
        f"""
        <article class="action-card priority-{action['priority'].lower()}">
          <div class="action-meta">{html.escape(action['priority'])} priority</div>
          <h3>{html.escape(action['title'])}</h3>
          <p><strong>Why:</strong> {html.escape(action['why'])}</p>
          <p><strong>Next step:</strong> {html.escape(action['next_step'])}</p>
        </article>
        """
        for action in actions
    )


# ---------------------------------------------------------------------------
# HTML report writer
# ---------------------------------------------------------------------------


def write_report_html(
    summary: dict[str, object],
    cluster_metrics_df: pd.DataFrame,
    file_metrics_df: pd.DataFrame,
    drift_df: pd.DataFrame,
    unresolved_df: pd.DataFrame,
    out_dir: str | Path,
    suggestions: list[dict[str, str]] | None = None,
    suggestion_engine: str = "rules",
    suggestion_error: str | None = None,
) -> Path:
    report_root = _report_dir(out_dir)
    target = report_root / "index.html"
    top_files = file_metrics_df.head(int(summary.get("top_risk_files", 50)))
    top_clusters = cluster_metrics_df.head(int(summary.get("top_leaky_clusters", 20)))
    unresolved = unresolved_df.head(100)
    status_label, status_text = _risk_level(summary, cluster_metrics_df, file_metrics_df, unresolved_df)
    actions = _recommendations(summary, cluster_metrics_df, file_metrics_df, unresolved_df, drift_df)
    suggestions = (
        suggestions
        if suggestions is not None
        else _normalize_suggestion_payload(_rule_based_change_suggestions(summary, cluster_metrics_df, file_metrics_df, unresolved_df, drift_df))
    )

    queue_df = top_files.copy()
    if not queue_df.empty:
        reasons, next_steps = zip(*[_file_reason(row) for _, row in queue_df.iterrows()], strict=True)
        queue_df["reason"] = list(reasons)
        queue_df["next_step"] = list(next_steps)
        queue_df = queue_df[["path", "risk", "reason", "next_step"]].head(8)

    cluster_df = top_clusters.copy()
    if not cluster_df.empty:
        reasons, next_steps = zip(
            *[_cluster_reason(row, int(summary.get("cluster_count", 0))) for _, row in cluster_df.iterrows()],
            strict=True,
        )
        cluster_df["diagnosis"] = list(reasons)
        cluster_df["next_step"] = list(next_steps)
        cluster_df = cluster_df[["cluster_id", "size", "cohesion", "leakage", "diagnosis", "next_step"]].head(8)

    html_text = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>archobs report</title>
  <style>
    :root {{
      --bg: #f7f6f2;
      --panel: #fffdf8;
      --ink: #1f2937;
      --muted: #6b7280;
      --line: #d1d5db;
      --accent: #9a3412;
      --good: #166534;
      --warn: #a16207;
      --danger: #b91c1c;
    }}
    body {{ background: linear-gradient(180deg, #f7f6f2 0%, #efe7db 100%); color: var(--ink); font-family: Georgia, 'Iowan Old Style', serif; margin: 0; }}
    main {{ max-width: 1320px; margin: 0 auto; padding: 2.25rem; }}
    h1, h2 {{ margin-bottom: 0.5rem; }}
    h3 {{ margin: 0 0 0.5rem; }}
    p {{ color: var(--muted); }}
    .hero {{ display: grid; grid-template-columns: 2fr 1fr; gap: 1.25rem; align-items: stretch; margin-bottom: 1.25rem; }}
    .hero-panel {{ background: linear-gradient(135deg, rgba(255,253,248,0.95), rgba(249,236,223,0.92)); border: 1px solid rgba(209,213,219,0.8); border-radius: 24px; padding: 1.5rem; box-shadow: 0 18px 32px rgba(0,0,0,0.06); }}
    .hero-panel p {{ font-size: 1.02rem; }}
    .status {{ display: inline-block; padding: 0.35rem 0.7rem; border-radius: 999px; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif; font-size: 0.85rem; font-weight: 700; margin-bottom: 0.9rem; }}
    .status-good {{ background: rgba(22,101,52,0.12); color: var(--good); }}
    .status-warn {{ background: rgba(161,98,7,0.12); color: var(--warn); }}
    .status-danger {{ background: rgba(185,28,28,0.12); color: var(--danger); }}
    .hero-links {{ display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1rem; }}
    .hero-links a {{ text-decoration: none; color: white; background: var(--accent); padding: 0.65rem 0.95rem; border-radius: 12px; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif; font-size: 0.92rem; }}
    .hero-links a.secondary {{ background: transparent; color: var(--accent); border: 1px solid rgba(154,52,18,0.3); }}
    .cards {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin: 1.5rem 0 2rem; }}
    .card {{ background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 1rem; box-shadow: 0 8px 20px rgba(0,0,0,0.05); }}
    .label {{ color: var(--muted); font-size: 0.9rem; margin-bottom: 0.25rem; text-transform: capitalize; }}
    .value {{ font-size: 1.5rem; font-weight: 700; color: var(--accent); }}
    section {{ background: rgba(255,255,255,0.72); border: 1px solid rgba(209,213,219,0.8); border-radius: 18px; padding: 1.45rem; margin-bottom: 1.25rem; backdrop-filter: blur(8px); }}
    .actions {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; }}
    .action-card {{ border-radius: 16px; padding: 1.05rem; border: 1px solid var(--line); background: rgba(255,255,255,0.86); }}
    .action-card h3 {{ font-size: 1.15rem; line-height: 1.08; margin-bottom: 0.7rem; }}
    .action-card p {{ margin: 0.6rem 0 0; line-height: 1.55; overflow-wrap: anywhere; }}
    .priority-high {{ border-color: rgba(185,28,28,0.25); box-shadow: inset 0 0 0 1px rgba(185,28,28,0.08); }}
    .priority-medium {{ border-color: rgba(161,98,7,0.25); box-shadow: inset 0 0 0 1px rgba(161,98,7,0.08); }}
    .priority-low {{ border-color: rgba(22,101,52,0.25); box-shadow: inset 0 0 0 1px rgba(22,101,52,0.08); }}
    .action-meta {{ font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif; text-transform: uppercase; letter-spacing: 0.06em; font-size: 0.76rem; color: var(--muted); margin-bottom: 0.4rem; }}
    .section-head {{ display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; flex-wrap: wrap; }}
    .section-head > div:first-child {{ max-width: 760px; }}
    .badge {{ display: inline-block; padding: 0.3rem 0.65rem; border-radius: 999px; background: rgba(154,52,18,0.10); color: var(--accent); font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif; font-size: 0.78rem; font-weight: 700; }}
    .notice {{ margin-top: 0.85rem; padding: 0.85rem 1rem; border-radius: 12px; background: rgba(185,28,28,0.06); border: 1px solid rgba(185,28,28,0.14); color: #7f1d1d; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif; font-size: 0.9rem; }}
    .suggestions-grid {{ display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; align-items: start; margin-top: 1rem; width: 100%; }}
    .suggestion-card {{ display: block; width: 100%; box-sizing: border-box; padding: 1.45rem 1.5rem; background: linear-gradient(180deg, rgba(255,255,255,0.97), rgba(252,248,243,0.94)); overflow: hidden; }}
    .suggestion-rail {{ display: grid; gap: 0.45rem; padding-bottom: 0.95rem; margin-bottom: 1rem; border-bottom: 1px solid rgba(209,213,219,0.75); min-width: 0; }}
    .suggestion-card h3 {{ font-size: clamp(1.45rem, 1.8vw, 1.95rem); line-height: 1.02; max-width: 22ch; margin: 0; text-wrap: balance; overflow-wrap: anywhere; }}
    .suggestion-body {{ display: grid; gap: 1rem; min-width: 0; }}
    .suggestion-block {{ display: grid; gap: 0.4rem; min-width: 0; }}
    .suggestion-label {{ font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif; font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--accent); font-weight: 700; }}
    .suggestion-card p {{ font-size: 1.02rem; line-height: 1.62; margin: 0; max-width: 70ch; }}
    .scope-badges {{ display: flex; flex-wrap: wrap; gap: 0.55rem; }}
    .scope-badge {{ display: inline-flex; align-items: center; padding: 0.42rem 0.68rem; border-radius: 999px; background: rgba(154,52,18,0.08); color: #7c2d12; border: 1px solid rgba(154,52,18,0.12); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; line-height: 1.35; overflow-wrap: anywhere; }}
    .section-grid {{ display: grid; grid-template-columns: 1.4fr 1fr; gap: 1rem; }}
    table {{ border-collapse: collapse; width: 100%; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif; font-size: 0.92rem; }}
    th, td {{ text-align: left; padding: 0.6rem; border-bottom: 1px solid var(--line); vertical-align: top; }}
    th {{ position: sticky; top: 0; background: #fffaf3; }}
    .links a {{ margin-right: 1rem; color: var(--accent); }}
    details {{ margin-top: 1rem; }}
    summary {{ cursor: pointer; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif; font-weight: 600; color: var(--accent); }}
    .quiet {{ color: var(--muted); font-size: 0.95rem; }}
    @media (max-width: 1080px) {{
      .suggestion-card h3, .suggestion-card p {{ max-width: none; }}
    }}
    @media (max-width: 900px) {{
      .hero, .section-grid {{ grid-template-columns: 1fr; }}
      main {{ padding: 1.25rem; }}
    }}
  </style>
</head>
<body>
<main>
  <div class="hero">
    <section class="hero-panel">
      <div class="status status-{_status_tone(status_label)}">{html.escape(status_label)}</div>
      <h1>Architecture Observability Report</h1>
      <p>{html.escape(status_text)}</p>
      <p class="quiet">Use the action plan below to decide what to inspect first, then fall back to the detailed metrics only when you need evidence.</p>
      <div class="hero-links">
        <a href="#actions">What To Do Next</a>
        <a href="#queue" class="secondary">Review Queue</a>
        <a href="graph.html" class="secondary">Open Graph</a>
      </div>
    </section>
    <section>
      <h2>Snapshot</h2>
      <div class="cards">{_metric_cards(summary)}</div>
    </section>
  </div>
  <section>
    <h2 id="actions">What To Do Next</h2>
    <div class="actions">{_actions_html(actions)}</div>
  </section>
  <section>
    <div class="section-head">
      <div>
        <h2>Suggested Changes</h2>
        <p class="quiet">High-level refactoring suggestions grounded in the current architecture analysis. No code snippets.</p>
      </div>
      <div class="badge">{html.escape(suggestion_engine_label(suggestion_engine))}</div>
    </div>
    {"<div class='notice'><strong>" + html.escape(suggestion_error_label(suggestion_engine)) + ":</strong> " + html.escape(suggestion_error) + "</div>" if suggestion_error else ""}
    <div class="suggestions-grid">{suggestions_html(suggestions)}</div>
  </section>
  <section>
    <div class="section-grid">
      <div>
        <h2 id="queue">Review Queue</h2>
        <p class="quiet">Start with these files if you only have one review slot.</p>
        {_table(queue_df)}
      </div>
      <div>
        <h2>Boundary Work</h2>
        <p class="quiet">These clusters need action only if the diagnosis says so.</p>
        {_table(cluster_df)}
      </div>
    </div>
  </section>
  <section>
    <h2>Evidence</h2>
    <div class="links">
      <a href="graph.html">Graph view</a>
      <a href="graph.graphml">GraphML export</a>
      <a href="graph.gexf">GEXF export</a>
    </div>
    <details>
      <summary>Top Risk Metrics</summary>
      {_table(top_files[["path", "cluster_id", "risk", "xnbr", "hubness", "volatility"]])}
    </details>
    <details>
      <summary>Cluster Health</summary>
      {_table(top_clusters[["cluster_id", "size", "cohesion", "leakage", "conductance", "risk_mean", "risk_max"]])}
    </details>
    <details>
      <summary>Drift</summary>
      {_table(drift_df)}
    </details>
    <details>
      <summary>Unresolved Imports</summary>
      {_table(unresolved)}
    </details>
  </section>
</main>
</body>
</html>
"""
    target.write_text(html_text, encoding="utf-8")
    return target



def write_summary_json(summary: dict[str, object], out_dir: str | Path) -> Path:
    report_root = _report_dir(out_dir)
    target = report_root / "summary.json"
    target.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return target


def render_prepared_report(
    prepared_analysis: object,
    options: ReportRenderOptions,
) -> RenderedReportResult:
    summary = build_report_artifacts(
        prepared_analysis,
        suggestions_provider=options.suggestions_provider,
        suggestion_count=options.suggestion_count,
        codex_timeout_seconds=options.codex_timeout_seconds,
        claude_timeout_seconds=options.claude_timeout_seconds,
    )
    return RenderedReportResult(
        summary=summary,
        file_metrics=prepared_analysis.file_metrics_df,
        cluster_metrics=prepared_analysis.cluster_metrics_df,
        drift_df=prepared_analysis.drift_df,
    )


def build_report_artifacts(
    prepared_analysis: object,
    *,
    suggestions_provider: str = "rules",
    suggestion_count: int = 4,
    codex_timeout_seconds: int = 45,
    claude_timeout_seconds: int = 45,
) -> dict[str, object]:
    """Produce all report outputs (graph exports, HTML, suggestions, summary).

    This encapsulates the report-internal orchestration so that the pipeline
    does not need to call ``export_graph``, ``write_graph_html``,
    ``build_change_suggestions``, ``write_report_html``, and
    ``write_summary_json`` individually.
    """
    analysis = prepared_analysis.analysis
    file_metrics_df = prepared_analysis.file_metrics_df
    cluster_metrics_df = prepared_analysis.cluster_metrics_df
    metrics_summary = prepared_analysis.metrics_summary
    clustering_summary = prepared_analysis.cluster_metadata
    graphml_path, gexf_path = export_graph(
        prepared_analysis.graph_snapshot,
        prepared_analysis.out,
    )
    graph_html_path = write_graph_html(
        prepared_analysis.graph_snapshot,
        prepared_analysis.out,
    )

    summary = {
        **metrics_summary,
        **clustering_summary,
        **analysis.summary_base,
        "graphml_path": str(graphml_path),
        "gexf_path": str(gexf_path),
        "graph_html_path": str(graph_html_path),
    }

    suggestion_list, used_engine, error = build_change_suggestions(
        prepared_analysis.repo,
        summary,
        cluster_metrics_df,
        file_metrics_df,
        prepared_analysis.unresolved_df,
        prepared_analysis.drift_df,
        graph_snapshot=prepared_analysis.graph_snapshot,
        provider=suggestions_provider,
        limit=suggestion_count,
        codex_timeout_seconds=codex_timeout_seconds,
        claude_timeout_seconds=claude_timeout_seconds,
    )
    summary["suggestion_engine"] = used_engine
    summary["suggestion_error"] = error

    _write_json(
        {"engine": used_engine, "error": error, "items": suggestion_list},
        prepared_analysis.out,
        "suggestions",
    )

    report_index = write_report_html(
        summary,
        cluster_metrics_df,
        file_metrics_df,
        prepared_analysis.drift_df,
        prepared_analysis.unresolved_df,
        prepared_analysis.out,
        suggestions=suggestion_list,
        suggestion_engine=used_engine,
        suggestion_error=error,
    )
    summary["report_index"] = str(report_index)
    write_summary_json(summary, prepared_analysis.out)
    _write_json(summary, prepared_analysis.out, "summary")
    return summary
