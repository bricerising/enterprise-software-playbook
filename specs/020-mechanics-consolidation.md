# Spec 020: Mechanics Consolidation

## Problem

The Mechanics stage contains three skills (`patterns-creational`, `patterns-structural`, `patterns-behavioral`) that are implementation reference material, not a distinct workflow step. The `design` skill already contains a Pattern Chooser cheat sheet covering all 22 GoF patterns and routes users to the pattern skills for implementation detail. Spec 003 itself acknowledges this: "in-process pattern application is usually a supporting step during implementation, not the starting point."

Two structural problems follow:

1. **Mechanics is not a workflow step** — The 5-stage loop (Define > Standardize > Harden > Verify > Mechanics) implies every change needs a "Mechanics" phase. In practice, the workflow skill's proportionality table skips `patterns-*` for tiny and normal scope changes. The Mechanics stage exists in the taxonomy but is almost never the active phase.

2. **Two hops for pattern selection** — Users who don't know which pattern they need go to `design`, which routes to one of three `patterns-*` skills. Users who already know go directly to `patterns-*`. In both cases, the pattern skills are reference material consumed during design work, not independent workflow steps.

## Goal

1. Move pattern skill content into `skills/design/references/` as progressive disclosure reference material
2. Eliminate the Mechanics stage — reduce taxonomy from 5 stages to 4 (Define/Standardize/Harden/Verify)
3. Delete the three `patterns-*` skill directories
4. Update `design` to absorb pattern skill descriptions, tags, and aliases for discoverability
5. Update all documentation, validation scripts, and cross-references

## Non-Goals

- Changing the content of individual pattern reference files (the 22 GoF pattern .md files move unchanged)
- Changing the `design` skill's decision workflow (the Pattern Chooser cheat sheet stays as-is)
- Changing skills outside the Define and former-Mechanics stages
- Updating historical ADRs (009, 001) beyond amendment notes — old skill names are preserved as-is for decision lineage

## Anti-Goals

- Making pattern references harder to find (discoverability must be preserved via design's tags/aliases)
- Losing any content from the pattern skills (all reference content and workflow guidance moves; only YAML frontmatter is dropped)
- Making design's SKILL.md exceed the 500-line progressive disclosure limit (pattern detail lives in references/)

---

## Changes

### A. Move pattern reference files (High)

**Problem**: The 22 individual pattern reference files (e.g., `factory-method.md`, `adapter.md`, `observer.md`) and 6 snippet files currently live under three separate skill directories that will be deleted.

**Solution**: Move them into `skills/design/references/` organized by pattern family.

**File moves** (git mv):
- `skills/patterns-creational/references/{abstract-factory,builder,factory-method,prototype,singleton}.md` → `skills/design/references/creational/`
- `skills/patterns-structural/references/{adapter,bridge,composite,decorator,facade,flyweight,proxy}.md` → `skills/design/references/structural/`
- `skills/patterns-behavioral/references/{chain-of-responsibility,command,iterator,mediator,memento,observer,state,strategy,template-method,visitor}.md` → `skills/design/references/behavioral/`

**Snippet files** — merged into unified files:
- `skills/design/references/snippets/typescript.md` (merged from 3 sources)
- `skills/design/references/snippets/react.md` (merged from 3 sources)

Each merged file uses `## Creational Patterns`, `## Structural Patterns`, `## Behavioral Patterns` section headers to preserve family grouping. Content within each section is copied verbatim (no deduplication of shared imports or boilerplate).

> **Future edits**: Maintain the per-family section structure. Deduplication of shared imports or boilerplate across sections is acceptable in future edits but not required during the initial merge.

---

### B. Create consolidated pattern guides (High)

**Problem**: The three pattern SKILL.md files contain valuable workflow content (choosers, clarifying questions, implementation checklists, guardrails) beyond what the individual pattern references cover.

**Solution**: Extract the body content from each pattern SKILL.md into a standalone reference doc under design. These are reference files (no YAML frontmatter). Internal links are updated to point to new locations.

**Files created**:
- `skills/design/references/patterns-creational.md` — from `patterns-creational/SKILL.md` body
- `skills/design/references/patterns-structural.md` — from `patterns-structural/SKILL.md` body
- `skills/design/references/patterns-behavioral.md` — from `patterns-behavioral/SKILL.md` body

---

### C. Update design skill (High)

**Problem**: Design currently routes to `patterns-*` skills that will no longer exist. Its description explicitly says "NOT for applying a known specific pattern (use patterns-creational, patterns-structural, or patterns-behavioral directly)."

**Solution**: Update design to own pattern implementation guides as reference material.

**Changes to `skills/design/SKILL.md`**:

1. **Description**: Remove the "NOT for applying a known specific pattern" clause. Add: "Access implementation guides for specific patterns via references."
2. **Metadata tags**: Merge key tags from pattern skills (`creational-patterns`, `structural-patterns`, `behavioral-patterns`, `factory`, `builder`, `adapter`, `facade`, `strategy`, `observer`, `state-machine`, `decorator`, `proxy`, `singleton`)
3. **Metadata aliases**: Merge aliases from pattern skills (`factory`, `builder`, `singleton`, `prototype`, `abstract-factory`, `DI`, `dependency-injection`, `adapter`, `decorator`, `facade`, `proxy`, `wrapper`, `composite`, `bridge`, `flyweight`, `strategy`, `observer`, `state-machine`, `command`, `middleware`, `pub-sub`, `event-system`, `pipeline`, `undo-redo`)
4. **References section**: Replace pattern skill links with references to new locations. Include a direct-reference table mapping each alias to its individual pattern file (e.g., `builder` → `references/creational/builder.md`) so that pattern-specific queries skip the decision workflow and go straight to the implementation guide.

---

### D. Delete pattern skill directories (High)

After all content has been moved:
- Delete `skills/patterns-creational/`
- Delete `skills/patterns-structural/`
- Delete `skills/patterns-behavioral/`

---

### E. Eliminate Mechanics stage (High)

**Changes to taxonomy/manifest/validation**:

1. **`specs/skills-manifest.json`**: Remove `"Mechanics"` from `stages`; remove 3 pattern skill entries; bump version from 4 to 5
2. **`specs/003-taxonomy-and-workflow.md`**: Delete Mechanics section and canonical stage value
3. **`specs/002-skill-contract.md`**: Remove Mechanics from allowed stage values
4. **`specs/001-skill-library.md`**: Remove Mechanics from R-001 delivery loop
5. **`.system/skill-creator/scripts/quick_validate.py`**: Remove Mechanics from `ALLOWED_STAGES`
6. **`.system/skill-creator/scripts/check_repo_consistency.py`**: Remove Mechanics heading, `PATTERN_SKILLS` set, Mechanics from `STAGE_NAMES`, and special-case pattern validation logic

---

### F. Update cross-references (High — mechanical)

All files referencing `patterns-creational`, `patterns-structural`, `patterns-behavioral`, or Mechanics:

| File | Change |
|---|---|
| `skills/workflow/SKILL.md` | Remove Mechanics section; update recipes (`patterns-*` → `design`) |
| `skills/architecture/SKILL.md` | Update Map To Existing Skills |
| Claude Code skill description for `design` | Derived from SKILL.md frontmatter `description`; updates automatically when SKILL.md changes |
| `skills/archobs/SKILL.md` | Update pattern references (4 lines) |
| `skills/platform/SKILL.md` | Update pattern reference (1 line) |
| `skills/resilience/SKILL.md` | Update pattern reference (1 line) |
| `skills/references/structured-thinking-checklists.md` | Update `patterns-*` reference |
| `README.md` | Remove Mechanics section; update workflow statement and terminology |
| `PROMPTS.md` | Update bootstrap prompt; replace Mechanics section with design-routed prompt |
| `TUTORIAL.md` | Remove Mechanics step |
| `AGENTS.md` | Remove Mechanics from workflow grouping |
| `CONTRIBUTING.md` | Remove Mechanics from workflow grouping |
| `specs/000-index.md` | Add spec 020 and ADR 016; update taxonomy parenthetical |
| `specs/005-application-integration.md` | Remove Mechanics from loop |
| `specs/quickstart.md` | Update consistency check regex |
| `specs/decisions/001-workflow-stage-taxonomy.md` | Add "Amended by ADR 016" note |
| `specs/decisions/009-v2-skill-names-and-navigation.md` | No change — historical; old skill names preserved for decision lineage |
| `specs/templates/app-repo/AGENTS.md` | Remove Mechanics from loop |
| `.system/docs/generate_mkdocs_nav.py` | Remove dead `patterns-` display name special case |

---

## Sequencing

| Step | Change | Depends on |
|---|---|---|
| 1 | E. Validation scripts + manifest | — (must land first to avoid validation failures) |
| 2 | A. Move reference files | Step 1 |
| 3 | B. Create consolidated guides | Step 1 |
| 4 | C. Update design skill | Step 1 |
| 5 | D. Delete pattern directories | Steps 2–4 (all content moved) |
| 6 | F. Update cross-references | Step 5 |

Steps 2–4 can run in parallel. They read from the source directories that Step 5 (D) deletes, so D must wait for all three to complete.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Broken markdown links after file moves | Medium | Run `grep -rl` for stale references after each phase; validation scripts catch manifest drift |
| Validation failures during partial implementation | High | Update validation scripts FIRST (Phase 1); they're the gating check |
| Users with muscle memory for `patterns-*` skill names | Low | Aliases in design's metadata preserve discoverability; old names route to design |
| Design skill scope creep (decision → decision+reference) | Medium | Design was scoped as a decision-only skill; it now also owns implementation references. Risk: agents route implementation questions through the decision workflow instead of going straight to references. Mitigation: references are progressive disclosure (not loaded by default); aliases route pattern-specific queries directly to the right reference file |
| Reference chain lengthens for pattern-specific queries | Medium | Pre-consolidation: `patterns-creational` → `builder.md` (1 hop). Post-consolidation: `design` → `references/patterns-creational.md` → `creational/builder.md` (2 hops). Mitigation: design's alias-to-file table lets pattern-specific queries (e.g., "implement Builder") skip the consolidated guide and go directly to the individual pattern file |
| Reference chain lengthens for decision-routed queries | Medium | For queries like "decouple this notification system", the chain is: design decision workflow → `references/patterns-behavioral.md` → `behavioral/observer.md` (3 hops, up from 2). Mitigation: design's Pattern Chooser cheat sheet should link directly to individual pattern files in addition to the consolidated guides, giving decision-routed queries a 2-hop path |
| Design SKILL.md exceeds 500-line limit | Low | Pattern detail lives in references/, not inline. Design gains ~15 lines (references section) |
| Generated site has broken nav after consolidation | Low | Nav generator reads manifest; manifest update handles nav. Remove dead `patterns-` special case from generator. |

## Verification

```bash
# Structural: skills exist and are well-formed
for f in skills/*/SKILL.md; do python3 .system/skill-creator/scripts/quick_validate.py "${f%/SKILL.md}"; done

# Consistency: manifest matches filesystem
python3 .system/skill-creator/scripts/check_repo_consistency.py

# Deleted skills are gone
test ! -d skills/patterns-creational && echo "OK: creational removed"
test ! -d skills/patterns-structural && echo "OK: structural removed"
test ! -d skills/patterns-behavioral && echo "OK: behavioral removed"

# Mechanics stage removed from manifest
python3 -c "import json; m=json.load(open('specs/skills-manifest.json')); assert 'Mechanics' not in m['stages'], 'Mechanics still in stages'"

# No stale references in active docs (exclude this spec, design references, and design SKILL.md which legitimately use old names as reference paths)
active_files=(
  skills/
  specs/001-skill-library.md specs/002-skill-contract.md
  specs/003-taxonomy-and-workflow.md specs/005-application-integration.md
  specs/decisions/ specs/templates/
  specs/quickstart.md README.md PROMPTS.md AGENTS.md CONTRIBUTING.md TUTORIAL.md
)
for term in patterns-creational patterns-structural patterns-behavioral; do
  grep -rl "$term" -- "${active_files[@]}" | grep -v 'specs/020-' | grep -v 'specs/decisions/009-' | grep -v 'specs/decisions/016-' | grep -v 'design/references/' | grep -v 'design/SKILL.md'  # expect 0
done

# Design SKILL.md: old names allowed in metadata (aliases/tags) but not as link targets
grep -n 'patterns-\(creational\|structural\|behavioral\)/\|skills/patterns-' skills/design/SKILL.md  # expect 0 — no links to deleted dirs

# No Mechanics in active docs
grep -rl 'Mechanics' -- "${active_files[@]}" | grep -v 'specs/020-' | grep -v 'specs/decisions/016-'  # expect 0

# Design under progressive disclosure limit
wc -l skills/design/SKILL.md  # target < 500

# Pattern references accessible
test -f skills/design/references/patterns-creational.md && echo "OK: creational guide"
test -f skills/design/references/patterns-structural.md && echo "OK: structural guide"
test -f skills/design/references/patterns-behavioral.md && echo "OK: behavioral guide"
test -d skills/design/references/creational && echo "OK: creational dir"
test -d skills/design/references/structural && echo "OK: structural dir"
test -d skills/design/references/behavioral && echo "OK: behavioral dir"

# Merged snippet files exist
test -f skills/design/references/snippets/typescript.md && echo "OK: typescript snippets"
test -f skills/design/references/snippets/react.md && echo "OK: react snippets"
```

## Acceptance

This spec is satisfied when:

1. The verification script above passes with zero unexpected output.
2. No stale `patterns-*` skill paths or `Mechanics` references remain in active documentation.
3. The `design` skill routes pattern-specific queries (e.g., "implement the Builder pattern") to the correct individual reference file within one hop from the alias table.
4. All 22 GoF pattern reference files, 3 consolidated guides, and 2 merged snippet files are present under `skills/design/references/`.

## File Summary

| File | Action | Change |
|---|---|---|
| `specs/020-mechanics-consolidation.md` | **Create** | This spec |
| `specs/decisions/016-collapse-mechanics-into-design.md` | **Create** | ADR for Mechanics collapse decision |
| `.system/skill-creator/scripts/quick_validate.py` | **Edit** | Remove Mechanics from ALLOWED_STAGES |
| `.system/skill-creator/scripts/check_repo_consistency.py` | **Edit** | Remove Mechanics heading, PATTERN_SKILLS, STAGE_NAMES entry, special-case logic |
| `specs/skills-manifest.json` | **Edit** | Remove 3 entries + Mechanics stage; bump version |
| `skills/design/references/creational/*.md` (5) | **Move** | From patterns-creational/references/ |
| `skills/design/references/structural/*.md` (7) | **Move** | From patterns-structural/references/ |
| `skills/design/references/behavioral/*.md` (10) | **Move** | From patterns-behavioral/references/ |
| `skills/design/references/snippets/typescript.md` | **Create** | Merged from 3 pattern skills |
| `skills/design/references/snippets/react.md` | **Create** | Merged from 3 pattern skills |
| `skills/design/references/patterns-creational.md` | **Create** | Consolidated from patterns-creational/SKILL.md body |
| `skills/design/references/patterns-structural.md` | **Create** | Consolidated from patterns-structural/SKILL.md body |
| `skills/design/references/patterns-behavioral.md` | **Create** | Consolidated from patterns-behavioral/SKILL.md body |
| `skills/design/SKILL.md` | **Edit** | Absorb pattern descriptions, tags, aliases; update references |
| `skills/patterns-creational/` | **Delete** | Absorbed into design |
| `skills/patterns-structural/` | **Delete** | Absorbed into design |
| `skills/patterns-behavioral/` | **Delete** | Absorbed into design |
| `skills/workflow/SKILL.md` | **Edit** | Remove Mechanics section; update recipes |
| `skills/architecture/SKILL.md` | **Edit** | Update Map To Existing Skills |
| `skills/archobs/SKILL.md` | **Edit** | Update pattern references |
| `skills/platform/SKILL.md` | **Edit** | Update pattern reference |
| `skills/resilience/SKILL.md` | **Edit** | Update pattern reference |
| `skills/references/structured-thinking-checklists.md` | **Edit** | Update patterns-* reference |
| `specs/000-index.md` | **Edit** | Add spec 020 and ADR 016 |
| `specs/001-skill-library.md` | **Edit** | Remove Mechanics from R-001 |
| `specs/002-skill-contract.md` | **Edit** | Remove Mechanics from allowed stage values |
| `specs/003-taxonomy-and-workflow.md` | **Edit** | Remove Mechanics section and canonical value |
| `specs/005-application-integration.md` | **Edit** | Remove Mechanics from loop |
| `specs/quickstart.md` | **Edit** | Update consistency check regex |
| `specs/decisions/001-workflow-stage-taxonomy.md` | **Edit** | Add "Amended by" note |
| `specs/decisions/009-v2-skill-names-and-navigation.md` | **No change** | Historical; old skill names preserved for decision lineage |
| `specs/templates/app-repo/AGENTS.md` | **Edit** | Remove Mechanics from loop |
| `README.md` | **Edit** | Remove Mechanics section; update workflow and terminology |
| `PROMPTS.md` | **Edit** | Update bootstrap; replace Mechanics section |
| `TUTORIAL.md` | **Edit** | Remove Mechanics step |
| `AGENTS.md` | **Edit** | Remove Mechanics from grouping |
| `CONTRIBUTING.md` | **Edit** | Remove Mechanics from grouping |
| `.system/docs/generate_mkdocs_nav.py` | **Edit** | Remove dead `patterns-` display name special case |
