# Structured Thinking Templates (Selector Packs)

Use these packs when compact probes are not enough and you need a repeatable flow for a specific decision shape. See escalation criteria in [`structured-thinking-checklists.md`](structured-thinking-checklists.md).

Keep responses concise (usually 1-3 bullets per prompt) and attach outputs to existing artifacts (`objective function`, `decision table`, `measurement ladder`, `finish packet`).

Use template packs only for non-trivial work unless a tiny change has unusually high risk.

## Quick Selector

| Template | Use when | Primary skills |
| --- | --- | --- |
| Technical Design Review | Architecture or boundary design choices need stress-testing | `architecture`, `spec`, `review` |
| Trade-Off / Project Decision | Multiple viable options must be compared with explicit opportunity cost | `plan`, `spec`, `workflow` |
| Retrospective / Postmortem | A delivery, incident, or rollout needs learning capture | `finish`, `debug` |
| Strategic Planning / Roadmap | Multi-quarter direction or initiative portfolio is being set (edge case — most work uses `plan` directly) | `plan`, `spec`, `architecture` |
| Recommendation Brief | You must frame a PR/ADR/technical recommendation for async review | `finish`, `review`, `workflow` |

## 1) Technical Design Review

Use for non-trivial system/software design decisions before implementation locks in.

Prompts:

- Confirm fundamentals: what requirements/constraints are facts vs assumptions?
- Map system interactions: where are reinforcing/balancing feedback loops?
- Scan second-order effects: what likely changes now, next quarter, next year?
- Compare alternatives: what does each option optimize and what does it force us not to do?
- Risk + mitigation: what can fail, how will we detect/correct quickly?

Output:

- `fundamentals`
- `interaction + loops`
- `second-order effects`
- `alternatives + opportunity cost`
- `risks + mitigations`
- `recommendation`

## 2) Trade-Off / Project Decision

Use when selecting one path among several project options.

Prompts:

- Define goals/constraints: what must be true for this decision to be valid?
- List options: include status quo/no-change baseline.
- Evaluate first-order pros/cons per option.
- Evaluate second-order effects ("and then what?" across time horizons).
- Check system impact: who absorbs downsides; which loops are triggered?
- Make opportunity cost explicit: what are we saying "no" to?
- Run a bias check (sunk cost/familiarity/novelty/confirmation).

Output:

- `decision context`
- `option table`
- `short-term effects`
- `long-term effects`
- `system + stakeholder impact`
- `opportunity cost + bias risks`
- `selected option + rationale`

## 3) Retrospective / Postmortem

Use after completion, incident, or rollback to convert outcomes into controls.

Prompts:

- Facts vs expectation: what happened, and what was expected?
- Cause/effect chain: what events produced the observed outcome?
- Root causes: what failed at the assumption/process/invariant level?
- Second-order effects: what quick fixes created delayed costs (or benefits)?
- Missed opportunities: what did we skip and what did it cost?
- Actions: what one process/control change would reduce repeat risk? (flag for human to assign owner + date)

Output:

- `outcome delta`
- `cause chain`
- `root causes`
- `second-order effects`
- `missed opportunities`
- `owner-backed actions`
- `follow-up review date`

## 4) Strategic Planning / Roadmap

Edge case — use only for longer-horizon work (multi-quarter direction, initiative portfolio). Most agent-driven work fits the `plan` skill's normal implementation-planning focus; use this template only when the decision scope genuinely spans multiple teams or quarters.

Prompts:

- Vision + first principles: what core truths anchor this strategy?
- Current state + assumptions: which assumptions need validation or hedges?
- Scenario scan: if we do this, then what at 6/12/36 months?
- System map: what loops, delays, bottlenecks, and dependencies matter?
- Prioritization + opportunity cost: which initiatives make the cut and why?
- Pre-mortem: assume failure in 1-2 years; what likely caused it?
- Execution + feedback loops: what metrics/checkpoints trigger adaptation?

Output:

- `vision + principles`
- `assumptions + validation plan`
- `scenario outcomes`
- `system dynamics notes`
- `priorities + explicit de-priorities`
- `pre-mortem risks + safeguards`
- `execution rhythm + checkpoints`

## 5) Recommendation Brief

Use to frame a PR description, ADR recommendation, or technical proposal for async review. Keeps the recommendation grounded in evidence and actionable for reviewers.

Prompts:

- Core message: what action/decision is this PR/ADR requesting?
- Reviewer context: what do reviewers need to know to evaluate this (constraints, prior decisions, scope)?
- Evidence: what 2-3 facts or test results best support the recommendation?
- Counterpoints: what risks or alternatives remain and how are they mitigated?
- Open questions: what specific feedback is requested from reviewers?
- Next step: owner + date + what happens after approval.

Output:

- `core recommendation`
- `reviewer context`
- `evidence`
- `counterpoints + mitigation`
- `open questions for reviewers`
- `owner + date + next step`

## Guardrails

- Prefer one template per decision checkpoint; do not run all packs.
- Keep outputs attached to existing artifacts, not separate long-form essays.
- If the work is tiny, skip template packs and use only compact probes.
