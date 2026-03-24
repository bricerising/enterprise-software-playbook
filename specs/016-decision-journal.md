# Spec 016: Decision Journal

## Problem

Agents and practitioners make decisions informed by intelligence signals (spec 006) and forecasts (spec 007), but those decisions are not recorded alongside the evidence. This creates three gaps:

1. **No decision memory across sessions** — when revisiting a topic weeks later, the reasoning behind prior decisions is lost. The agent must re-derive context from scratch.
2. **No signal-to-decision closure** — the intelligence pipeline surfaces signals and the forecast engine predicts scenarios, but there is no mechanism to record which signals drove which decisions, making it impossible to evaluate decision quality over time.
3. **No searchable decision history** — decisions live in chat transcripts, git commits, or Slack threads, none of which are structured or queryable.

## Goal

Add a decision journal to the intelligence tool that:

1. Records decisions with context, rationale, and optional references to signals (events/topics)
2. Supports full-text search and filtered listing across journal entries
3. Persists in the same SQLite database as the intelligence data, sharing the same WAL/migration infrastructure
4. Provides CLI commands for add/list/search operations

## Non-Goals

- Decision evaluation or scoring (future work)
- Automated decision extraction from chat transcripts
- Multi-user conflict resolution (single-writer SQLite model)
- Rich text or markdown in decision fields (plain text only)
- Integration with external decision tracking tools (Jira, Linear, etc.)

## Algorithm

### Storage

Journal entries are stored in a `journal_entries` table with UUID primary keys (to support entries from multiple agents/sessions without AUTOINCREMENT conflicts). An FTS5 virtual table provides full-text search across context, decision, and rationale fields.

Signal references use a JSON array column (`signal_refs`) rather than a junction table because:
- Events may be pruned (retention_days) while journal entries persist
- Avoids FK coupling between ephemeral events and persistent decisions
- Simpler schema for a low-volume table

### Queries

- **addEntry**: INSERT with UUID generation, returns the created entry
- **listEntries**: SELECT with optional filters (since, tag, limit), keyset pagination by (created_at, entry_id), reverse chronological
- **searchJournal**: FTS5 MATCH with snippet(), pagination by (rank, entry_id)

## Interface

### CLI

```
intel journal add --context "..." --decision "..." [--rationale "..."] [--tags "a,b"] [--refs '...']
intel journal list [--since 7d] [--tag "..."] [--limit 20] [--cursor ...]
intel journal search <query> [--since 7d] [--limit 20] [--cursor ...]
```

### Data Types

```typescript
interface JournalEntry {
  entry_id: string;      // UUID
  context: string;       // What situation prompted the decision
  decision: string;      // What was decided
  rationale: string | null;  // Why this option was chosen
  signal_refs: SignalRef[];  // Links to events/topics
  tags: string[];        // Freeform tags
  created_at: string;    // ISO 8601
}

interface SignalRef {
  type: "event" | "topic";
  id: string;
}
```

## Files

| File | Action |
|---|---|
| `tools/intelligence/migrations/008-journal.sql` | Create |
| `tools/intelligence/src/queries/journal.ts` | Create |
| `tools/intelligence/src/bin.ts` | Modify — add journal command group |
| `tools/intelligence/tests/journal.test.ts` | Create |

## Tests

- addEntry creates and returns entry
- addEntry validates required fields (context, decision)
- addEntry with tags and signal_refs
- listEntries reverse chronological order
- listEntries --since filter
- listEntries --tag filter (json_each)
- listEntries pagination
- searchJournal finds by keyword
- searchJournal empty results
- Migration 008 applied

## Risks

| Risk | Mitigation |
|---|---|
| FTS index grows unbounded (no pruning) | Journal entries are low-volume; monitor via `intel stats` |
| UUID collisions | Crypto.randomUUID() — probability negligible |
| Signal refs point to pruned events | By design — refs are informational, not enforced FKs |

## Verification

```bash
cd tools/intelligence && npx tsc --noEmit
npx vitest run tests/journal.test.ts
intel journal add --context "Test" --decision "Verified"
intel journal list
intel journal search "Test"
```
