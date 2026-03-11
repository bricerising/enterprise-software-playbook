# archobs

`archobs` analyzes a Git repository and tells you where your architecture is healthy and where it's not. It builds a graph of file relationships from three signals -- git co-change history, import/dependency edges, and semantic similarity -- then clusters files into subsystems and scores each one for boundary health, risk hotspots, and drift over time.

The output is an HTML report you open in a browser.

> **Part of [enterprise-software-playbook](../../README.md).**
> This tool is the implementation behind the [`archobs` skill](../../skills/archobs/SKILL.md).
> For metric interpretation, see [`interpreting-metrics.md`](../../skills/archobs/references/interpreting-metrics.md).
> For operational guidance, see [`running-archobs.md`](../../skills/archobs/references/running-archobs.md).

## What it actually measures

- **Clusters**: Groups of files that belong together based on how they change together, import each other, and are semantically related. Think of these as the subsystems your codebase _actually_ has (vs. what your folder structure implies).
- **Boundary health**: How well each cluster stays self-contained. Metrics include cohesion (internal connectivity), leakage (cross-boundary edges), and conductance.
- **Risk hotspots**: Files ranked by a combination of boundary leakage, hubness (how many clusters a file bridges), and volatility (how often it changes).
- **Drift**: How clusters are shifting over time -- are subsystem boundaries getting cleaner or messier?
- **Suggestions**: Actionable recommendations to improve architecture (rule-based by default, optionally LLM-powered via Codex or Claude).

## Supported languages

Python, TypeScript, JavaScript (including `.tsx`, `.jsx`, `.mjs`, `.cjs`), and Java.

## Requirements

- Python 3.11+
- A Git repository with some history
- [Codanna](https://codanna.dev) — a CLI that generates semantic search embeddings for file similarity. Maintained by [@bricerising](https://github.com/bricerising).

## Install

Install Codanna, then install archobs from the playbook repo root:

```bash
# macOS
brew install codanna

# Linux / other
curl -fsSL --proto '=https' --tlsv1.2 https://install.codanna.sh | sh
```

```bash
pip install -e 'tools/archobs[full]'
```

This installs the core dependencies (NetworkX, NumPy, Pandas, PyArrow, Typer).

This adds Leiden community detection (`python-igraph` + `leidenalg`), interactive HTML graph rendering (`pyvis`), and Tree-sitter parsing.

## Usage

### 1. Initialize a workspace

```bash
archobs init --repo /path/to/your/repo --out .archobs
```

This creates a `.archobs/` directory with a `config.json` you can tweak. If you omit `--repo`, it defaults to the current directory.

### 2. Run the full analysis

```bash
archobs report --repo /path/to/your/repo --out .archobs
```

This runs the complete pipeline:

1. Inventories tracked source files
2. Extracts git co-change history
3. Parses imports and dependencies
4. Generates embeddings (for semantic similarity)
5. Builds and fuses a file-relationship graph
6. Clusters files into subsystems
7. Computes boundary health metrics and risk scores
8. Writes an HTML report to `.archobs/report/index.html`

Open the report in your browser:

```bash
open .archobs/report/index.html
```

### Run individual stages

You can run each stage separately if you want to inspect intermediate artifacts:

```bash
archobs extract inventory --repo .    # file list
archobs extract git --repo .          # co-change history
archobs extract deps --repo .         # import/dependency edges
archobs embed --repo .                # semantic embeddings
archobs build-graph --repo .          # fused graph
archobs cluster --repo .              # subsystem clustering
```

Each stage writes Parquet files to `.archobs/artifacts/` that downstream stages consume.

## Key options

| Flag | Default | What it does |
|---|---|---|
| `--provider` | `auto` | Embedding provider. `auto` uses Codanna if available, otherwise deterministic local hashing. |
| `--algo` | `auto` | Clustering algorithm. `auto` uses Leiden if installed, otherwise NetworkX greedy modularity. |
| `--resolution` | `1.0` | Clustering resolution. Higher values produce more, smaller clusters. |
| `--k-sem` | `20` | Number of semantic nearest neighbors per file. |
| `--tau-sem` | `0.35` | Minimum similarity threshold for semantic edges. |
| `--suggestions-provider` | `auto` | How to generate suggestions: `auto` (tries Claude, then Codex, then local rules), `claude`, `codex`, `rules`, or `off`. |

## Output files

After running `archobs report`, the `.archobs/` directory contains:

```
.archobs/
  config.json                 # your configuration
  artifacts/
    files.parquet             # file inventory
    commits.parquet           # git co-change data
    imports.parquet           # resolved import edges
    graph_edges.parquet       # fused relationship graph
    clusters.parquet          # cluster assignments
    file_metrics.parquet      # per-file risk scores
    cluster_metrics.parquet   # per-cluster health scores
    ...
  report/
    index.html                # open this in a browser
    graph.html                # interactive graph visualization
    graph.graphml             # for Gephi / yEd
    graph.gexf                # for Gephi
    summary.json              # machine-readable summary
```

## Configuration

The `config.json` in your `.archobs/` directory controls all pipeline behavior. You can edit it directly or pass flags to override individual settings. Key sections:

- **filters**: Which files to include/exclude (by extension, path prefix, file size)
- **extraction**: Parser backend and language settings
- **embedding**: Provider, model, dimensions
- **graph**: Edge weights, thresholds, decay parameters
- **clustering**: Algorithm, resolution, drift window
- **reporting**: Risk ranking limits, suggestion provider and count

## License

MIT — see [LICENSE.txt](LICENSE.txt).
