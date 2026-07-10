# Spec 017: Archobs Team Analysis

## Problem

The archobs tool measures coupling, boundary health, and risk hotspots at the file and cluster level, but has no visibility into the human dimension: who works on what, how concentrated knowledge is, and where bus factor risk exists. This gap means:

1. **No author attribution in git extraction** — the git history parser captures commit SHA, timestamp, message, and file status, but discards author information.
2. **No knowledge concentration metrics** — a cluster maintained by a single developer is a different kind of risk than one with broad ownership, but these risks are invisible.
3. **No bus factor analysis** — the minimum number of developers needed to cover the majority of a cluster's commits is a critical organizational health metric that has no representation in the pipeline.

## Goal

Add author/team analysis to archobs that:

1. Captures author names during git history extraction (additive column)
2. Computes per-cluster author distribution, bus factor, and knowledge concentration (HHI)
3. Exposes results via `archobs show team` with table/json/csv output
4. Produces Parquet artifacts that the fitness check (spec 018) can consume
5. Represents unavailable team history without implying that bus-factor analysis ran successfully

## Non-Goals

- Author identity resolution (mapping multiple git names to one person)
- Blame-level analysis (line-by-line authorship)
- Team boundary definition or organizational chart mapping
- Email extraction or PII handling (author name only)
- Historical team metric trends (single-snapshot analysis)

## Algorithm

### Author Extraction

Add `%an` (author name) to the git log format string. The state machine parser gains an `awaiting_author` state between `awaiting_ts` and `awaiting_msg`. The resulting DataFrame adds an `author` column:

```
["commit_sha", "commit_ts", "author", "message", "status", "path"]
```

This is an additive change — existing consumers reference columns by name, not position. The `if "author" in df.columns` guard in the pipeline ensures backward compatibility with pre-existing `.archobs/` artifacts.

### Team Metrics (pure functions)

**compute_author_stats(commits_df, file_metrics_df)**:
- Join commits with file_metrics on path to get cluster_id
- Group by (cluster_id, author)
- Count commits and distinct files per author per cluster
- Compute pct_of_cluster (author's commits / cluster total)

**compute_bus_factor(author_stats_df, threshold=0.8)**:
- For each cluster, sort authors by commit_count descending
- Accumulate until cumulative percentage >= threshold
- Bus factor = count of authors needed to reach threshold
- Also return top author and their percentage

**compute_knowledge_concentration(author_stats_df)**:
- For each cluster, compute Herfindahl-Hirschman Index (HHI)
- HHI = sum of squared market shares (pct_of_cluster^2)
- Range: 0 (perfectly dispersed) to 1 (single author monopoly)
- Also return author count per cluster

### Pipeline Integration

In `AnalysisRun.report()`, after `_enrich_cluster_commit_counts`, always persist current-generation frames:

```python
author_stats_df = compute_author_stats(commit_files_df, file_metrics_df)
bus_factor_df = compute_bus_factor(author_stats_df)
concentration_df = compute_knowledge_concentration(author_stats_df)
write_parquet(author_stats_df, store.base_path, "author_stats")
write_parquet(bus_factor_df, store.base_path, "bus_factor")
write_parquet(concentration_df, store.base_path, "concentration")
```

Writing schema-correct empty frames clears prior-generation team data. Consumers MUST treat empty team frames as unavailable analysis rather than as a measured zero-risk result.

## Interface

### CLI

```
archobs show team [--sort bus_factor|concentration|size] [--min-size 2] [--format json|table|csv]
```

When team analysis is unavailable, table output returns an explanatory no-data message and JSON output returns the valid empty collection `[]`.

**Acceptance scenario**: Given a completed report with no author-bearing commit data, when a consumer runs `archobs show team --format json`, then the command exits successfully with `[]` and never emits a non-JSON explanatory string on stdout.

### Parquet Artifacts

**author_stats.parquet**: cluster_id, author, commit_count, file_count, pct_of_cluster
**bus_factor.parquet**: cluster_id, bus_factor, top_author, top_author_pct
**concentration.parquet**: cluster_id, hhi, author_count

## Files

| File | Action |
|---|---|
| `tools/archobs/src/archobs/git_history.py` | Modify — LOG_FORMAT + parser + author column |
| `tools/archobs/src/archobs/team_metrics.py` | Create |
| `tools/archobs/src/archobs/pipeline.py` | Modify — team metrics in report() |
| `tools/archobs/src/archobs/cli.py` | Modify — add `show team` |
| `tools/archobs/src/archobs/display.py` | Modify — add readers + format_team |
| `tools/archobs/tests/test_team_metrics.py` | Create |
| `tools/archobs/tests/test_core.py` | Modify |
| `tools/archobs/tests/test_show.py` | Modify |

## Tests

- compute_author_stats with multiple authors
- compute_author_stats empty DataFrame
- compute_bus_factor single author = 1
- compute_bus_factor multiple authors
- compute_knowledge_concentration monopoly = 1.0
- compute_knowledge_concentration dispersed < 0.5
- Author column present in git extraction
- Pipeline produces author_stats.parquet
- show team table/json/csv formats
- show team CLI integration
- Empty team artifacts replace prior-generation values
- Empty team JSON output is `[]`, not plain text

## Risks

| Risk | Mitigation |
|---|---|
| Author name variants (John vs john vs John D.) | Out of scope — note as limitation; future identity resolution |
| Large repos with many authors | Parquet is efficient; no in-memory scaling concern |
| Backward compat with existing artifacts | Persist current schema even when source author data is absent; consumers recognize empty artifacts as unavailable |

## Verification

```bash
cd tools/archobs
python -m pytest tests/test_team_metrics.py -v
python -m pytest tests/test_core.py -v -k "author"
archobs report --repo /path/to/repo --out /tmp/test-archobs
archobs show team --out /tmp/test-archobs --format json
```
