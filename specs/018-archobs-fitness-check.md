# Spec 018: Architecture Fitness Check

## Problem

Archobs produces rich metrics (file risk, cluster leakage/cohesion, bus factor) but there is no automated way to gate on them. Teams must manually inspect `show` output and decide if the architecture is healthy enough. This creates three gaps:

1. **No CI-gatable check** — there is no command that returns exit code 0/1 based on metric thresholds, so archobs cannot be used as a CI quality gate.
2. **No threshold-based evaluation** — teams must define their own scripts to read Parquet files and apply thresholds, duplicating logic that should be built into the tool.
3. **No combined health view** — file risk, cluster health, and bus factor are separate `show` commands with no unified pass/fail assessment.

## Goal

Add an `archobs check` command that:

1. Reads existing Parquet artifacts (never runs the pipeline or writes artifacts — safe for CI)
2. Evaluates configurable thresholds against file risk, cluster leakage/cohesion/risk_mean, and bus factor
3. Returns structured results with per-violation detail
4. Exits 0 (pass) or 1 (fail) for CI integration
5. Degrades gracefully when optional artifacts (bus_factor.parquet) are absent

## Non-Goals

- Running the analysis pipeline (check is read-only)
- Writing or modifying any artifacts
- Historical trend comparison (single-snapshot evaluation)
- Custom check plugins or user-defined rules
- Integration with specific CI systems (GitHub Actions, Jenkins, etc.)

## Algorithm

### Evaluation

`evaluate_fitness(out, thresholds) -> dict`:

1. Read `file_metrics.parquet` — check file risk violations
2. Read `cluster_metrics.parquet` — check leakage, cohesion, risk_mean violations
3. Read `bus_factor.parquet` (optional) — check bus factor violations
4. Apply min_cluster_size filter to cluster-level checks
5. Aggregate violations by category
6. Return structured result

### Checks

| Check | Source | Default Threshold |
|---|---|---|
| File risk > max | file_metrics.parquet | `--max-file-risk 0.8` |
| Cluster leakage > max | cluster_metrics.parquet | `--max-leakage 0.6` |
| Cluster cohesion < min | cluster_metrics.parquet | `--min-cohesion 0.4` |
| Cluster risk_mean > max | cluster_metrics.parquet | `--max-risk-mean 0.5` |
| Bus factor < min | bus_factor.parquet (optional) | `--min-bus-factor 2` |

### Result Schema

```python
{
    "pass": bool,
    "total_violations": int,
    "by_category": {"file_risk": 3, "cluster_leakage": 1, ...},
    "thresholds": {...},
    "violations": [
        {"category": str, "entity": str, "metric": str, "value": float, "threshold": float},
        ...
    ]
}
```

## Interface

### CLI

```
archobs check [--out .archobs] [--max-file-risk 0.8] [--max-leakage 0.6]
    [--min-cohesion 0.4] [--max-risk-mean 0.5] [--min-bus-factor 2]
    [--min-cluster-size 2] [--format json|table] [--ci]
```

- Exit code 0 = pass, 1 = fail
- `--ci` flag forces JSON output
- All thresholds have sensible defaults

## Files

| File | Action |
|---|---|
| `tools/archobs/src/archobs/fitness.py` | Create |
| `tools/archobs/src/archobs/cli.py` | Modify — add `check` command |
| `tools/archobs/tests/test_fitness.py` | Create |

## Tests

- All-passing metrics -> pass
- File risk violations -> fail
- Cluster leakage violations -> fail
- Cohesion violations -> fail
- Risk mean violations -> fail
- Bus factor violations when parquet exists -> fail
- Graceful skip when bus_factor.parquet missing
- min_cluster_size filtering
- Combined violations
- CLI exit codes (0/1)

## Risks

| Risk | Mitigation |
|---|---|
| Default thresholds too strict for young repos | Thresholds are configurable; document recommended starting values |
| Missing Parquet files (no report run) | Clear error message directing user to run `archobs report` first |
| Bus factor artifact optional | Graceful skip with note in output |

## Verification

```bash
cd tools/archobs
python -m pytest tests/test_fitness.py -v
archobs check --out /tmp/test-archobs --format json
archobs check --out /tmp/test-archobs --ci
echo $?  # 0 or 1
```
