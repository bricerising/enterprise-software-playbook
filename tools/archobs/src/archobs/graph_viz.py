"""Graph visualization for architecture observability reports.

Extracted from report.py — contains graph construction, layout, focus/pruning,
payload serialization, and HTML rendering for interactive graph views.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
import html
import json
from pathlib import Path

import networkx as nx
import pandas as pd


@dataclass(frozen=True, slots=True)
class ReportGraphSnapshot:
    """Stable graph snapshot prepared by the analysis engine for reporting."""

    nodes_df: pd.DataFrame
    edges_df: pd.DataFrame
    boundary_profiles: tuple[dict[str, object], ...]


# ---------------------------------------------------------------------------
# Local file helpers
# ---------------------------------------------------------------------------


def _ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def _report_dir(base: str | Path) -> Path:
    return _ensure_dir(Path(base) / "report")


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------


def _build_render_graph(nodes_df: pd.DataFrame, edges_df: pd.DataFrame) -> nx.Graph:
    graph = nx.Graph()
    for row in nodes_df.sort_values("path").itertuples(index=False):
        graph.add_node(row.path, **row._asdict())
    for row in edges_df.itertuples(index=False):
        attrs = row._asdict()
        graph.add_edge(
            row.path_a,
            row.path_b,
            **{
                key: float(value) if isinstance(value, (int, float)) and key not in {"cluster_a", "cluster_b"} else value
                for key, value in attrs.items()
                if key not in {"path_a", "path_b"}
            },
        )
    return graph


def _build_attributed_graph(
    nodes_df: pd.DataFrame,
    edges_df: pd.DataFrame,
) -> nx.Graph:
    graph = nx.Graph()
    for row in nodes_df.sort_values("path").itertuples(index=False):
        graph.add_node(row.path, **row._asdict())
    for row in edges_df.itertuples(index=False):
        graph.add_edge(
            row.path_a,
            row.path_b,
            weight=float(row.weight),
            w_sem=float(row.w_sem),
            w_co=float(row.w_co),
            w_dep=float(row.w_dep),
        )
    return graph


# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------


def _stable_positions(graph: nx.Graph) -> dict[str, tuple[float, float]]:
    if graph.number_of_nodes() == 0:
        return {}
    if graph.number_of_nodes() == 1:
        node = next(iter(graph.nodes()))
        return {node: (0.0, 0.0)}
    layout = nx.spring_layout(graph, seed=42, weight="weight", iterations=200)
    return {node: (float(coords[0]) * 1200.0, float(coords[1]) * 1200.0) for node, coords in layout.items()}


def _fit_positions(positions: dict[str, tuple[float, float]], width: int = 1400, height: int = 900, margin: int = 80) -> dict[str, tuple[float, float]]:
    if not positions:
        return {}
    xs = [point[0] for point in positions.values()]
    ys = [point[1] for point in positions.values()]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    span_x = max(max_x - min_x, 1.0)
    span_y = max(max_y - min_y, 1.0)
    usable_w = max(1, width - (2 * margin))
    usable_h = max(1, height - (2 * margin))
    fitted = {}
    for node, (x_pos, y_pos) in positions.items():
        norm_x = margin + ((x_pos - min_x) / span_x) * usable_w
        norm_y = margin + ((y_pos - min_y) / span_y) * usable_h
        fitted[node] = (float(norm_x), float(norm_y))
    return fitted


# ---------------------------------------------------------------------------
# Focus / pruning
# ---------------------------------------------------------------------------


def _edge_priority(graph: nx.Graph, left: str, right: str) -> float:
    attrs = graph[left][right]
    return float(attrs.get("weight", 0.0)) + 0.10 * float(graph.nodes[left].get("risk", 0.0)) + 0.10 * float(graph.nodes[right].get("risk", 0.0))


def _focus_graph(graph: nx.Graph, max_nodes: int = 120, max_edges: int = 220, per_node_edge_limit: int = 4) -> tuple[nx.Graph, dict[str, int]]:
    meta = {
        "full_nodes": graph.number_of_nodes(),
        "full_edges": graph.number_of_edges(),
        "hidden_isolates": sum(1 for _, degree in graph.degree() if degree == 0),
    }
    if graph.number_of_edges() == 0:
        meta.update({"shown_nodes": graph.number_of_nodes(), "shown_edges": 0, "hidden_nodes": 0, "hidden_edges": 0})
        return graph.copy(), meta

    retained_pairs: set[tuple[str, str]] = set()
    top_risk_nodes = sorted(graph.nodes(), key=lambda node: (-float(graph.nodes[node].get("risk", 0.0)), node))[:20]

    for node in graph.nodes():
        incident = sorted(graph.edges(node), key=lambda edge: _edge_priority(graph, edge[0], edge[1]), reverse=True)
        for left, right in incident[:per_node_edge_limit]:
            retained_pairs.add(tuple(sorted((left, right))))

    for node in top_risk_nodes:
        incident = sorted(graph.edges(node), key=lambda edge: _edge_priority(graph, edge[0], edge[1]), reverse=True)
        for left, right in incident[:2]:
            retained_pairs.add(tuple(sorted((left, right))))

    ranked_pairs = sorted(retained_pairs, key=lambda pair: _edge_priority(graph, pair[0], pair[1]), reverse=True)
    selected_pairs = ranked_pairs[:max_edges]

    focused = nx.Graph()
    for left, right in selected_pairs:
        focused.add_node(left, **graph.nodes[left])
        focused.add_node(right, **graph.nodes[right])
        focused.add_edge(left, right, **graph[left][right])

    if focused.number_of_nodes() > max_nodes:
        node_rank = sorted(
            focused.nodes(),
            key=lambda node: (
                -float(focused.nodes[node].get("risk", 0.0)),
                -float(focused.degree(node, weight="weight")),
                node,
            ),
        )
        keep_nodes = set(node_rank[:max_nodes])
        focused = focused.subgraph(keep_nodes).copy()
        focused.remove_nodes_from([node for node, degree in focused.degree() if degree == 0])

    if focused.number_of_edges() == 0 and selected_pairs:
        left, right = selected_pairs[0]
        focused.add_node(left, **graph.nodes[left])
        focused.add_node(right, **graph.nodes[right])
        focused.add_edge(left, right, **graph[left][right])

    meta.update(
        {
            "shown_nodes": focused.number_of_nodes(),
            "shown_edges": focused.number_of_edges(),
            "hidden_nodes": max(0, graph.number_of_nodes() - focused.number_of_nodes()),
            "hidden_edges": max(0, graph.number_of_edges() - focused.number_of_edges()),
        }
    )
    return focused, meta


# ---------------------------------------------------------------------------
# Payload serialization
# ---------------------------------------------------------------------------


def _graph_banner(meta: dict[str, int]) -> str:
    return f"""
    <div style="font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif; background: rgba(255,251,235,0.96); color: #1f2937; border-bottom: 1px solid rgba(209,213,219,0.9); padding: 16px 20px;">
      <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #9a3412; font-weight: 700; margin-bottom: 6px;">Focused Graph View</div>
      <div style="font-size: 18px; font-weight: 700; margin-bottom: 8px;">Showing {meta['shown_nodes']} of {meta['full_nodes']} files and {meta['shown_edges']} of {meta['full_edges']} edges.</div>
      <div style="font-size: 14px; line-height: 1.5; color: #4b5563;">
        Hidden by default: {meta['hidden_nodes']} low-signal files, {meta['hidden_edges']} weaker edges, and {meta['hidden_isolates']} isolated files.
        Use GraphML or GEXF if you need the full graph; use this view to inspect the strongest relationships first.
      </div>
    </div>
    """


def _cluster_color(cluster_id: int) -> str:
    palette = [
        "#0f766e",
        "#c2410c",
        "#7c3aed",
        "#2563eb",
        "#15803d",
        "#be123c",
        "#b45309",
        "#4338ca",
        "#0f766e",
        "#a21caf",
    ]
    if cluster_id < 0:
        return "#6b7280"
    return palette[cluster_id % len(palette)]


def _graph_payload(graph: nx.Graph, positions: dict[str, tuple[float, float]]) -> dict[str, object]:
    width = 1400
    height = 900
    max_degree = max((float(graph.degree(node, weight="weight")) for node in graph.nodes()), default=1.0)
    nodes = []
    edges = []
    for node, attrs in sorted(graph.nodes(data=True)):
        degree_weight = float(graph.degree(node, weight="weight"))
        risk = float(attrs.get("risk", 0.0))
        xnbr = float(attrs.get("xnbr", 0.0))
        hubness = float(attrs.get("hubness", 0.0))
        volatility = float(attrs.get("volatility", 0.0))
        x_pos, y_pos = positions.get(node, (width / 2, height / 2))
        nodes.append(
            {
                "id": node,
                "label": Path(node).name,
                "path": node,
                "cluster": int(attrs.get("cluster_id", -1)),
                "risk": round(risk, 3),
                "xnbr": round(xnbr, 3),
                "hubness": round(hubness, 3),
                "volatility": round(volatility, 3),
                "degree": round(degree_weight, 3),
                "x": round(x_pos, 2),
                "y": round(y_pos, 2),
                "size": round(7.0 + (18.0 * risk) + (16.0 * (degree_weight / max_degree if max_degree else 0.0)), 2),
                "color": _cluster_color(int(attrs.get("cluster_id", -1))),
            }
        )

    for left, right, attrs in sorted(graph.edges(data=True), key=lambda item: float(item[2].get("weight", 0.0)), reverse=True):
        weight = float(attrs.get("weight", 0.0))
        edges.append(
            {
                "source": left,
                "target": right,
                "weight": round(weight, 3),
                "w_sem": round(float(attrs.get("w_sem", 0.0)), 3),
                "w_co": round(float(attrs.get("w_co", 0.0)), 3),
                "w_dep": round(float(attrs.get("w_dep", 0.0)), 3),
                "stroke_width": round(max(1.3, 2.0 + (10.0 * weight)), 2),
                "opacity": round(min(0.85, 0.20 + (0.90 * weight)), 3),
            }
        )

    return {"width": width, "height": height, "nodes": nodes, "edges": edges}


def _cluster_payload(graph: nx.Graph) -> list[dict[str, object]]:
    grouped: dict[int, list[dict[str, object]]] = defaultdict(list)
    for node, attrs in sorted(graph.nodes(data=True)):
        grouped[int(attrs.get("cluster_id", -1))].append(
            {
                "id": node,
                "path": node,
                "label": Path(node).name,
                "risk": round(float(attrs.get("risk", 0.0)), 3),
                "xnbr": round(float(attrs.get("xnbr", 0.0)), 3),
            }
        )

    clusters = []
    for cluster_id, files in grouped.items():
        ranked_files = sorted(files, key=lambda item: (-float(item["risk"]), item["path"]))
        risk_values = [float(item["risk"]) for item in ranked_files]
        clusters.append(
            {
                "id": cluster_id,
                "label": f"Cluster {cluster_id}" if cluster_id >= 0 else "Unclustered",
                "file_count": len(ranked_files),
                "risk_max": round(max(risk_values, default=0.0), 3),
                "risk_mean": round(sum(risk_values) / len(risk_values), 3) if risk_values else 0.0,
                "files": ranked_files,
            }
        )

    return sorted(clusters, key=lambda item: (-int(item["file_count"]), -float(item["risk_max"]), int(item["id"])))


# ---------------------------------------------------------------------------
# Graph export
# ---------------------------------------------------------------------------


def export_graph(
    graph_snapshot: ReportGraphSnapshot,
    out_dir: str | Path,
) -> tuple[Path, Path]:
    report_root = _report_dir(out_dir)
    graph = _build_render_graph(graph_snapshot.nodes_df, graph_snapshot.edges_df)

    graphml_path = report_root / "graph.graphml"
    gexf_path = report_root / "graph.gexf"
    nx.write_graphml(graph, graphml_path)
    nx.write_gexf(graph, gexf_path)
    return graphml_path, gexf_path


def write_graph_html(
    graph_snapshot: ReportGraphSnapshot,
    out_dir: str | Path,
) -> Path:
    report_root = _report_dir(out_dir)
    target = report_root / "graph.html"
    full_graph = _build_attributed_graph(graph_snapshot.nodes_df, graph_snapshot.edges_df)
    focused_graph, meta = _focus_graph(full_graph)
    positions = _fit_positions(_stable_positions(focused_graph))
    payload = _graph_payload(focused_graph, positions)
    payload["clusters"] = _cluster_payload(focused_graph)
    node_options = "\n".join(
        f'<option value="{html.escape(node["id"])}">{html.escape(node["path"])}</option>'
        for node in payload["nodes"]
    )
    cluster_options = "\n".join(
        f'<option value="{cluster["id"]}">{html.escape(cluster["label"])} · {cluster["file_count"]} files</option>'
        for cluster in payload["clusters"]
    )
    payload_json = json.dumps(payload, separators=(",", ":"))
    html_text = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>archobs graph</title>
  <style>
    :root {{
      --bg: #f5f4ef;
      --panel: rgba(255,255,255,0.92);
      --line: rgba(209,213,219,0.95);
      --ink: #1f2937;
      --muted: #6b7280;
      --accent: #9a3412;
      --edge: rgba(107,114,128,0.32);
      --edge-strong: rgba(154,52,18,0.72);
    }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; background: linear-gradient(180deg, #f8f6f1 0%, #efe8dc 100%); color: var(--ink); font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif; }}
    .shell {{ max-width: 1500px; margin: 0 auto; padding-bottom: 24px; }}
    .toolbar {{ display: grid; grid-template-columns: minmax(0, 1fr) 260px auto auto; gap: 12px; align-items: center; padding: 16px 20px; background: var(--panel); border-bottom: 1px solid var(--line); }}
    .toolbar input, .toolbar select {{ width: 100%; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line); font-size: 14px; background: white; color: var(--ink); }}
    .toolbar button {{ padding: 12px 14px; border-radius: 12px; border: 1px solid rgba(154,52,18,0.25); background: white; color: var(--accent); font-weight: 600; cursor: pointer; }}
    .layout {{ display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; padding: 16px 20px 0; }}
    .panel {{ background: var(--panel); border: 1px solid var(--line); border-radius: 20px; overflow: hidden; box-shadow: 0 10px 24px rgba(0,0,0,0.05); }}
    .graph-wrap {{ padding: 12px; }}
    svg {{ width: 100%; height: auto; display: block; background: radial-gradient(circle at center, rgba(255,255,255,0.98), rgba(244,240,232,0.95)); border-radius: 16px; border: 1px solid rgba(209,213,219,0.8); }}
    .edge {{ stroke: var(--edge); stroke-linecap: round; }}
    .edge.active {{ stroke: var(--edge-strong); }}
    .node circle {{ stroke: rgba(31,41,55,0.18); stroke-width: 1.2; }}
    .node text {{ font-size: 12px; fill: #111827; font-family: Menlo, monospace; paint-order: stroke; stroke: rgba(255,255,255,0.95); stroke-width: 4px; stroke-linejoin: round; pointer-events: none; }}
    .node.dimmed {{ opacity: 0.18; }}
    .edge.dimmed {{ opacity: 0.05 !important; }}
    .node.active circle {{ stroke: #111827; stroke-width: 2.5; }}
    .sidebar {{ padding: 18px; }}
    .sidebar h2 {{ margin: 0 0 8px; font-size: 18px; }}
    .sidebar p {{ margin: 0 0 16px; color: var(--muted); line-height: 1.5; }}
    .meta {{ display: grid; gap: 10px; margin-bottom: 18px; }}
    .meta-card {{ padding: 12px; border-radius: 14px; background: rgba(250,249,245,0.95); border: 1px solid var(--line); }}
    .meta-card .label {{ font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 4px; }}
    .meta-card .value {{ font-size: 18px; font-weight: 700; color: var(--accent); }}
    .details {{ padding: 14px; border-radius: 14px; background: rgba(255,255,255,0.98); border: 1px solid var(--line); }}
    .details dl {{ margin: 0; display: grid; grid-template-columns: 90px 1fr; gap: 10px 12px; }}
    .details dt {{ color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }}
    .details dd {{ margin: 0; font-size: 14px; word-break: break-word; }}
    .cluster-card {{ margin-top: 14px; padding: 14px; border-radius: 14px; background: rgba(255,255,255,0.98); border: 1px solid var(--line); }}
    .cluster-card h3 {{ margin: 0 0 8px; font-size: 15px; }}
    .cluster-card .summary {{ display: grid; gap: 6px; margin-bottom: 12px; color: var(--muted); font-size: 13px; }}
    .cluster-files {{ list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; max-height: 320px; overflow: auto; }}
    .cluster-files li {{ display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 8px 10px; border-radius: 10px; background: rgba(250,249,245,0.95); border: 1px solid rgba(209,213,219,0.65); }}
    .cluster-files code {{ font-size: 12px; white-space: normal; overflow-wrap: anywhere; }}
    .pill {{ font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent); background: rgba(154,52,18,0.10); border-radius: 999px; padding: 4px 8px; }}
    .quiet {{ color: var(--muted); font-size: 13px; line-height: 1.5; }}
    .legend {{ display: grid; gap: 8px; margin-top: 16px; }}
    .legend-item {{ display: flex; gap: 10px; align-items: center; font-size: 13px; color: var(--muted); }}
    .swatch {{ width: 12px; height: 12px; border-radius: 999px; display: inline-block; }}
    @media (max-width: 1100px) {{
      .layout {{ grid-template-columns: 1fr; }}
      .toolbar {{ grid-template-columns: 1fr; }}
    }}
  </style>
</head>
<body>
  {_graph_banner(meta)}
  <div class="shell">
    <div class="toolbar panel">
      <input id="node-search" list="node-list" placeholder="Find a file in the focused graph..." />
      <select id="cluster-select" aria-label="Jump to cluster">
        <option value="">Jump to cluster...</option>
        {cluster_options}
      </select>
      <button id="reset-btn" type="button">Reset</button>
      <button id="fit-btn" type="button">Show All</button>
      <datalist id="node-list">
        {node_options}
      </datalist>
    </div>
    <div class="layout">
      <section class="panel graph-wrap">
        <svg id="graph" viewBox="0 0 {payload['width']} {payload['height']}" aria-label="Architecture graph"></svg>
      </section>
      <aside class="panel sidebar">
        <h2>Focused Graph</h2>
        <p>This view hides weaker edges and low-signal nodes so you can inspect the strongest structural relationships first.</p>
        <div class="meta">
          <div class="meta-card"><div class="label">Visible Files</div><div class="value">{meta['shown_nodes']}</div></div>
          <div class="meta-card"><div class="label">Visible Edges</div><div class="value">{meta['shown_edges']}</div></div>
          <div class="meta-card"><div class="label">Hidden Edges</div><div class="value">{meta['hidden_edges']}</div></div>
        </div>
        <div class="details" id="details">
          <p>Select a node to inspect its risk and strongest connections.</p>
        </div>
        <div class="cluster-card" id="cluster-details">
          <h3>Cluster Files</h3>
          <p class="quiet">Jump to a cluster to zoom the graph and list the files in that cluster.</p>
        </div>
        <div class="legend">
          <div class="legend-item"><span class="swatch" style="background:#9a3412;"></span> Selected node and edges</div>
          <div class="legend-item"><span class="swatch" style="background:#6b7280;"></span> Default edge visibility</div>
          <div class="legend-item"><span class="swatch" style="background:#111827;"></span> Node border strength tracks boundary pressure</div>
        </div>
      </aside>
    </div>
  </div>
  <script>
    const payload = {payload_json};
    const svg = document.getElementById("graph");
    const details = document.getElementById("details");
    const clusterDetails = document.getElementById("cluster-details");
    const clusterSelect = document.getElementById("cluster-select");
    const search = document.getElementById("node-search");
    const edgeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const nodeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.appendChild(edgeLayer);
    svg.appendChild(nodeLayer);

    const nodeById = new Map(payload.nodes.map(node => [node.id, node]));
    const clusterById = new Map((payload.clusters || []).map(cluster => [String(cluster.id), cluster]));
    const adjacency = new Map();
    payload.nodes.forEach(node => adjacency.set(node.id, new Set()));
    payload.edges.forEach(edge => {{
      adjacency.get(edge.source)?.add(edge.target);
      adjacency.get(edge.target)?.add(edge.source);
    }});

    const edgeElements = [];
    payload.edges.forEach(edge => {{
      const source = payload.nodes.find(node => node.id === edge.source);
      const target = payload.nodes.find(node => node.id === edge.target);
      if (!source || !target) return;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", source.x);
      line.setAttribute("y1", source.y);
      line.setAttribute("x2", target.x);
      line.setAttribute("y2", target.y);
      line.setAttribute("stroke-width", edge.stroke_width);
      line.setAttribute("stroke-opacity", edge.opacity);
      line.setAttribute("class", "edge");
      line.dataset.source = edge.source;
      line.dataset.target = edge.target;
      line.innerHTML = `<title>${{edge.source}} ↔ ${{edge.target}}\\nweight=${{edge.weight}}\\nsemantic=${{edge.w_sem}} cochange=${{edge.w_co}} dependency=${{edge.w_dep}}</title>`;
      edgeLayer.appendChild(line);
      edgeElements.push(line);
    }});

    const nodeElements = new Map();
    payload.nodes.forEach(node => {{
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.setAttribute("transform", `translate(${{node.x}},${{node.y}})`);
      group.setAttribute("class", "node");
      group.dataset.id = node.id;

      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("r", node.size);
      circle.setAttribute("fill", node.color);
      circle.setAttribute("fill-opacity", String(Math.min(0.95, 0.45 + node.risk)));
      circle.setAttribute("stroke-width", String(1.2 + (4.5 * node.xnbr)));
      group.appendChild(circle);

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", node.size + 6);
      label.setAttribute("y", "4");
      label.textContent = node.label;
      label.dataset.alwaysVisible = node.size >= 15 ? "true" : "false";
      label.style.display = node.size >= 15 ? "block" : "none";
      group.appendChild(label);

      group.addEventListener("click", () => selectNode(node.id));
      group.addEventListener("mouseenter", () => hoverNode(node.id));
      group.addEventListener("mouseleave", () => hoverNode(null));
      nodeLayer.appendChild(group);
      nodeElements.set(node.id, group);
    }});

    let selectedNode = null;
    let hoveredNode = null;
    let selectedCluster = null;

    function escapeHtml(value) {{
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }}

    function fitViewBox(x, y, width, height) {{
      svg.setAttribute("viewBox", `${{x}} ${{y}} ${{width}} ${{height}}`);
    }}

    function fitAll() {{
      fitViewBox(0, 0, payload.width, payload.height);
    }}

    function clusterBounds(clusterId) {{
      const nodes = payload.nodes.filter(node => node.cluster === clusterId);
      if (!nodes.length) return null;
      const padding = Math.max(60, ...nodes.map(node => node.size + 24));
      const xs = nodes.map(node => node.x);
      const ys = nodes.map(node => node.y);
      const minX = Math.max(0, Math.min(...xs) - padding);
      const maxX = Math.min(payload.width, Math.max(...xs) + padding);
      const minY = Math.max(0, Math.min(...ys) - padding);
      const maxY = Math.min(payload.height, Math.max(...ys) + padding);
      const width = Math.max(180, maxX - minX);
      const height = Math.max(180, maxY - minY);
      return {{ x: minX, y: minY, width, height }};
    }}

    function setDetails(node) {{
      if (!node) {{
        details.innerHTML = "<p>Select a node to inspect its risk and strongest connections.</p>";
        return;
      }}
      const neighbors = Array.from(adjacency.get(node.id) || []).sort();
      details.innerHTML = `
        <dl>
          <dt>Path</dt><dd>${{node.path}}</dd>
          <dt>Cluster</dt><dd>${{node.cluster}}</dd>
          <dt>Risk</dt><dd>${{node.risk}}</dd>
          <dt>xnbr</dt><dd>${{node.xnbr}}</dd>
          <dt>Hubness</dt><dd>${{node.hubness}}</dd>
          <dt>Volatility</dt><dd>${{node.volatility}}</dd>
          <dt>Neighbors</dt><dd>${{neighbors.slice(0, 8).join("<br>") || "None"}}</dd>
        </dl>
      `;
    }}

    function setClusterDetails(clusterId) {{
      if (clusterId === null || !clusterById.has(String(clusterId))) {{
        clusterDetails.innerHTML = `
          <h3>Cluster Files</h3>
          <p class="quiet">Jump to a cluster to zoom the graph and list the files in that cluster.</p>
        `;
        return;
      }}
      const cluster = clusterById.get(String(clusterId));
      const filesHtml = cluster.files
        .map(file => `<li><code>${{escapeHtml(file.path)}}</code><span class="pill">risk ${{file.risk}}</span></li>`)
        .join("");
      clusterDetails.innerHTML = `
        <h3>${{escapeHtml(cluster.label)}}</h3>
        <div class="summary">
          <div>${{cluster.file_count}} visible files in the focused graph</div>
          <div>Max risk ${{cluster.risk_max}} · Mean risk ${{cluster.risk_mean}}</div>
        </div>
        <ul class="cluster-files">${{filesHtml || "<li><span class='quiet'>No files visible in this cluster.</span></li>"}}</ul>
      `;
    }}

    function selectCluster(clusterId, shouldFit = true) {{
      selectedCluster = clusterId === null || clusterId === "" ? null : Number(clusterId);
      clusterSelect.value = selectedCluster === null ? "" : String(selectedCluster);
      setClusterDetails(selectedCluster);
      if (selectedCluster === null) {{
        fitAll();
      }} else if (shouldFit) {{
        const bounds = clusterBounds(selectedCluster);
        if (bounds) {{
          fitViewBox(bounds.x, bounds.y, bounds.width, bounds.height);
        }}
      }}
      applyState(selectedNode || hoveredNode);
    }}

    function applyState(activeId) {{
      const neighborhood = activeId ? new Set([activeId, ...(adjacency.get(activeId) || [])]) : null;
      nodeElements.forEach((element, nodeId) => {{
        const node = nodeById.get(nodeId);
        const outOfCluster = selectedCluster !== null && node && node.cluster !== selectedCluster;
        const outOfNeighborhood = !!neighborhood && !neighborhood.has(nodeId);
        element.classList.toggle("active", activeId === nodeId);
        element.classList.toggle("dimmed", outOfCluster || outOfNeighborhood);
        const label = element.querySelector("text");
        if (label) {{
          const alwaysVisible = label.dataset.alwaysVisible === "true";
          const highlightCluster = selectedCluster !== null && node && node.cluster === selectedCluster;
          const highlightNode = !!neighborhood && neighborhood.has(nodeId);
          label.style.display = alwaysVisible || highlightCluster || highlightNode ? "block" : "none";
        }}
      }});
      edgeElements.forEach(edge => {{
        const source = nodeById.get(edge.dataset.source);
        const target = nodeById.get(edge.dataset.target);
        const linked = activeId && (edge.dataset.source === activeId || edge.dataset.target === activeId);
        const insideCluster = selectedCluster === null || (source && target && source.cluster === selectedCluster && target.cluster === selectedCluster);
        edge.classList.toggle("active", !!linked || (!activeId && selectedCluster !== null && insideCluster));
        edge.classList.toggle("dimmed", !insideCluster || (!!neighborhood && !linked));
      }});
    }}

    function getNode(nodeId) {{
      return nodeById.get(nodeId) || null;
    }}

    function selectNode(nodeId) {{
      selectedNode = nodeId || null;
      search.value = nodeId || "";
      const node = getNode(selectedNode);
      if (node) {{
        selectCluster(node.cluster);
      }}
      applyState(selectedNode || hoveredNode);
      setDetails(node);
    }}

    function hoverNode(nodeId) {{
      hoveredNode = nodeId;
      if (!selectedNode) {{
        applyState(hoveredNode);
        setDetails(getNode(hoveredNode));
      }}
    }}

    search.addEventListener("change", event => {{
      selectNode(event.target.value || null);
    }});
    clusterSelect.addEventListener("change", event => {{
      selectedNode = null;
      hoveredNode = null;
      search.value = "";
      selectCluster(event.target.value || null);
      setDetails(null);
    }});
    document.getElementById("reset-btn").addEventListener("click", () => {{
      selectedNode = null;
      hoveredNode = null;
      selectedCluster = null;
      search.value = "";
      clusterSelect.value = "";
      applyState(null);
      setDetails(null);
      setClusterDetails(null);
      fitAll();
    }});
    document.getElementById("fit-btn").addEventListener("click", () => {{
      fitAll();
    }});

    applyState(null);
    setDetails(null);
    setClusterDetails(null);
  </script>
</body>
</html>
"""
    target.write_text(html_text, encoding="utf-8")
    return target


# ---------------------------------------------------------------------------
# Graph snapshot builder (moved from _analysis_engine.py)
# ---------------------------------------------------------------------------


def _report_snapshot_cluster_paths(file_metrics_df: pd.DataFrame, cluster_id: int, limit: int = 4) -> list[str]:
    if file_metrics_df.empty or "cluster_id" not in file_metrics_df:
        return []
    scoped = file_metrics_df[file_metrics_df["cluster_id"] == cluster_id].sort_values(
        ["risk", "xnbr", "hubness"],
        ascending=[False, False, False],
    )
    return [str(path) for path in scoped["path"].head(limit).tolist()]


def _report_snapshot_path_domain(path: str) -> str:
    parts = list(Path(path).parts)
    if len(parts) <= 1:
        return path
    if parts[0] in {"src", "packages"}:
        dirs = parts[:-1]
        return "/".join(dirs[: min(len(dirs), 4)])
    return "/".join(parts[:-1][:3]) or path


def _report_snapshot_boundary_label(paths: list[str]) -> str:
    if not paths:
        return "the referenced files"
    ranked: dict[str, int] = defaultdict(int)
    for path in paths:
        ranked[_report_snapshot_path_domain(path)] += 1
    ordered = sorted(ranked.items(), key=lambda item: (-item[1], item[0]))
    return " + ".join(label for label, _ in ordered[:2])


def _build_boundary_profiles(
    cluster_metrics_df: pd.DataFrame,
    file_metrics_df: pd.DataFrame,
    graph_edges_df: pd.DataFrame,
    *,
    cluster_limit: int = 5,
    neighbor_limit: int = 3,
    example_limit: int = 3,
) -> tuple[dict[str, object], ...]:
    if graph_edges_df.empty or cluster_metrics_df.empty:
        return ()

    boundary_weights: dict[tuple[int, int], float] = defaultdict(float)
    boundary_examples: dict[tuple[int, int], list[dict[str, object]]] = defaultdict(list)

    for row in graph_edges_df.itertuples(index=False):
        left_cluster = int(getattr(row, "cluster_a", -1))
        right_cluster = int(getattr(row, "cluster_b", -1))
        if left_cluster == right_cluster:
            continue
        weight = float(getattr(row, "weight", 0.0))
        for source_cluster, target_cluster, source_path, target_path in (
            (left_cluster, right_cluster, str(row.path_a), str(row.path_b)),
            (right_cluster, left_cluster, str(row.path_b), str(row.path_a)),
        ):
            key = (source_cluster, target_cluster)
            boundary_weights[key] += weight
            if len(boundary_examples[key]) < example_limit:
                boundary_examples[key].append(
                    {
                        "source_path": source_path,
                        "target_path": target_path,
                        "weight": round(weight, 3),
                    }
                )

    profiles: list[dict[str, object]] = []
    top_cluster_ids = [
        int(cluster_id)
        for cluster_id in cluster_metrics_df.sort_values("leakage", ascending=False)["cluster_id"].head(cluster_limit).tolist()
    ]
    for cluster_id in top_cluster_ids:
        cluster_paths = _report_snapshot_cluster_paths(file_metrics_df, cluster_id)
        ranked_neighbors = [
            (neighbor_id, total_weight)
            for (source_cluster, neighbor_id), total_weight in boundary_weights.items()
            if source_cluster == cluster_id
        ]
        ranked_neighbors.sort(key=lambda item: (-item[1], item[0]))

        neighbors: list[dict[str, object]] = []
        for neighbor_id, total_weight in ranked_neighbors[:neighbor_limit]:
            neighbor_paths = _report_snapshot_cluster_paths(file_metrics_df, neighbor_id)
            neighbors.append(
                {
                    "cluster_id": int(neighbor_id),
                    "label": _report_snapshot_boundary_label(neighbor_paths),
                    "weight": round(float(total_weight), 3),
                    "paths": neighbor_paths,
                    "examples": boundary_examples[(cluster_id, neighbor_id)],
                }
            )

        if neighbors:
            profiles.append(
                {
                    "cluster_id": cluster_id,
                    "label": _report_snapshot_boundary_label(cluster_paths),
                    "paths": cluster_paths,
                    "neighbors": neighbors,
                }
            )

    return tuple(profiles)


def build_report_graph_snapshot(
    files_df: pd.DataFrame,
    fused_df: pd.DataFrame,
    clusters_df: pd.DataFrame,
    file_metrics_df: pd.DataFrame,
    cluster_metrics_df: pd.DataFrame,
) -> ReportGraphSnapshot:
    """Project raw graph/clustering data into the stable reporting snapshot."""
    cluster_map = dict(zip(clusters_df["path"], clusters_df["cluster_id"], strict=True)) if not clusters_df.empty else {}
    metric_columns = [column for column in file_metrics_df.columns if column != "cluster_id"]
    if metric_columns:
        nodes_df = files_df.merge(file_metrics_df[metric_columns], on="path", how="left")
    else:
        nodes_df = files_df.copy()
    nodes_df = nodes_df.sort_values("path").reset_index(drop=True)
    nodes_df["cluster_id"] = nodes_df["path"].map(cluster_map).fillna(-1).astype(int)
    for column in ("risk", "xnbr", "hubness", "volatility"):
        if column not in nodes_df:
            nodes_df[column] = 0.0
        nodes_df[column] = nodes_df[column].fillna(0.0).astype(float)

    edges_df = fused_df.sort_values(["path_a", "path_b"]).reset_index(drop=True).copy()
    if edges_df.empty:
        boundary_profiles: tuple[dict[str, object], ...] = ()
    else:
        edges_df["cluster_a"] = edges_df["path_a"].map(cluster_map).fillna(-1).astype(int)
        edges_df["cluster_b"] = edges_df["path_b"].map(cluster_map).fillna(-1).astype(int)
        boundary_profiles = _build_boundary_profiles(cluster_metrics_df, file_metrics_df, edges_df)

    return ReportGraphSnapshot(
        nodes_df=nodes_df,
        edges_df=edges_df,
        boundary_profiles=boundary_profiles,
    )
