# Spec 011: Archobs & Trajectory Feedback Improvements

## Problem

After running archobs + trajectory analysis across real codebases, 11 friction points were identified across three categories: tool output gaps (missing context in velocity/drift/suggestions), skill workflow inefficiencies (sequential queries, buried high-signal steps), and incomplete feature adjacency patterns. The common thread: the data exists but isn't surfaced where agents need it.

## Goal

Close the gaps between what archobs computes internally and what it exposes to agents. Reduce round-trip queries, improve label quality for monolith repos, and make trajectory analysis a natural continuation of archobs rather than a separate invocation.

## Non-Goals

- Changing clustering algorithms or graph construction
- Adding new signal types to the pipeline
- Replacing the HTML report

## Anti-Goals

- Over-fitting cluster labels to specific repo structures
- Making trajectory a required step of archobs (it remains optional)

---

## Changes

### 1. Add `prior_commit_count` to velocity compare output (P0)

**Problem**: Acceleration ratio alone is ambiguous — 6.0x could mean 6 commits up from 1, or 600 up from 100.

**Solution**: When `--compare` is active, map prior-window commit counts onto the velocity DataFrame as `prior_commit_count`. Acceleration is then computed from this column directly.

**Files**: `display.py` — `format_velocity()` compare block

### 2. Include velocity and top-cluster edges in `show all` JSON (P0)

**Problem**: `show all` only includes summary + risks + clusters + drift + suggestions. Velocity and edges require separate queries.

**Solution**: Call `format_velocity()` (with `compare=True`, 30-day window) and `format_edges()` (for the top-5 most active clusters) from within `format_all()`. Add `velocity` and `top_cluster_edges` keys to the JSON output. Table format also gets a velocity section.

**Files**: `display.py` — `format_all()`

### 3. Fire suggestions for top-N leaky clusters (P0)

**Problem**: `suggestions.py:208` uses `iloc[0]` — only the single leakiest cluster gets a suggestion. The 2nd and 3rd leakiest boundaries are invisible.

**Solution**: Loop over top-3 clusters above the 0.20 leakage threshold, generating a suggestion for each. The existing `limit=4` budget accommodates this.

**Files**: `suggestions.py` — `_rule_based_change_suggestions()` leakage block

### 4. Add drift trend field to output (P1)

**Problem**: `show drift` outputs raw ARI values but agents must mentally compute the trend direction. The suggestions engine already does this logic internally but doesn't expose it.

**Solution**: Add `_compute_drift_trend()` → one of `"stabilizing"`, `"degrading"`, `"volatile"`, `"stable"`. Attach as a `trend` column in `format_drift()` output.

**Logic**:
- 3+ windows with sign-change flips in ARI deltas → `volatile`
- Last ARI > previous AND last ARI ≥ 0.60 → `stabilizing`
- Last ARI < previous → `degrading`
- Otherwise → `stable`

**Files**: `display.py` — `_compute_drift_trend()`, `format_drift()`

### 5. Mention parallel show queries in archobs skill (P1)

**Problem**: Step 4 implies sequential reads. Agents following the skill literally are 5-6x slower than necessary.

**Solution**: Add explicit note: "All show subcommands read from Parquet artifacts independently — run them in parallel when calling from an agent."

**Files**: `skills/archobs/SKILL.md` — step 4

### 6. Move commit message themes to primary trajectory workflow (P1)

**Problem**: `git log --format="%s"` for commit message themes is buried under "Manual fallback" but is often the single highest-confidence signal.

**Solution**: Add step 4b between branch signals (step 4) and interpretation (step 5) in the primary workflow.

**Files**: `skills/trajectory/SKILL.md` — new step 4b

### 7. Inline basic trajectory guidance in archobs skill (P1) — SUPERSEDED

**Problem**: After archobs, the most natural next step is trajectory analysis, but it requires a skill context switch.

**Original solution**: Add a "Quick trajectory in the same session" paragraph to the route-findings section.

**Status**: Superseded by the "Route findings" table in archobs SKILL.md, which already links trajectory as the recommended next skill for development momentum analysis. The same-session fast path in trajectory SKILL.md (Change 10) addresses the workflow efficiency concern directly. Spec 012 proposes merging trajectory into forecast, which would further simplify this handoff.

### 8. Add `--include-added-paths` flag to velocity (P2)

**Problem**: Velocity shows `added_count: 35` but not which files were added. For trajectory analysis, the specific new files are the highest-signal data point.

**Solution**: Add `include_added_paths` parameter to `format_velocity()` and `--include-added-paths` CLI flag. When enabled, collect paths with `status='A'` from the current window and attach as `added_paths` list per cluster in JSON output.

**Files**: `display.py` — `format_velocity()`; `cli.py` — `show_velocity()`

### 9. Improve cluster labeling for monolith repos (P2)

**Problem**: Labels like "test/unit + routes/ops" don't distinguish domains. The 40% dominance threshold rarely triggers in large mixed clusters, and 2-segment path prefixes lose context when `src/` is skipped.

**Solution**: Three changes:
- Lower dominance threshold from 40% to 25% for clusters with >30 files
- Use top-2 domain stems (e.g. `orders/payments`) when no single stem dominates but combined coverage exceeds the threshold
- Use 3 path segments (instead of 2) after skipping root dirs like `src/`

**Files**: `display.py` — `_generate_cluster_label()`

### 10. Add trajectory same-session fast path (P3)

**Problem**: After running archobs, the trajectory skill says "Run archobs report first" and lists the same show commands — redundant in the same session.

**Solution**: Add a "Same-session fast path" section: skip steps 1-3, start from step 4 (branch signals) and 4b (commit themes).

**Files**: `skills/trajectory/SKILL.md` — new section before primary path

### 11. Extend feature adjacency table (P3)

**Problem**: Five strong signal patterns observed during real analysis are missing from the adjacency table.

**Solution**: Add the following rows:

| Observed pattern | Likely next |
|-----------------|-------------|
| Migration file recreation/renumbering | Schema stabilization before ship — feature is close to merge |
| Multiple "review cleaning" commits | Code review in progress — approaching merge |
| Idempotency key additions | Offline mode or distributed operation hardening |
| CORS configuration changes | Deployment environment changes (new domains, staging environments) |
| Test coverage push (many test-only commits) | CI pipeline enforcement or pre-release quality gate |

**Files**: `skills/trajectory/SKILL.md` — adjacency table

---

## File Summary

| File | Changes |
|------|---------|
| `tools/archobs/src/archobs/display.py` | `prior_commit_count` in velocity compare; velocity/edges in `format_all`; `_compute_drift_trend()` + trend column; `--include-added-paths` in velocity; improved cluster labeling |
| `tools/archobs/src/archobs/cli.py` | `--include-added-paths` flag on `show velocity` |
| `tools/archobs/src/archobs/suggestions.py` | Top-N leaky cluster suggestions (loop instead of `iloc[0]`) |
| `skills/archobs/SKILL.md` | Parallel query guidance; inline trajectory quick-start; `--include-added-paths` in examples |
| `skills/trajectory/SKILL.md` | Same-session fast path; commit message themes as step 4b; extended adjacency table; `--include-added-paths` example |

---

## Verification

```bash
cd tools/archobs && python -m pytest tests/ -v
```
