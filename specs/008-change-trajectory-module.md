# Spec 008: Change Trajectory Module

## Problem

The intelligence tool answers "what's happening in the technology landscape" (forecast) and the risk overlay answers "where is the codebase fragile under external pressure." But neither answers the question operators actually ask during sprint planning and roadmap discussions: **"given what we've been building recently, what features are likely next?"**

This is feature trajectory inference. If a team is building data export features in an invoice management app, reporting features are the natural next step. If CRUD operations are being added for a new entity, search and filtering follow. These adjacencies are obvious to experienced engineers but invisible to AI agents that lack structured data about recent development patterns.

The archobs tool already extracts rich git history (`commits.parquet`) and organizes files into architectural clusters. The missing piece is a query module that structures this data into a development trajectory — which clusters are actively growing, what kinds of files are being added, and where development velocity is concentrated — so the LLM can apply domain reasoning about feature adjacency.

## Goal

Add a `computeTrajectory` query module (`tools/intelligence/src/queries/change-trajectory.ts`) that analyzes recent git history in the context of archobs cluster assignments to surface:

1. **Per-cluster change profiles** — additions vs modifications vs deletions, recently added paths, most-modified paths
2. **Velocity trends** — whether each cluster is accelerating, steady, decelerating, or dormant
3. **Development momentum** — which clusters are receiving the most attention, how concentrated or scattered the work is
4. **Commit subject patterns** (optional) — frequent tokens and recent messages for thematic context

The tool produces deterministic, structured data. Feature adjacency reasoning ("exports suggest reports are coming") is the LLM's job at the skill/agent layer, not the tool's.

## Non-Goals

- Predicting specific features or user stories (the tool surfaces evidence; the LLM reasons)
- Analyzing code semantics or AST structure (that's archobs's domain)
- Tracking individual developer activity or attribution (archobs strips author data by design)
- Real-time or streaming analysis (runs on-demand against extracted commit data)
- Replacing forecast's external signal analysis (trajectory is internal-only; they compose, not compete)

## Anti-Goals

- Over-engineering the velocity classifier (simple half-window ratio suffices; the forecast module already has HMM for external signals)
- Building a commit message NLP pipeline (simple tokenization is enough; the LLM does semantic reasoning)
- Creating a prediction model (the tool is an evidence extractor, not a classifier)

## Scope

| In scope | Out of scope |
|----------|-------------|
| Per-cluster change volume and direction (A/M/D ratios) | Diff-level analysis (what lines changed) |
| Velocity trend classification from commit temporal distribution | Custom velocity models or thresholds |
| Momentum ranking and Herfindahl concentration index | Predictive scoring or probability estimates |
| Recently added/modified/deleted path lists per cluster | File content analysis or semantic similarity |
| Optional commit subject tokenization | NLP, embeddings, or LLM-based message analysis |
| Composition with archobs cluster context | Direct archobs Parquet reading (pure function contract) |
| Window-based filtering (default 30 days) | Rolling or streaming windows |

---

## Architecture

```
.archobs/commits.parquet ─────────────┐
   (or git log parsed to JSON)        │
                                      ├──→  computeTrajectory()  ──→  TrajectoryData
archobs show all --format json ───────┘     (pure function)
   (clusters, file_risks, drift)
                                                  │
                                          Agent reads active code
                                                  │
                                          LLM reasons about feature adjacency
```

The module is a pure function — no database access, no file I/O, no subprocess calls. It receives typed input (commit-level file changes + archobs cluster context) and returns typed output. This follows the exact pattern of `composeRiskIntelligence` in `risk-intelligence.ts`.

### Data Source Strategy

Commit data comes from one of two sources (caller's choice):

1. **Preferred**: Read `.archobs/commits.parquet` (already extracted and cleaned by archobs)
2. **Fallback**: Parse `git log --date-order --reverse --pretty=format:--COMMIT--%n%H%n%ct --name-status --no-renames` (same command archobs uses internally in `git_history.py`)

Both produce the same `CommitFileInput[]` shape. The trajectory module accepts this as structured input — it never reads files or runs commands itself.

Commit messages are deliberately optional. File paths already reveal feature intent (`src/exports/csv-exporter.ts` is self-documenting). Messages add thematic context when available but are not required for useful output.

### Composition Model

The trajectory module is independent of the intel database and forecast module. It composes with them at the agent/skill layer:

| Composition | Signal sources | What it answers |
|---|---|---|
| Trajectory alone | Git history + archobs clusters | "What are we building? What's next?" |
| Trajectory + forecast | Git + archobs + external signals | "What are we building, and does external pressure align?" |
| Trajectory + risk overlay | Git + archobs + forecast dynamics | "What are we building, and where are compound risks?" |

---

## Interface

### CLI

```
intel change-trajectory --commits <path> --archobs <path> [--commit-messages <path>] [--window-days 30]
```

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `--commits` | path | yes | — | Path to commits JSON (from `.archobs/commits.parquet` export or git log parse) |
| `--archobs` | path | yes | — | Path to archobs JSON (output of `archobs show all --format json`) |
| `--commit-messages` | path | no | — | Path to commit messages JSON (`[{commit_sha, subject}]`) |
| `--window-days` | number | no | 30 | Analysis window in days from most recent commit |

### MCP Tool

```json
{
  "name": "intel_change_trajectory",
  "description": "Analyze recent development patterns from git history to surface where development momentum is concentrated and what areas are growing — structured data for predicting likely next features",
  "inputSchema": {
    "type": "object",
    "properties": {
      "commits": {
        "type": "array",
        "description": "Commit-level file changes. Each: {commit_sha, commit_ts (unix seconds), status (A/M/D), path}",
        "items": { "type": "object" }
      },
      "clusters": {
        "type": "array",
        "description": "Archobs cluster metrics (from archobs show clusters --format json)",
        "items": { "type": "object" }
      },
      "file_risks": {
        "type": "array",
        "description": "Archobs file risk metrics with cluster_id (from archobs show risks --format json)",
        "items": { "type": "object" }
      },
      "drift": {
        "type": "object",
        "description": "Most recent archobs drift entry (from archobs show drift --format json)"
      },
      "commit_messages": {
        "type": "array",
        "description": "Optional: [{commit_sha, subject}] for pattern extraction",
        "items": { "type": "object" }
      },
      "window_days": {
        "type": "number",
        "description": "Analysis window in days (default: 30)"
      }
    },
    "required": ["commits", "clusters"]
  }
}
```

The handler calls `computeTrajectory(input)` directly — no database access required.

---

## Input Types

```typescript
export interface CommitFileInput {
  commit_sha: string;
  commit_ts: number;        // Unix timestamp (seconds)
  status: 'A' | 'M' | 'D'; // Added, Modified, Deleted
  path: string;
}

export interface CommitMessageInput {
  commit_sha: string;
  subject: string;          // First line of commit message
}

// Reuses from risk-intelligence.ts:
// - ArchobsClusterInput (cluster_id, leakage, cohesion, risk_mean, risk_max, top_paths)
// - ArchobsRiskInput (path, risk, xnbr, hubness, volatility, cluster_id)
// - ArchobsDriftInput (ari_prev, modularity, cluster_count)

export interface TrajectoryInput {
  commits: CommitFileInput[];
  clusters: ArchobsClusterInput[];
  file_risks?: ArchobsRiskInput[];
  drift?: ArchobsDriftInput;
  commit_messages?: CommitMessageInput[];
  window_days?: number;                    // Default: 30
}
```

---

## Response Shape

```typescript
export interface TrajectoryData {
  window: {
    start_ts: number;          // Unix timestamp of oldest included commit
    end_ts: number;            // Unix timestamp of newest included commit
    total_commits: number;     // Distinct commit SHAs in window
    total_file_changes: number; // Total commit-file entries in window
  };
  clusters: ClusterTrajectory[];
  momentum: ClusterMomentum[];
  concentration_index: number;       // Herfindahl: Σ(share²); near 1.0 = focused, near 1/N = scattered
  subject_patterns?: SubjectPatterns; // Only present when commit_messages provided
}
```

### ClusterTrajectory

```typescript
export interface ClusterTrajectory {
  cluster_id: number;
  top_paths: string[];          // From archobs cluster data

  // Change volume
  total_changes: number;
  additions: number;            // Files with status 'A'
  modifications: number;        // Files with status 'M'
  deletions: number;            // Files with status 'D'

  // Directional signal
  growth_ratio: number;         // additions / total (0-1)
  churn_ratio: number;          // modifications / total (0-1)
  contraction_ratio: number;    // deletions / total (0-1)

  // Velocity
  recent_commits: number;       // Distinct commits touching this cluster in window
  velocity_trend: 'accelerating' | 'steady' | 'decelerating' | 'dormant';
  velocity_halves: [number, number]; // [older_half_commits, newer_half_commits]

  // Path patterns (for LLM reasoning)
  recently_added_paths: string[];   // Paths with status 'A', sorted newest-first
  most_modified_paths: string[];    // Paths by modification count, top 10
  recently_deleted_paths: string[]; // Paths with status 'D', sorted newest-first

  // Archobs context (carried through)
  archobs?: {
    leakage: number;
    cohesion: number;
    risk_mean: number;
    risk_max: number;
  };
}
```

### ClusterMomentum

```typescript
export interface ClusterMomentum {
  cluster_id: number;
  share_of_changes: number;  // This cluster's changes / total (0-1)
  rank: number;              // 1 = most active cluster
}
```

### SubjectPatterns

```typescript
export interface SubjectPatterns {
  top_tokens: Array<{ token: string; count: number }>;  // Top 15 meaningful tokens
  recent_subjects: string[];                             // Last 20 commit subjects
}
```

---

## A. Cluster Assignment

### Purpose

Map each commit-file entry to its architectural cluster so changes can be analyzed per-subsystem.

### Algorithm

1. Build a `path → cluster_id` map from `file_risks` array (every file in archobs has a cluster assignment)
2. For each `CommitFileInput`, look up `path` in the map
3. Unmatched paths (deleted files, files added since last archobs run) are assigned `cluster_id = -1`
4. Group commit entries by cluster_id

### Design rationale

Using `file_risks` rather than `clusters.top_paths` because `top_paths` only contains the top 5 files per cluster. `file_risks` has the complete mapping.

---

## B. Per-Cluster Trajectory

### Purpose

Compute change profile, directional signal, and velocity for each cluster.

### Algorithm

**Change volume**: Count entries by status field:
- `additions` = count where status = 'A'
- `modifications` = count where status = 'M'
- `deletions` = count where status = 'D'
- `total_changes` = additions + modifications + deletions

**Directional ratios**: Simple fractions (0 when total is 0):
- `growth_ratio` = additions / total_changes
- `churn_ratio` = modifications / total_changes
- `contraction_ratio` = deletions / total_changes

**Velocity**: Split the time window at its midpoint. Count distinct commit SHAs in each half.

| Condition | Classification |
|-----------|---------------|
| total distinct commits < 3 | `dormant` |
| newer_half > older_half × 1.5 | `accelerating` |
| older_half > newer_half × 1.5 | `decelerating` |
| otherwise | `steady` |

**Path lists**:
- `recently_added_paths`: all paths with status 'A', sorted by commit_ts descending, deduplicated
- `most_modified_paths`: paths with status 'M', counted and sorted by count descending, top 10
- `recently_deleted_paths`: all paths with status 'D', sorted by commit_ts descending, deduplicated

---

## C. Momentum and Concentration

### Purpose

Quantify which clusters are receiving the most development attention and whether work is focused or scattered.

### Algorithm

**Momentum**: For each cluster, `share = cluster_total_changes / global_total_changes`. Rank clusters by share descending.

**Concentration index** (Herfindahl-Hirschman):

```
H = Σ(share_i²) for all clusters
```

| Value | Interpretation |
|-------|---------------|
| Near 1.0 | All changes in one cluster (focused sprint) |
| Near 1/N | Changes evenly spread across N clusters (scattered work) |
| 0.3–0.5 | Moderate concentration (2-3 active areas) |

This single number gives the LLM an immediate signal about development focus without requiring it to scan all cluster data.

---

## D. Subject Pattern Extraction (Optional)

### Purpose

When commit messages are provided, extract thematic patterns that help the LLM understand what's being built ("export," "report," "migration," "auth").

### Algorithm

1. Collect subjects from `commit_messages` for commits within the analysis window
2. Tokenize each subject: split on whitespace, punctuation, and common delimiters
3. Normalize to lowercase
4. Filter noise tokens: articles, prepositions, common verbs ("add", "fix", "update", "remove"), common prefixes ("feat:", "fix:", "chore:", "refactor:")
5. Count token frequencies
6. Return top 15 tokens sorted by count descending
7. Return last 20 subjects (most recent first) as `recent_subjects`

### Design rationale

This is deliberately simple bag-of-words — no embeddings, no NLP. The LLM does the semantic reasoning. The tool just surfaces "the words 'export', 'csv', 'format', and 'template' appear 47 times in recent commits."

---

## Implementation

### File Structure

```
tools/intelligence/src/queries/change-trajectory.ts  — types + pure functions (~250 lines)
tools/intelligence/tests/change-trajectory.test.ts   — 12+ tests
skills/trajectory/SKILL.md                           — skill guidance for agents
```

### Internal Functions

| Function | Section | Description |
|----------|---------|-------------|
| `computeTrajectory` | Main | Orchestrator: filter window, assign clusters, compute all sections |
| `assignCommitsToClusters` | A | Build path→cluster map, group commits by cluster |
| `computeClusterTrajectory` | B | Per-cluster change profile, velocity, path lists |
| `classifyVelocity` | B | Half-window ratio → velocity_trend classification |
| `computeMomentum` | C | Share + rank + Herfindahl concentration |
| `extractSubjectPatterns` | D | Tokenize, filter, count, return top tokens + recent subjects |

### Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| Default window_days | 30 | Analysis window |
| Velocity dormant threshold | 3 commits | Below this = dormant regardless of distribution |
| Velocity acceleration ratio | 1.5 | newer/older half ratio for accelerating/decelerating |
| Top modified paths cap | 10 | Limit most_modified_paths per cluster |
| Top subject tokens | 15 | Limit subject pattern tokens |
| Recent subjects | 20 | Limit recent_subjects list |
| Unassigned cluster_id | -1 | For paths not found in archobs file_risks |

### Dependencies

- `risk-intelligence.ts` — reuse `ArchobsClusterInput`, `ArchobsRiskInput`, `ArchobsDriftInput` types
- No database dependencies
- No external library dependencies beyond TypeScript stdlib

---

## Skill Guidance

### New skill: `skills/trajectory/SKILL.md`

The trajectory skill guides agents to:

1. Run archobs to get cluster assignments
2. Extract commits data from `.archobs/commits.parquet` or `git log`
3. Run `intel change-trajectory` with the data
4. Read code in active clusters and reason about feature adjacency

**Feature adjacency reasoning table** (for LLM reference):

| Observed pattern | Likely next |
|-----------------|-------------|
| Export features (CSV, PDF, data transforms) | Reporting features (aggregates, charts, dashboards) |
| CRUD operations for new entities | Search, filter, and sort capabilities |
| Data model additions | API endpoints exposing the data |
| Authentication/authorization scaffolding | User management, roles, permissions UI |
| Test file additions in a cluster | Committed feature work (the team is investing) |
| Configuration/settings additions | Feature flags, admin controls |
| Event/webhook infrastructure | Notification and integration features |
| Schema migrations | Data import/migration tooling |

This table is skill-level guidance — the LLM uses it as a heuristic, not a rule.

### Workflow integration

Add to `skills/workflow/SKILL.md` Define stage:
- If `intel_change_trajectory` is available and the work involves planning what to build next, invoke after archobs

Add to common compositions:
- Feature roadmap: `archobs` → `trajectory` → `plan`
- Full situational awareness: `archobs` → `trajectory` → `forecast` → `risk-overlay` → `plan`

### Forecast cross-reference

Add to `skills/forecast/SKILL.md`:
- Signal source comparison table (forecast = external, trajectory = internal, risk-overlay = compound)

---

## Tests

**File**: `tools/intelligence/tests/change-trajectory.test.ts`

### Fixtures

```typescript
function makeCommit(overrides: Partial<CommitFileInput>): CommitFileInput
function makeCluster(overrides: Partial<ArchobsClusterInput> & { cluster_id: number }): ArchobsClusterInput
function makeFileRisk(overrides: Partial<ArchobsRiskInput> & { path: string; cluster_id: number }): ArchobsRiskInput
```

### Test Cases

| # | Test | Assertion |
|---|------|-----------|
| 1 | Empty input (no commits) | All zeros, empty arrays |
| 2 | Single cluster, additions only | growth_ratio = 1.0, churn/contraction = 0 |
| 3 | Mixed A/M/D statuses | Correct counts and ratios for each |
| 4 | Concentrated changes (90% in one cluster) | High concentration_index, rank=1 for dominant cluster |
| 5 | Velocity: more recent than older commits | `accelerating` |
| 6 | Velocity: more older than recent commits | `decelerating` |
| 7 | Velocity: balanced distribution | `steady` |
| 8 | Velocity: fewer than 3 total commits | `dormant` |
| 9 | Unknown paths (not in file_risks) | Assigned to cluster_id = -1 |
| 10 | Window filtering | Commits outside window_days excluded |
| 11 | Subject patterns with commit_messages | top_tokens populated, recent_subjects populated |
| 12 | No commit messages | subject_patterns is undefined |
| 13 | Path lists | recently_added sorted newest-first, most_modified sorted by count |
| 14 | Integration: full computeTrajectory | All output sections present, types valid |

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Large repos produce thousands of commit entries | Window filtering limits to 30 days by default; pure function stays fast since it's array iteration, not SQL |
| Deleted files don't appear in archobs file_risks | Assigned to cluster -1; these are surfaced in `recently_deleted_paths` and the LLM can reason about them |
| Commit messages may be low-quality ("wip", "fix") | Subject patterns are optional; path-based analysis works without them |
| Single-person repos show one development style | Concentration index will be high; the LLM can note this |
| Archobs cluster assignments may be stale | Drift data (if provided) indicates stability; a low ari_prev warns the LLM that cluster assignments are shifting |
| Path-based feature reasoning may be wrong | This is explicitly the LLM's job, not the tool's; the tool surfaces evidence, not conclusions |

---

## Planned Improvements (from field testing)

After running trajectory analysis on a real 1,251-file TypeScript monolith, two workflow friction points emerged:

### I1. `--archobs-dir` flag to eliminate manual JSON extraction (Finding #7)

**Problem**: The current workflow requires a 3-step data preparation process: extract commits to JSON (Python snippet), extract archobs data to JSON (`archobs show all --format json`), optionally extract commit messages. Compare to archobs which is self-contained (`archobs report` → `archobs show all`).

**Solution — Option B** (preferred): Add `--archobs-dir` flag to `intel change-trajectory` that reads archobs Parquet artifacts directly.

```bash
# Current (multi-step):
python3 -c "import pandas as pd, json, sys; ..." > /tmp/commits.json
archobs show all --format json > /tmp/archobs.json
intel change-trajectory --commits /tmp/commits.json --archobs /tmp/archobs.json

# Proposed (single-step):
intel change-trajectory --archobs-dir .archobs [--window-days 30]
```

When `--archobs-dir` is provided, the tool:
1. Reads `commits.parquet` directly (using a lightweight Parquet reader or pre-parsing to JSON)
2. Reads `file_metrics.parquet` for cluster assignments
3. Reads `cluster_metrics.parquet` for cluster context
4. Reads `drift.parquet` for stability context
5. Optionally reads commit messages from `git log` in the repo

**Trade-off**: This adds a file I/O dependency to what is currently a pure function. The pure-function contract (`computeTrajectory`) stays unchanged — the `--archobs-dir` flag adds a convenience wrapper at the CLI/MCP layer that constructs the input from Parquet files.

**Alternative — Option A**: Add an `archobs trajectory` subcommand to archobs itself. This keeps the intelligence tool pure but requires Python-side changes. Less preferred because the trajectory logic is in TypeScript.

**Status**: Planned. Depends on spec 009 (archobs agent ergonomics) for the `show files` command that provides complete file-to-cluster mappings. If spec 009 ships first, the extraction simplifies to `archobs show files --format json` + `archobs show all --top 0 --format json`, which may be sufficient without `--archobs-dir`.

### I2. Incomplete file_risks input from `show all` (Finding #8)

**Problem**: `assignCommitsToClusters` (line 96-117) maps files to clusters via the `file_risks` input. But `archobs show all --format json` returns only the top 10 risk files. Any commit touching a file outside the top 10 gets assigned to `cluster_id = -1` (unassigned), making trajectory analysis inaccurate for most commits.

**Solution**: Addressed by spec 009 change B (full file-to-cluster JSON output). Once `archobs show all --top 0 --format json` returns all files, the trajectory skill workflow produces accurate cluster assignments without workarounds.

**Interim mitigation**: Update the trajectory skill workflow to use `archobs show risks --top 0 --format json` (which already supports unlimited output) instead of relying on `show all`:

```bash
archobs show risks --top 0 --format json > /tmp/risks.json
archobs show clusters --format json > /tmp/clusters.json
archobs show drift --format json > /tmp/drift.json
# Combine manually or pass separately
```

**Status**: Blocked by spec 009 change B for the clean solution. Interim mitigation can be applied now.

---

## Decision Summary

| Decision | Selected | Rationale |
|----------|----------|-----------|
| Pure function (no DB access) | Yes | Follows risk-intelligence.ts pattern; keeps function testable without mocks |
| Commit data as input (not read from disk) | Accept JSON input | Maintains pure-function contract; caller extracts from Parquet or git |
| Commit messages optional | Yes | Paths already reveal intent; messages are enrichment, not requirement |
| Simple velocity classifier (half-window ratio) | 1.5x threshold | The forecast module already has HMM for external signals; internal velocity doesn't need that complexity |
| Herfindahl concentration index | Single scalar | Gives LLM an immediate focus signal without scanning all cluster data |
| Feature adjacency reasoning at skill layer | Skill guidance table | The LLM applies domain knowledge; the tool provides evidence |
| No archobs Parquet reading | Separate input | Avoids Python/Parquet dependency in TypeScript tool; one-liner extraction in skill guidance |
| Cluster -1 for unmatched paths | Convention | Transparent handling of deleted/new files; consistent with "unassigned" semantics |

---

## Verification

```bash
# 1. Types compile
cd tools/intelligence && npm run build

# 2. All tests pass (including new change-trajectory suite)
npx vitest run tests/change-trajectory.test.ts

# 3. Full test suite passes (no regressions)
npx vitest run

# 4. CLI produces valid output
echo '[{"commit_sha":"abc","commit_ts":1710000000,"status":"A","path":"src/exports/csv.ts"}]' > /tmp/commits.json
archobs show all --format json > /tmp/archobs.json
intel change-trajectory --commits /tmp/commits.json --archobs /tmp/archobs.json

# 5. MCP tool invocation
# (via MCP client) invoke intel_change_trajectory with commits + clusters

# 6. Verify output structure
intel change-trajectory --commits /tmp/commits.json --archobs /tmp/archobs.json | jq 'keys'
# Expected: ["clusters", "concentration_index", "momentum", "window"]
```
