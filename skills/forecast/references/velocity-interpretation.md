# Velocity Interpretation Reference

Dense reference material for interpreting archobs velocity signals in the forecast internal engine. See the main [SKILL.md](../SKILL.md) for the workflow.

## Compound Velocity Signal Matrix

The combination of acceleration and growth is what matters for interpretation:

| Acceleration | Growth | Signal |
|---|---|---|
| High (>1.5x) | High (>30%) | Brand-new feature area expanding rapidly — needs architecture review |
| High (>1.5x) | Zero (0%) | Batch ops work on existing code — needs capacity planning |
| Moderate | High (>20%) | Steady buildout of new capability — define boundaries early |
| Low (<0.5x) | High churn | Maintenance/refinement — safe window for refactoring |
| Low (<0.5x) | Zero | Dormant — safe for structural cleanup if leaky |
| Test-only cluster with high growth | — | Feature commitment signal — team is writing tests before/alongside production code. Look at the production cluster this maps to for architectural decisions. |

## Per-File Change Intensity

Interpret `file_change_count` relative to cluster size: Absolute `file_change_count` is misleading without size context. A cluster with 202 changes and 203 files has ~1 change/file (broad shallow touch — migration or bulk rename), while one with 30 changes and 5 files has 6 changes/file (deep iteration on a focused area). The velocity JSON output includes a `size` field for this purpose. Use `file_change_count / size` as the per-file change intensity when comparing clusters of different sizes.

## Cross-Reference Velocity with Risk

Files that appear in both `show risks` (risk > 0.5) AND belong to a high-velocity cluster are the highest-urgency items. These are files that are simultaneously architecturally risky and actively being changed — the most dangerous combination. Use `archobs show risks --min-risk 0.5 --min-volatility 0.5 --format json` to find them directly.

## Convergent Hub Pattern

When 3+ clusters leak primarily toward the same target (visible via `show edges` or the `external_inbound_weight` metric on `show clusters`), the finding is about the hub, not the individual boundaries. The actionable insight is "decompose the attractor" rather than "build N separate boundaries." This is the most common pattern in real monoliths.

## `is_emerging` Flag

`is_emerging` is `true` when a cluster had zero commits in the prior window but has commits in the current window. This signals a brand-new area of development, not acceleration of existing work. Emerging clusters need early boundary definition; accelerating clusters need capacity planning.

## Acceleration Context for New Clusters

When `prior_commit_count` is 0 or very low, acceleration will be infinite or very high (e.g. 6.0x). This signals **emergence** (a brand-new area appearing), not **acceleration** (an existing area speeding up). Distinguish "brand new area" from "existing area speeding up" — they require different responses. New areas need architecture review; accelerating areas need capacity planning.

## Test-Only Clusters

A cluster containing predominantly test files (>80% test paths) with high acceleration is a different signal than a production cluster at the same metrics. It means the team is investing in test coverage for a feature — high confidence the feature is real and the team is committed, but boundary decisions live in the production code, not the test code. Identify the production cluster the tests correspond to and direct architectural recommendations there.

## Cross-Cluster Initiative Detection

When multiple clusters share domain keywords in their `added_paths` or labels (e.g., "loyalty" appearing in both a production cluster and a test cluster), group them as a single feature initiative. This is especially common with test-only clusters — they indicate commitment to a feature whose boundary decisions live in the production cluster. More generally, any time 2+ clusters share a domain keyword (in labels, added paths, or branch names), treat them as one coordinated initiative for trajectory purposes rather than analyzing each cluster independently. The combined velocity and scope of the initiative is what matters for architectural decisions.
