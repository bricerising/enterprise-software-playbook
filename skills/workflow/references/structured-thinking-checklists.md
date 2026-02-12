# Structured Thinking Checklists

Use these prompts to strengthen non-trivial decisions without adding heavy process.

Keep answers short (1-3 bullets per prompt) and attach them to the existing artifacts:

- objective function
- system sketch
- decision table
- measurement ladder

Need a context-specific flow (design review, project trade-off, retrospective, roadmap, communication)? Use [`structured-thinking-templates.md`](structured-thinking-templates.md) as the selector pack.

## 1) First-Principles Assumption Audit

Use when starting plans/specs/architecture decisions.

- What is true regardless of tooling preference or team habit?
- What are assumptions (not facts), and why do we believe each one?
- Which assumption is least certain and how will we validate it quickly?

Output:
- `facts`
- `assumptions`
- `assumption-to-test-first`

## 2) Second-Order Effects Scan

Use before locking a decision.

- If we choose this option, what likely happens next week, next quarter, next year?
- What new load, toil, coupling, or failure mode might this create?
- Which stakeholder/team absorbs the downside later?

Output:
- `near-term effects`
- `long-term effects`
- `deferred cost owner`

## 3) Feedback Loop and Dynamics Check

Use for system and operations changes.

- Reinforcing loop: what could amplify in a good or bad direction?
- Balancing loop: what mechanism keeps runaway behavior in check?
- Where are delays between signal and action, and what accumulates during the delay?

Output:
- `reinforcing loop`
- `balancing loop`
- `delay + accumulation risk`

## 4) Opportunity Cost and Bias Check

Use when options are close or politically loaded.

- What are we explicitly saying "no" to with this choice?
- Are we favoring this because of sunk cost, familiarity, or novelty bias?
- What would a neutral reviewer challenge first?

Output:
- `opportunity cost`
- `bias risks`
- `external challenge`

## 5) Risk Pre-Mortem

Use before implementation of normal/big work.

- Assume this failed in 6-12 months. What likely caused failure?
- Which failure mode was most preventable?
- What one safeguard should we add now?

Output:
- `failure narrative`
- `preventable cause`
- `safeguard`

## 6) Postmortem Learning Loop

Use in finish/debug/retrospective passes.

- What happened vs what was expected?
- Which assumption failed (or held) and why?
- What one process change and one owner will reduce repeat risk?

Output:
- `outcome delta`
- `assumption update`
- `next control + owner`

## 7) Communication Framing (Decision Hand-off)

Use when reporting to stakeholders.

- Core message: what decision/action is requested now?
- Evidence: what 2-3 facts make this the best current option?
- Counterpoints: what risks remain and how are they mitigated?
- Call to action: who decides/does what, by when?

Output:
- `core recommendation`
- `evidence`
- `counterpoints + mitigation`
- `owner + date`
