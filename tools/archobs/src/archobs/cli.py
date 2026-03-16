"""CLI commands for architecture observability analysis."""

from __future__ import annotations

import sys
from pathlib import Path

import typer

from archobs.pipeline import (
    AnalysisRun,
    RunConfigOverrides,
    check_dependencies,
    initialize_workspace,
    load_suggestions,
    prepare_config,
    run_report,
)
from archobs.storage import ArtifactStore

app = typer.Typer(help="Architecture observability via graph analysis.")
extract_app = typer.Typer(help="Extract intermediate artifacts.")
app.add_typer(extract_app, name="extract")
show_app = typer.Typer(help="Display analysis results.")
app.add_typer(show_app, name="show")


def _check_dependencies() -> None:
    warnings = check_dependencies()
    for msg in warnings:
        print(msg, file=sys.stderr)
        if msg.startswith("Error:"):
            raise typer.Exit(code=1)


@app.callback(invoke_without_command=True)
def _app_callback(ctx: typer.Context) -> None:
    if ctx.invoked_subcommand is not None:
        _check_dependencies()


def _load_and_override(
    repo: Path,
    out: Path,
    config: Path | None,
    provider: str | None = None,
    model: str | None = None,
    dimensions: int | None = None,
    k_sem: int | None = None,
    tau_sem: float | None = None,
    algo: str | None = None,
    resolution: float | None = None,
    suggestions_provider: str | None = None,
    codex_timeout_seconds: int | None = None,
    claude_timeout_seconds: int | None = None,
) -> tuple:
    overrides = RunConfigOverrides(
        provider=provider,
        model=model,
        dimensions=dimensions,
        k_sem=k_sem,
        tau_sem=tau_sem,
        algo=algo,
        resolution=resolution,
        suggestions_provider=suggestions_provider,
        codex_timeout_seconds=codex_timeout_seconds,
        claude_timeout_seconds=claude_timeout_seconds,
    )
    return prepare_config(repo, out, config, overrides)


@app.command()
def init(
    repo: Path = typer.Option(Path("."), exists=True, file_okay=False, resolve_path=True),
    out: Path = typer.Option(Path(".archobs"), resolve_path=True),
    config: Path | None = typer.Option(None, resolve_path=True),
) -> None:
    _, config_path = initialize_workspace(repo, out, config)
    typer.echo(f"Initialized archobs workspace at {out}")
    typer.echo(f"Config: {config_path}")


@extract_app.command("inventory")
def extract_inventory(
    repo: Path = typer.Option(Path("."), exists=True, file_okay=False, resolve_path=True),
    out: Path = typer.Option(Path(".archobs"), resolve_path=True),
    config: Path | None = typer.Option(None, resolve_path=True),
) -> None:
    loaded, _ = _load_and_override(repo, out, config)
    run = AnalysisRun(repo=repo, store=ArtifactStore(out), config=loaded)
    files_df = run.inventory()
    typer.echo(f"Wrote inventory for {len(files_df)} files to {out}")


@extract_app.command("git")
def extract_git(
    repo: Path = typer.Option(Path("."), exists=True, file_okay=False, resolve_path=True),
    out: Path = typer.Option(Path(".archobs"), resolve_path=True),
    config: Path | None = typer.Option(None, resolve_path=True),
) -> None:
    loaded, _ = _load_and_override(repo, out, config)
    run = AnalysisRun(repo=repo, store=ArtifactStore(out), config=loaded)
    git_result = run.git()
    typer.echo(f"Wrote {git_result.commit_file_row_count} commit-file rows to {out}")


@extract_app.command("deps")
def extract_deps(
    repo: Path = typer.Option(Path("."), exists=True, file_okay=False, resolve_path=True),
    out: Path = typer.Option(Path(".archobs"), resolve_path=True),
    config: Path | None = typer.Option(None, resolve_path=True),
) -> None:
    loaded, _ = _load_and_override(repo, out, config)
    run = AnalysisRun(repo=repo, store=ArtifactStore(out), config=loaded)
    deps_result = run.deps()
    typer.echo(
        f"Wrote {deps_result.resolved_import_count} resolved imports and {deps_result.unresolved_import_count} unresolved imports to {out}"
    )


@app.command()
def embed(
    repo: Path = typer.Option(Path("."), exists=True, file_okay=False, resolve_path=True),
    out: Path = typer.Option(Path(".archobs"), resolve_path=True),
    config: Path | None = typer.Option(None, resolve_path=True),
    provider: str = typer.Option("auto"),
    model: str = typer.Option("codanna-semantic-search"),
    dimensions: int = typer.Option(256),
) -> None:
    loaded, _ = _load_and_override(repo, out, config, provider=provider, model=model, dimensions=dimensions)
    run = AnalysisRun(repo=repo, store=ArtifactStore(out), config=loaded)
    embedding_result = run.embed()
    typer.echo(
        f"Wrote {embedding_result.vector_count} embeddings using provider={embedding_result.provider_used}"
    )


@app.command("build-graph")
def build_graph_command(
    repo: Path = typer.Option(Path("."), exists=True, file_okay=False, resolve_path=True),
    out: Path = typer.Option(Path(".archobs"), resolve_path=True),
    config: Path | None = typer.Option(None, resolve_path=True),
    k_sem: int = typer.Option(20),
    tau_sem: float = typer.Option(0.35),
) -> None:
    loaded, _ = _load_and_override(repo, out, config, k_sem=k_sem, tau_sem=tau_sem)
    run = AnalysisRun(repo=repo, store=ArtifactStore(out), config=loaded)
    edge_result = run.build_graph()
    typer.echo(f"Wrote fused graph with {edge_result.edge_count} edges to {out}")


@app.command()
def cluster(
    repo: Path = typer.Option(Path("."), exists=True, file_okay=False, resolve_path=True),
    out: Path = typer.Option(Path(".archobs"), resolve_path=True),
    config: Path | None = typer.Option(None, resolve_path=True),
    algo: str = typer.Option("auto"),
    resolution: float = typer.Option(1.0),
) -> None:
    loaded, _ = _load_and_override(repo, out, config, algo=algo, resolution=resolution)
    run = AnalysisRun(repo=repo, store=ArtifactStore(out), config=loaded)
    cluster_result = run.cluster()
    typer.echo(f"Wrote {cluster_result.cluster_count} clusters using {cluster_result.algorithm_used}")


@app.command()
def report(
    repo: Path = typer.Option(Path("."), exists=True, file_okay=False, resolve_path=True),
    out: Path = typer.Option(Path(".archobs"), resolve_path=True),
    config: Path | None = typer.Option(None, resolve_path=True),
    provider: str = typer.Option("auto"),
    model: str = typer.Option("codanna-semantic-search"),
    dimensions: int = typer.Option(256),
    k_sem: int = typer.Option(20),
    tau_sem: float = typer.Option(0.35),
    algo: str = typer.Option("auto"),
    resolution: float = typer.Option(1.0),
    suggestions_provider: str | None = typer.Option(None),
    codex_timeout_seconds: int | None = typer.Option(None),
    claude_timeout_seconds: int | None = typer.Option(None),
) -> None:
    loaded, _ = _load_and_override(
        repo,
        out,
        config,
        provider=provider,
        model=model,
        dimensions=dimensions,
        k_sem=k_sem,
        tau_sem=tau_sem,
        algo=algo,
        resolution=resolution,
        suggestions_provider=suggestions_provider,
        codex_timeout_seconds=codex_timeout_seconds,
        claude_timeout_seconds=claude_timeout_seconds,
    )
    report_result = run_report(repo, out, loaded)
    summary = report_result.summary
    typer.echo(f"Report: {summary['report_index']}")
    typer.echo(f"Clusters: {summary['cluster_count']}  Edges: {summary['edge_count']}  Embeddings: {summary['embedding_provider']}")


@app.command()
def prompts(
    out: Path = typer.Option(Path(".archobs"), resolve_path=True),
    limit: int = typer.Option(0, help="Max suggestions to emit (0 = all)."),
) -> None:
    blocks, error = load_suggestions(out, limit=limit)
    if not blocks:
        print(f"No prompts to generate: {error}", file=sys.stderr)
        raise typer.Exit(code=0)
    print("\n\n".join(blocks))


# ---------------------------------------------------------------------------
# show subcommands
# ---------------------------------------------------------------------------

def _write_or_print(text: str, out_path: Path | None) -> None:
    if out_path is not None:
        out_path.write_text(text + "\n", encoding="utf-8")
        typer.echo(f"Wrote output to {out_path}")
    else:
        print(text)


@show_app.command("risks")
def show_risks(
    out: Path = typer.Option(Path(".archobs"), resolve_path=True, help="Artifact directory."),
    top: int = typer.Option(15, help="Number of top-risk files to show."),
    min_risk: float | None = typer.Option(None, help="Minimum risk score filter."),
    min_xnbr: float | None = typer.Option(None, help="Minimum xnbr filter."),
    min_hubness: float | None = typer.Option(None, help="Minimum hubness filter."),
    min_volatility: float | None = typer.Option(None, help="Minimum volatility filter."),
    fmt: str = typer.Option("table", "--format", help="Output format: table, json, csv."),
    out_path: Path | None = typer.Option(None, "--out-file", resolve_path=True, help="Write output to file."),
) -> None:
    from archobs.display import format_risks, read_file_metrics

    df = read_file_metrics(out)
    text = format_risks(df, top=top, fmt=fmt, min_risk=min_risk, min_xnbr=min_xnbr, min_hubness=min_hubness, min_volatility=min_volatility)
    _write_or_print(text, out_path)


@show_app.command("clusters")
def show_clusters(
    out: Path = typer.Option(Path(".archobs"), resolve_path=True, help="Artifact directory."),
    sort: str = typer.Option("leakage", help="Sort column: leakage, cohesion, risk_max, size."),
    min_size: int = typer.Option(2, help="Minimum cluster size."),
    fmt: str = typer.Option("table", "--format", help="Output format: table, json, csv."),
    out_path: Path | None = typer.Option(None, "--out-file", resolve_path=True, help="Write output to file."),
) -> None:
    from archobs.display import format_clusters, read_cluster_metrics

    df = read_cluster_metrics(out)
    text = format_clusters(df, sort_by=sort, fmt=fmt, min_size=min_size)
    _write_or_print(text, out_path)


@show_app.command("cluster-files")
def show_cluster_files(
    cluster_id: int = typer.Argument(help="Cluster ID to inspect."),
    out: Path = typer.Option(Path(".archobs"), resolve_path=True, help="Artifact directory."),
    top: int = typer.Option(20, "--top-paths", help="Number of files to show (0 = all)."),
    fmt: str = typer.Option("table", "--format", help="Output format: table, json, csv."),
    out_path: Path | None = typer.Option(None, "--out-file", resolve_path=True, help="Write output to file."),
) -> None:
    """Show files belonging to a specific cluster, sorted by risk."""
    from archobs.display import format_cluster_files, read_file_metrics

    df = read_file_metrics(out)
    text = format_cluster_files(df, cluster_id, top=top, fmt=fmt)
    _write_or_print(text, out_path)


@show_app.command("files")
def show_files(
    out: Path = typer.Option(Path(".archobs"), resolve_path=True, help="Artifact directory."),
    top: int = typer.Option(0, help="Number of top files to show (0 = all)."),
    min_risk: float | None = typer.Option(None, help="Minimum risk score filter."),
    fmt: str = typer.Option("table", "--format", help="Output format: table, json, csv."),
    out_path: Path | None = typer.Option(None, "--out-file", resolve_path=True, help="Write output to file."),
) -> None:
    """Dump all file metrics with cluster assignments."""
    from archobs.display import format_files, read_file_metrics

    df = read_file_metrics(out)
    text = format_files(df, top=top, fmt=fmt, min_risk=min_risk)
    _write_or_print(text, out_path)


@show_app.command("drift")
def show_drift(
    out: Path = typer.Option(Path(".archobs"), resolve_path=True, help="Artifact directory."),
    fmt: str = typer.Option("table", "--format", help="Output format: table, json, csv."),
    out_path: Path | None = typer.Option(None, "--out-file", resolve_path=True, help="Write output to file."),
) -> None:
    from archobs.display import format_drift, read_drift

    # Read configured window count from config if available
    configured_windows: int | None = None
    config_path = out / "config.json"
    if config_path.exists():
        import json as _json
        try:
            cfg = _json.loads(config_path.read_text(encoding="utf-8"))
            configured_windows = cfg.get("clustering", {}).get("drift_window_count")
        except (ValueError, KeyError):
            pass

    df = read_drift(out)
    text = format_drift(df, fmt=fmt, configured_windows=configured_windows)
    _write_or_print(text, out_path)


@show_app.command("velocity")
def show_velocity(
    out: Path = typer.Option(Path(".archobs"), resolve_path=True, help="Artifact directory."),
    window: int = typer.Option(30, help="Window size in days."),
    compare: bool = typer.Option(False, help="Compare current window to prior window."),
    include_added_paths: bool = typer.Option(False, "--include-added-paths", help="Include recently added file paths per cluster (JSON only)."),
    fmt: str = typer.Option("table", "--format", help="Output format: table, json, csv."),
    out_path: Path | None = typer.Option(None, "--out-file", resolve_path=True, help="Write output to file."),
) -> None:
    """Show per-cluster velocity metrics from commit history."""
    from archobs.display import format_velocity, read_cluster_metrics, read_commits, read_file_metrics

    commits_df = read_commits(out)
    file_metrics_df = read_file_metrics(out)
    cluster_metrics_df = read_cluster_metrics(out)
    text = format_velocity(
        commits_df, file_metrics_df, cluster_metrics_df,
        window=window, compare=compare, include_added_paths=include_added_paths, fmt=fmt,
    )
    _write_or_print(text, out_path)


@show_app.command("edges")
def show_edges(
    cluster_id: int = typer.Argument(help="Cluster ID to inspect edges for."),
    out: Path = typer.Option(Path(".archobs"), resolve_path=True, help="Artifact directory."),
    fmt: str = typer.Option("table", "--format", help="Output format: table, json, csv."),
    out_path: Path | None = typer.Option(None, "--out-file", resolve_path=True, help="Write output to file."),
) -> None:
    """Show cross-cluster edge relationships for a given cluster."""
    from archobs.display import format_edges, read_cluster_metrics, read_file_metrics, read_graph_edges

    graph_edges_df = read_graph_edges(out)
    cluster_metrics_df = read_cluster_metrics(out)
    file_metrics_df = read_file_metrics(out)
    text = format_edges(graph_edges_df, cluster_metrics_df, file_metrics_df, cluster_id, fmt=fmt)
    _write_or_print(text, out_path)


@show_app.command("summary")
def show_summary(
    out: Path = typer.Option(Path(".archobs"), resolve_path=True, help="Artifact directory."),
    fmt: str = typer.Option("table", "--format", help="Output format: table, json, csv."),
    out_path: Path | None = typer.Option(None, "--out-file", resolve_path=True, help="Write output to file."),
) -> None:
    from archobs.display import format_summary, read_summary

    data = read_summary(out)
    text = format_summary(data, fmt=fmt)
    _write_or_print(text, out_path)


@show_app.command("all")
def show_all(
    out: Path = typer.Option(Path(".archobs"), resolve_path=True, help="Artifact directory."),
    top: int = typer.Option(0, help="Number of top entries per section (0 = all). Shorthand for --top-risks and --top-clusters."),
    top_risks: int | None = typer.Option(None, "--top-risks", help="Number of top-risk files (overrides --top)."),
    top_clusters: int | None = typer.Option(None, "--top-clusters", help="Number of top clusters (overrides --top)."),
    compact: bool = typer.Option(False, "--compact", help="Agent-friendly compact output: 5 risks, 10 clusters, velocity without added_paths, edges for top-3 clusters only. Target <50KB."),
    fmt: str = typer.Option("table", "--format", help="Output format: table, json, csv."),
    out_path: Path | None = typer.Option(None, "--out-file", resolve_path=True, help="Write output to file."),
) -> None:
    from archobs.display import format_all

    if compact:
        top_risks = top_risks if top_risks is not None else 5
        top_clusters = top_clusters if top_clusters is not None else 10
    text = format_all(out, top=top, top_risks=top_risks, top_clusters=top_clusters, fmt=fmt, compact=compact)
    _write_or_print(text, out_path)


@app.command()
def schema(
    artifact: str = typer.Argument(help="Artifact name (e.g. file_metrics, cluster_metrics, drift)."),
    out: Path = typer.Option(Path(".archobs"), resolve_path=True, help="Artifact directory."),
) -> None:
    """Print column names and types for a parquet artifact."""
    from archobs.display import format_schema

    text = format_schema(out, artifact)
    print(text)


def main() -> None:
    app()
