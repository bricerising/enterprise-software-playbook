# Decision 017: Make archobs artifact trust states explicit

**Date**: 2026-07-11
**Status**: Accepted

## Context

Archobs combines subprocess-backed semantic analysis with staged artifact writes. A provider can fail partway through its own fallback chain, targeted commands can update only one artifact generation, and a valid report can have no team history. Treating those states as ordinary success makes lower-quality, mixed-generation, or unavailable data look trustworthy.

- **Goal**: Preserve the best available semantic signal while making artifact consistency and unavailable optional analysis explicit to every consumer.
- **Constraints**: Keep existing CLI commands and Parquet/JSON shapes backward compatible; targeted stages remain supported; full reports must clear prior-generation optional artifacts.
- **Anti-goals**: Redesigning provider selection, introducing generation directories, or treating a legitimate no-data result as a report failure.
- **Boundary + time horizon**: Applies to archobs provider fallbacks and generated artifacts immediately; review after two releases.
- **Actors + incentives**: CLI users and CI need trustworthy results; maintainers need deterministic fallbacks and migration-safe output directories.

## Options considered

| Option | Optimizes for | Knowingly worsens | Reversibility |
| --- | --- | --- | --- |
| A: Explicit trust states and bounded fallback chains | Accuracy, graceful degradation, migration safety | More metadata and no-data branches for consumers | High — behavior is localized and additive |
| B: Fail every report on the first provider or optional-data failure | Simple control flow | Availability and usefulness when a secondary provider operation is healthy | High |
| C: Preserve artifacts and let consumers infer freshness/availability | Minimal code | Silent mixed generations and misleading zero-risk results | N/A — rejected baseline |

## Decision

Choose Option A:

- Codanna tries its secondary search operation when the primary operation fails or times out. The provider fails only when both operations fail; `auto` then falls back to hashing, while an explicit Codanna request surfaces the combined failure.
- Every targeted artifact-writing command marks its output directory stale, creating a minimal stale manifest even for a legacy or newly initialized manifestless workspace.
- Full reports write current-generation team artifacts even when empty, clearing older results. Empty team artifacts mean “analysis unavailable,” not “zero violations”: fitness skips the bus-factor check with a warning, and JSON display returns an empty JSON collection.

## Kill criteria / reversal trigger

- If secondary Codanna searches materially increase report latency without recovering useful results, replace the sequential fallback with a configurable policy.
- If consumers cannot distinguish an empty JSON collection from a measured zero-result analysis, add a versioned availability field rather than changing the existing list shape in place.
- If stale manifests are insufficient to prevent concurrent-writer races, move to output-directory locking or generation directories.

## Measurement + review ritual

- **Leading indicators (early)**: Regression tests for primary-timeout recovery, manifestless targeted writes, empty-team fitness warnings, and valid JSON no-data output.
- **Lagging outcomes**: No review findings or user reports involving concealed provider downgrade, mixed-generation trust, or unavailable team analysis reported as checked.
- **Instrumentation source**: Archobs pytest suite, CLI exit codes, generated `run_manifest.json`, and report metadata.
- **Owner + cadence + action trigger**: Archobs maintainers at each release; revisit immediately if any trust-state regression reaches a release candidate.

## Consequences

- Positive: Recoverable provider failures remain high quality; legacy targeted workflows fail safe; consumers receive truthful no-data semantics.
- Trade-off: Consumers must handle warnings and empty JSON collections, and targeted-only workspaces are deliberately marked stale until a full report completes.
- Compatibility: Existing artifact filenames and record schemas remain stable. The stale manifest is additive for legacy workspaces.

## Review date

2027-01-11
