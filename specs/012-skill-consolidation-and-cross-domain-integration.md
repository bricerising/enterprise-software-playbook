# Spec 012: Skill Consolidation & Cross-Domain Integration

## Problem

The Define stage has 10 skills — the largest of any stage — with two pairs that split single user workflows across artificial boundaries:

1. **trajectory + forecast**: Both answer "what's next?" but are separated by data source (git/archobs vs intel feeds). Users asking "what should we prepare for?" need both but must invoke them separately. The workflow recipe `archobs → trajectory → forecast → plan` runs them sequentially with no composition — the LLM mentally merges two independent reports.

2. **intel + brief**: Intel "produces tailored intelligence briefs" and brief "shapes intel signals into audience-aware briefs." They share identical prerequisites (copy-pasted), always run in sequence, and nobody invokes one without the other. Intel already calls itself "Intelligence Briefs" in its heading.

Additionally, archobs and intel/forecast serve complementary decision-making needs (structural reality vs environmental reality) that are never composed:

3. **Forecast integration is stub-level** in architecture, plan, and design — identical boilerplate ("if forecast data is available, check lifecycle phases and chain decay_weighted_support...") with no concrete query patterns, trigger conditions, or decision mapping.

4. **Spec skill has no archobs integration** despite being the only Define-stage skill that pins contracts and boundaries — the very things archobs measures.

5. **No cross-domain synthesis exists** — there is no path from "archobs shows high coupling to library X" to "forecast shows X is in a decaying lifecycle phase" to "prioritize extraction."

## Goal

1. Merge trajectory into forecast — one skill for all forward-looking intelligence (internal + external)
2. Merge brief into intel — one skill for signal gathering + audience-aware presentation
3. Replace vague forecast stubs in architecture/plan/design with concrete integration points
4. Add archobs integration to the spec skill
5. Update workflow recipes for conditional composition instead of linear sequences
6. Reduce Define stage from 10 to 8 skills with clearer boundaries

## Non-Goals

- Changing the archobs or intel tool implementations (CLI, database, pipeline)
- Rebuilding the removed risk-overlay at the tool level (composition stays in the skill layer)
- Merging archobs with anything (well-scoped, no change needed)
- Changing skills outside the Define stage

## Anti-Goals

- Making forecast mandatory for every architecture/plan/design invocation (proportionality matters)
- Creating a combined "super-skill" that does everything (the merged skills must stay focused)
- Mechanical threshold composition (e.g., "risk > 0.5 + reinforcing loop = compound risk") — the skill should guide the LLM's judgment, not replace it

---

## Changes

### A. Merge trajectory into forecast (High)

**Problem**: Trajectory and forecast are both forward-looking prediction skills separated by data source. The "full situational awareness" recipe requires users to know they need both and to invoke them sequentially. The removed `change-trajectory` intel module (commit 7ebbefd) already showed the boundary was artificial — it was removed because "archobs already provides everything trajectory needs."

**Solution**: Forecast absorbs trajectory as its "internal engine." The merged skill has three modes: internal (git + archobs), external (intel feeds), and combined (both, with cross-referencing).

**Skill changes** (`skills/forecast/SKILL.md`):

1. **Update frontmatter**:
   - Description: "Predict likely next developments from internal development patterns (git history, archobs clusters) and external signals (intel feeds). Use when you need forward-looking intelligence — what's GOING to happen, not what already happened. NOT for gathering raw signals (use intel); NOT for architecture analysis (use archobs); NOT for implementation planning (use plan)."
   - Remove "NOT for internal development trajectory or predicting next features from git history (use trajectory)" clause
   - Merge tags: add `trajectory`, `momentum`, `velocity`, `feature-prediction`, `git-history`, `development-patterns`, `change-analysis`, `adjacency`
   - Merge aliases: add `trajectory`, `momentum`, `velocity`, `feature-prediction`

2. **Add three-mode chooser** replacing the current chooser table:

   | Question | Mode |
   |---|---|
   | "What are we likely to build next?" | **Internal** |
   | "Where is development concentrated?" | **Internal** |
   | "What external shifts should we prepare for?" | **External** |
   | "What's going to happen next?" (general) | **Combined** |
   | "What's the full picture?" | **Combined** |
   | "What happened recently?" | `intel` |
   | "How is our codebase structured?" | `archobs` |
   | "Plan the implementation" | `plan` |

3. **Add Internal Engine section** with the trajectory workflow:
   - Same-session fast path (archobs velocity, edges, branch signals, commit themes)
   - Velocity signal interpretation (compound velocity matrix, per-file change intensity, convergent hub pattern, is_emerging flag, test-only clusters, cross-cluster initiative detection)
   - Feature adjacency reasoning table
   - Manual fallback (when archobs is not available)
   - Combined archobs + trajectory workflow

4. **Add Combined Mode section** — this is the new integration point:
   - Run internal and external engines in parallel
   - Cross-reference: cluster velocity × lifecycle phase of ecosystem dependencies
   - Surface compound signals: "cluster X has high acceleration AND its primary ecosystem dependency shows a reinforcing loop"
   - Combined output template merging both perspectives

5. **Rename current workflow to "External Engine"** for clarity — no content changes to the external workflow itself.

6. **Move dense reference material** to `skills/forecast/references/`:
   - `references/velocity-interpretation.md` — compound velocity matrix, per-file intensity, convergent hub, is_emerging, test-only clusters, cross-cluster initiative detection
   - `references/feature-adjacency.md` — full adjacency pattern table
   - `references/manual-fallback.md` — git-only trajectory extraction when archobs is unavailable
   - Keep the core workflow, chooser, and output template in SKILL.md (target < 500 lines per progressive disclosure convention)

7. **Update output template** to support all three modes:
   - Internal mode: current trajectory output template
   - External mode: current forecast output template
   - Combined mode: unified template with sections for "Development momentum", "Ecosystem signals", "Cross-domain synthesis", and "Recommended action"

**Folder changes**:
- Delete `skills/trajectory/SKILL.md`
- Delete `skills/trajectory/` directory
- Create `skills/forecast/references/velocity-interpretation.md`
- Create `skills/forecast/references/feature-adjacency.md`
- Create `skills/forecast/references/manual-fallback.md`

---

### B. Merge brief into intel (High)

**Problem**: Intel gathers signals and produces briefs. Brief takes intel signals and reshapes for audiences. They share identical prerequisites, always run in sequence, and are two halves of one workflow. Intel's aliases already include "brief" and "briefing."

**Solution**: Intel absorbs brief's audience templates. The merged skill has a two-axis chooser: content type (topic brief, trend scan, evidence pack, source check) × audience (practitioner, executive, engineering, decision, daily digest).

**Skill changes** (`skills/intel/SKILL.md`):

1. **Update frontmatter**:
   - Description: "Gather and shape intelligence signals from collected feeds (RSS, HackerNews, Lobsters, EDGAR) into audience-aware output. Use when you need current context on a technology, industry trend, or domain — or when you need to present signals to a specific audience. NOT for forward-looking predictions (use forecast); NOT for architecture analysis (use archobs); NOT for writing specs (use spec)."
   - Merge tags: add `audience`, `executive`, `engineering`, `decision`, `digest`, `synthesis`, `presentation`, `stakeholder`
   - Remove `brief` and `briefing` from aliases (they route here now as the primary skill)

2. **Expand chooser to two axes**:

   **Content type** (what data to gather):
   | Type | When to use |
   |---|---|
   | **Topic brief** (default) | "What's happening with X?" |
   | **Trend scan** | General landscape check |
   | **Evidence pack** | Feeding context into another skill |
   | **Source check** | Verify data quality |

   **Audience** (how to present — default: practitioner):
   | Audience | Shape | When to use |
   |---|---|---|
   | **Practitioner** (default) | Ranked signals, trend context, gaps, so what | Feeding into your own work |
   | **Executive** | 3-5 bullet TL;DR, "so what", recommended action, risk flags | Status updates, steering meetings |
   | **Engineering** | Signals mapped to stack, migration/deprecation implications | Sprint planning, tech radar |
   | **Decision** | Evidence mapped to options, recommendation | Buy-vs-build, adopt-vs-wait, vendor selection |
   | **Daily digest** | Top-5 signals, one-line commentary | Morning standup, async channel |
   | **Architecture decision** | Archobs risk + forecast lifecycle × decision options | Technology adoption, boundary redesign |

3. **Add Architecture Decision brief type** (new):
   - Inputs: intel signals + archobs cluster/risk data + forecast lifecycle data
   - Requires: archobs artifacts available (or skip structural section with warning)
   - Template:
     - **Decision statement**: what we're choosing between
     - **Structural context** (from archobs): cluster coupling, boundary health, risk scores for affected areas
     - **Ecosystem context** (from forecast): lifecycle phase, chain activity, system dynamics for relevant technologies
     - **Cross-domain synthesis**: where structural reality and ecosystem signals align or conflict
     - **Options matrix**: each option scored against structural + ecosystem evidence
     - **Recommendation**: selected option with confidence level
     - **Next skill**: `plan` or `spec`

4. **Merge audience output templates** from brief (executive, engineering, decision, daily digest) into the Output Template section of intel. No content changes to the templates themselves.

5. **Merge clarifying questions** from brief into intel's existing clarifying questions section. Add: "Who is the audience?" and "Which brief type fits?"

6. **Merge guardrails** from brief: "Executive briefs must be readable by non-technical stakeholders", "Do not mix brief types".

**Folder changes**:
- Delete `skills/brief/SKILL.md`
- Delete `skills/brief/` directory

---

### C. Cross-domain integration in architecture (Medium)

**Problem**: Architecture's forecast references are vague conditional stubs — "if forecast data is available, check lifecycle phases and chain decay_weighted_support" — with no trigger condition, query pattern, or decision mapping.

**Solution**: Replace the stubs with a concrete "Ecosystem Pressure Check" that triggers conditionally and maps forecast output to architecture decisions.

**Changes to `skills/architecture/SKILL.md`**:

1. **Add step 0b: Ecosystem Pressure Check** (after the existing archobs step 0, before boundary decisions):

   **Trigger condition** — run this step when the architecture decision involves ANY of:
   - Adopting or replacing a technology
   - Defining boundaries around external dependencies
   - Planning work with a time horizon > 6 months

   **Query pattern**:
   ```bash
   intel forecast    # external engine — lifecycle phases and chains
   ```

   **Decision mapping** (lifecycle phase → boundary design):
   | Lifecycle phase | Boundary recommendation |
   |---|---|
   | emerging | Keep boundaries loose — expect interface churn, use Adapter |
   | accelerating | Good adoption window — design against current APIs |
   | peaking / stable | Design for longevity — pin versions confidently |
   | decaying | Wall off behind Facade — minimize coupling surface |

   **Dynamic signals**:
   | Dynamics signal | Architecture implication |
   |---|---|
   | reinforcing loop detected | Area is compounding — delaying adoption widens the gap |
   | dampening detected | Growth arrested — don't over-invest in integration depth |
   | accumulation detected | Pressure building — define boundary before forced migration |

2. **Replace the three existing forecast stubs** (in steps 6 and 9) with references to step 0b: "Cross-reference with ecosystem pressure check from step 0b (if applicable)."

---

### D. Cross-domain integration in plan (Medium)

**Problem**: Plan loads archobs risk scores and orders tasks by structural risk, but ignores environmental risk. A file with `risk = 0.6` wrapping a decaying library is more urgent than one with `risk = 0.7` in a stable ecosystem.

**Solution**: Add a "Risk Amplification" step that cross-references archobs risk with forecast lifecycle phase when the plan involves external dependencies.

**Changes to `skills/plan/SKILL.md`**:

1. **Add step 4b: Risk Amplification** (after loading archobs data in step 4, before ordering tasks):

   **Trigger condition** — run when any high-risk files/clusters from archobs touch external dependencies or technology choices.

   **Query pattern**:
   ```bash
   intel forecast    # lifecycle phases for relevant dependencies
   ```

   **Cross-reference matrix**:
   | Archobs signal | Forecast signal | Interpretation | Priority adjustment |
   |---|---|---|---|
   | High risk (>0.5) | reinforcing loop | Compound risk — structural debt accelerating | Prioritize first |
   | High risk (>0.5) | stable / decaying | Structural debt, stable ecosystem | Schedule normally |
   | High leakage (>0.20) | diverging lifecycles | Boundary spans ecosystems moving in different directions | Prioritize boundary extraction |
   | Low risk | emerging / accelerating | Emerging opportunity | Plan adoption path before coupling grows organically |
   | High coupling to dependency | decaying phase | Dependency is dying — extraction is urgent | Elevate to P0 |

2. **Replace the two existing forecast stubs** (in step 6) with a reference to step 4b.

---

### E. Cross-domain integration in design (Medium)

**Problem**: Design maps archobs xnbr/hubness to patterns (high xnbr → Facade) but ignores whether the wrapped dependency is growing, stable, or dying. A Facade around a decaying dependency is urgent isolation; a Facade around an accelerating ecosystem is premature abstraction.

**Solution**: Add a "Pattern Longevity Check" when the selected pattern wraps an external dependency.

**Changes to `skills/design/SKILL.md`**:

1. **Add step 2b: Pattern Longevity Check** (after pattern selection in step 2, before implementation):

   **Trigger condition** — run when the selected pattern wraps or isolates an external dependency.

   **Query pattern**:
   ```bash
   intel forecast    # lifecycle phase for the wrapped dependency
   ```

   **Decision mapping** (lifecycle phase → pattern adjustment):
   | Lifecycle phase | Pattern guidance |
   |---|---|
   | decaying | Adapter/Facade is urgent — isolate the dying dependency, prepare swap interface |
   | accelerating | Lighter wrapping — the API is still finding its shape; heavy abstraction fights upstream changes |
   | stable | Any pattern works — optimize for internal coupling concerns from archobs |
   | emerging | Adapter with narrow surface — expect rapid breaking changes |

   **Compound signal** (archobs × forecast):
   | Archobs signal | Forecast signal | Implication |
   |---|---|---|
   | High xnbr + external dependency | decaying | Urgent extraction candidate — the bridge is to a sinking island |
   | High hubness + external dependency | accelerating | Monitor — high fan-in to a moving target risks cascading breakage |
   | High leakage between clusters | diverging lifecycles | Split is natural — the ecosystems are pulling apart |

2. **Replace the two existing forecast stubs** (in step 6) with a reference to step 2b.

---

### F. Add archobs integration to spec (Medium)

**Problem**: Spec is the only Define-stage skill that pins contracts and boundaries, yet it has no archobs integration. A spec that introduces a contract cutting across a high-cohesion archobs cluster is fighting the codebase's natural structure.

**Solution**: Add step 0 (archobs data load) matching the pattern in architecture, plan, and design. Add forecast-driven versioning guidance.

**Changes to `skills/spec/SKILL.md`**:

1. **Add step 0: Load archobs data** (before spec writing begins):

   ```bash
   archobs show clusters --format json
   archobs show risks --format json
   ```

   **Use in spec writing**:
   - Ensure spec contracts honor existing cluster boundaries. If the spec introduces a new boundary that cuts across a cluster with `cohesion > 0.60`, flag the conflict — the spec is fighting natural structure.
   - Files with `risk > 0.5` in the spec's scope warrant stricter acceptance criteria and testing requirements.
   - Clusters with `leakage > 0.20` that the spec touches may need explicit boundary contracts (interface types, Facade).

   If archobs artifacts are missing: run `archobs report` or note as a gap. Do not block spec writing on archobs — the spec can be amended when data becomes available.

2. **Add step 0b: Versioning guidance from forecast** (conditional):

   **Trigger condition** — run when the spec pins an external dependency contract (API version, SDK, protocol).

   **Query pattern**:
   ```bash
   intel forecast    # lifecycle phase for the dependency
   ```

   **Decision mapping**:
   | Lifecycle phase | Versioning strategy |
   |---|---|
   | accelerating | Design for version negotiation — expect API churn, use flexible contracts |
   | stable | Pin versions confidently — stable API surface |
   | decaying | Include migration timeline in spec — plan for replacement |
   | emerging | Use narrow contract surface — only pin what you use today |

---

### G. Workflow recipe updates (Medium)

**Problem**: Workflow recipes are linear sequences that can't express conditional composition. The "full situational awareness" recipe requires 4 separate skill invocations where 2 would suffice after the merges. There's no outside-in recipe for technology adoption.

**Solution**: Update recipes to reflect the merged skills and add conditional composition.

**Changes to `skills/workflow/SKILL.md`**:

1. **Update recipe sequences**:

   ```
   # Before:
   Feature roadmap:     archobs → trajectory → plan
   Full situational:    archobs → trajectory → forecast → plan

   # After:
   Feature roadmap:     archobs → forecast (internal) → plan
   Full situational:    archobs → forecast (combined) → plan
   ```

2. **Add conditional composition guidance** in the Define stage section:

   When archobs reveals high coupling to external dependencies (files with high `xnbr` bridging to third-party code, or clusters labeled with external technology names):
   - Invoke `forecast` in combined mode (not just internal)
   - Topics for the external engine are derived from archobs cluster labels and high-xnbr file paths
   - This replaces the removed risk-overlay with skill-layer composition

3. **Add new recipe: "Technology adoption assessment"** (outside-in):
   ```
   intel → forecast (external) → archobs → architecture → plan
   ```
   Start with ecosystem signals, then check internal readiness. Use when the question is "should we adopt X?" rather than "what should we build next?"

4. **Update all recipe references** — replace `trajectory` with `forecast (internal)`, remove `brief` references (intel now handles audience-aware output).

5. **Remove the "Internal development signals" redirect table** from forecast (it was routing to trajectory, which no longer exists as a separate skill).

---

### H. Manifest and metadata updates (High — mechanical)

**Changes to `specs/skills-manifest.json`**:

1. **Remove** `trajectory` and `brief` entries from `skills` object
2. **Remove** `trajectory` and `brief` from `stages.Define` array
3. **Update `forecast` entry**:
   - Merge tags from trajectory: add `trajectory`, `momentum`, `velocity`, `feature-prediction`, `git-history`, `development-patterns`, `change-analysis`, `adjacency`
   - Update trigger: "Need forward-looking intelligence — predict likely next developments from internal development patterns (git + archobs) or external signals (intel feeds)."
   - Update related: `["intel", "archobs", "plan", "spec", "architecture", "design"]` (remove trajectory, remove brief, add design)
4. **Update `intel` entry**:
   - Merge tags from brief: add `audience`, `executive`, `engineering`, `decision`, `digest`, `synthesis`, `presentation`, `stakeholder`
   - Update trigger: "Need current signal on a technology, vendor, or industry trend — or need to present signals to a specific audience."
   - Update related: `["forecast", "plan", "spec", "architecture", "archobs"]` (remove brief)
5. **Update `archobs` related**: remove `trajectory`, keep everything else
6. **Update `spec` related**: add `archobs` → `["plan", "architecture", "testing", "archobs"]`
7. **Update any other skill** that references trajectory or brief in `related` arrays
8. **Bump** manifest version to 3, update date

**Changes to other skill descriptions** (NOT-for clause updates):
- `archobs`: remove "NOT for predicting features (use trajectory)" if present — replace with "NOT for forward-looking predictions (use forecast)"
- Any skill referencing brief: update to reference intel
- Any skill referencing trajectory: update to reference forecast

---

## Priority and Sequencing

| Priority | Change | Rationale |
|---|---|---|
| P0 | H. Manifest and metadata | Mechanical, unblocks validation scripts |
| P0 | A. Merge trajectory → forecast | Highest user-facing friction, enables combined mode |
| P0 | B. Merge brief → intel | Eliminates duplicate prerequisites and split workflow |
| P1 | G. Workflow recipe updates | Depends on A and B completing first |
| P1 | C. Architecture cross-domain integration | Highest-value cross-domain integration point |
| P1 | D. Plan cross-domain integration | Second-highest-value, enables risk amplification |
| P1 | E. Design cross-domain integration | Completes the pattern longevity check |
| P2 | F. Spec archobs + forecast integration | Lower urgency — spec is usable without archobs, but should be addressed |

Sequencing: H first (mechanical foundation), then A and B in parallel (independent merges), then G (depends on A + B), then C/D/E in parallel (independent skill edits), then F.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Merged forecast SKILL.md exceeds 500-line progressive disclosure limit | High | Move velocity interpretation, feature adjacency table, and manual fallback to `references/` immediately (Change A, item 6) |
| Users with existing workflow muscle memory for `trajectory` / `brief` | Low | Aliases in metadata preserve discoverability; NOT-for clauses in other skills redirect correctly |
| Cross-domain integration steps slow down simple architecture/plan/design invocations | Medium | All new steps have explicit trigger conditions — they are skipped when the decision doesn't involve external dependencies or long time horizons |
| Combined forecast mode produces overly long output | Medium | Combined output template has a "cross-domain synthesis" section that forces concise integration rather than appending two full reports |
| `check_repo_consistency.py` fails after skill deletion | High | Update manifest (Change H) first; run validation after each merge to catch drift |

## Verification

After all changes:

```bash
# Structural: skills exist and are well-formed
python .system/skill-creator/scripts/quick_validate.py skills/forecast/SKILL.md
python .system/skill-creator/scripts/quick_validate.py skills/intel/SKILL.md

# Structural: deleted skills are gone
test ! -d skills/trajectory && echo "OK: trajectory removed"
test ! -d skills/brief && echo "OK: brief removed"

# Consistency: manifest matches filesystem
python .system/skill-creator/scripts/check_repo_consistency.py

# Manifest: no stale references
grep -c '"trajectory"' specs/skills-manifest.json   # expect 0
grep -c '"brief"' specs/skills-manifest.json         # expect 0

# Skill descriptions: no stale routing clauses
grep -rl 'use trajectory' skills/                    # expect 0 results
grep -rl 'use brief' skills/                         # expect 0 results

# Line count: merged skills respect progressive disclosure
wc -l skills/forecast/SKILL.md                       # target < 500
wc -l skills/intel/SKILL.md                          # target < 500

# Cross-domain: architecture/plan/design have concrete integration
grep -l 'Ecosystem Pressure Check' skills/architecture/SKILL.md   # expect 1
grep -l 'Risk Amplification' skills/plan/SKILL.md                 # expect 1
grep -l 'Pattern Longevity Check' skills/design/SKILL.md          # expect 1

# Spec: archobs integration present
grep -l 'archobs show clusters' skills/spec/SKILL.md              # expect 1
```

## File Summary

| File | Action | Change |
|---|---|---|
| `skills/forecast/SKILL.md` | **Major edit** | Absorb trajectory; add internal/external/combined modes; update chooser, workflow, output template |
| `skills/forecast/references/velocity-interpretation.md` | **Create** | Moved from trajectory: compound velocity matrix, convergent hub, is_emerging, test-only clusters |
| `skills/forecast/references/feature-adjacency.md` | **Create** | Moved from trajectory: full adjacency pattern table |
| `skills/forecast/references/manual-fallback.md` | **Create** | Moved from trajectory: git-only extraction when archobs unavailable |
| `skills/trajectory/SKILL.md` | **Delete** | Absorbed into forecast |
| `skills/intel/SKILL.md` | **Major edit** | Absorb brief; add audience axis, architecture decision brief type |
| `skills/brief/SKILL.md` | **Delete** | Absorbed into intel |
| `skills/architecture/SKILL.md` | **Edit** | Add step 0b (Ecosystem Pressure Check); replace forecast stubs |
| `skills/plan/SKILL.md` | **Edit** | Add step 4b (Risk Amplification); replace forecast stubs |
| `skills/design/SKILL.md` | **Edit** | Add step 2b (Pattern Longevity Check); replace forecast stubs |
| `skills/spec/SKILL.md` | **Edit** | Add step 0 (archobs) and step 0b (forecast versioning) |
| `skills/workflow/SKILL.md` | **Edit** | Update recipes, add conditional composition, add technology adoption recipe |
| `specs/skills-manifest.json` | **Edit** | Remove trajectory/brief; update forecast/intel entries; bump version |
| `specs/000-index.md` | **Edit** | Add this spec to the index |
