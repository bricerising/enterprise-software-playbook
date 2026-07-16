# Running archobs locally

## Installation modes

### Prerequisites

Install [codanna](https://codanna.dev), which archobs uses for semantic search embeddings:

```bash
# macOS
brew install codanna

# Linux / other
curl -fsSL --proto '=https' --tlsv1.2 https://install.codanna.sh | sh
```

### Bundled tool (preferred)

The `archobs` CLI is shipped inside this playbook at `tools/archobs/`. Install it from the repo root:

```bash
pip install -e 'tools/archobs[full]'
```

The `[full]` extra adds Leiden clustering (`python-igraph` + `leidenalg`), interactive graph rendering (`pyvis`), and Tree-sitter parsing. Core-only (no extras) works but falls back to greedy modularity and skips interactive visualization.

### CI smoke test install

For CI jobs that only need to verify the tool loads:

```bash
pip install -e 'tools/archobs'
python -m archobs --help
```

## Typical workflows

### First run (full report)

```bash
archobs init --repo . --out .archobs
archobs report --repo . --out .archobs --suggestions-provider rules
archobs show all --format json          # structured output for agents
```

### Re-run after refactoring

```bash
archobs report --repo . --out .archobs --suggestions-provider rules
```

Previous artifacts in `.archobs/` are overwritten. If you need to compare before/after, copy `summary.json` before re-running (see "Comparing runs" below).

### Stage-by-stage runs

Run individual stages when you only need specific artifacts:

```bash
archobs extract inventory --repo .     # file list
archobs extract git --repo .           # co-change edges
archobs extract deps --repo .          # import/dependency edges
archobs embed --repo .                 # semantic embeddings
archobs build-graph --repo .           # fused relationship graph
archobs cluster --repo .               # subsystem clustering
```

Each stage writes Parquet files to `.archobs/` that downstream stages consume, but it also marks the workspace stale. Existing HTML report pages receive a visible stale-data banner and `archobs show` result commands fail until you run a full `archobs report`. Automations may reuse artifacts only when `.archobs/run_manifest.json` has `status: "complete"`.

## Reading results

After the report completes, use `archobs show` to query results without ad-hoc scripting:

```bash
archobs show all --format json              # everything in one JSON object
archobs show risks --top 10 --format json   # top 10 risk files
archobs show risks --min-risk 0.5           # files above risk threshold
archobs show clusters --sort leakage        # clusters by leakage (table)
archobs show drift --format json            # temporal stability
archobs show summary                        # key metrics overview
```

To discover column names and types: `archobs schema file_metrics`

All `show` subcommands accept `--format table|json|csv` and `--out-file PATH`.

## Output management

### What to commit vs what to ignore

Do **not** commit generated artifacts. Add these to the project's `.gitignore`:

```
.archobs/
.codanna/
.codannaignore
.fastembed_cache
```

### Storing a baseline for regression checks

Copy `summary.json` after a clean run:

```bash
cp .archobs/report/summary.json baseline-summary.json
```

On subsequent runs, compare key metrics (modularity, cluster count, top risk scores) against the baseline.

### Comparing runs across branches

```bash
git stash
archobs report --repo . --out .archobs
archobs show summary --format json --out-file /tmp/main-summary.json
git stash pop
archobs report --repo . --out .archobs
archobs show summary --format json
# Compare against /tmp/main-summary.json
```

## Key CLI options

| Flag | Default | What it does |
|---|---|---|
| `--provider` | `auto` | Embedding provider. `auto` uses Codanna if available, otherwise deterministic local hashing. |
| `--algo` | `auto` | Clustering algorithm. `auto` uses Leiden if installed, otherwise NetworkX greedy modularity. |
| `--resolution` | `1.0` | Clustering resolution. Higher values produce more, smaller clusters. |
| `--k-sem` | `20` | Number of semantic nearest neighbors per file. |
| `--tau-sem` | `0.35` | Minimum similarity threshold for semantic edges. |
| `--suggestions-provider` | `auto` | How to generate suggestions: `auto`, `claude`, `codex`, `rules`, or `off`. |

## Interpreting results

See [`interpreting-metrics.md`](interpreting-metrics.md) for the full metric reference.

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `archobs: command not found` | Tool not installed or not on PATH | Re-run `pip install -e 'tools/archobs'` and verify the venv is active |
| `codanna: command not found` | Codanna not installed | Run `brew install codanna` (macOS) or `curl -fsSL --proto '=https' --tlsv1.2 https://install.codanna.sh \| sh` (Linux) |
| Empty graph (0 edges) | Too few files or all files filtered out | Check `config.json` filter settings; lower `tau_sem` threshold |
| Single giant cluster | Clustering resolution too low or insufficient signal diversity | Increase `clustering.resolution` (try 1.5 or 2.0) |
| `leidenalg` import error | Optional dependency not installed | Install with `[full]` extras or set `clustering.algorithm` to `greedy-modularity` |
| Very slow embedding stage | Large repo + Codanna provider | Use `--provider hashing` for a fast deterministic fallback |
