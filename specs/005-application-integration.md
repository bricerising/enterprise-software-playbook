# Spec 005: Application Integration (Auto-Use Skills)

## Overview

This spec describes how to integrate **enterprise-software-playbook** into a target application repository so coding agents:

- apply the library **automatically** (even when users are conversational), and
- follow the default loop: **Define → Standardize → Harden → Verify → Mechanics**.

## Goals

- Make “use the skills” the default behavior (no need for users to name them).
- Keep overhead proportional (tiny changes stay lightweight; boundary changes get specs/contracts/tests).
- Make the skill library easy to adopt in enterprise web apps with or without a specific assistant.

## Non-goals

- Requiring a specific assistant vendor or IDE.
- Forcing a single repo layout (monorepo vs polyrepo).

## Integration Options

### Option A: Installed skills (Codex CLI / skill-aware assistants)

Use when the assistant supports external skill libraries:

1. Install/link the skill folders into the assistant's skill directory (varies by tool).
2. Also install `specs/skills-manifest.json` alongside the skills (the install scripts do this automatically). Agents use it for fast routing (trigger hints, related skills, overhead ratings).
3. Add an `AGENTS.md` file to the **application repo** that instructs agents to auto-select skills.
   - Use `specs/templates/app-repo/AGENTS.md` as a starting point (copy/paste and edit paths).
4. Start the project with the "Conversational bootstrap" prompt (`PROMPTS.md`).

### Option B: Vendor into the app repo (tool-agnostic)

Use when assistants only follow rules that live inside the repo:

1. Add this repo as a submodule or vendored copy (recommended path):
   - `tools/enterprise-software-playbook/`
2. Add `AGENTS.md` at the app repo root (copy from `specs/templates/app-repo/AGENTS.md`) and point it at:
   - `tools/enterprise-software-playbook/skills/<skill>/SKILL.md`
3. (Optional) Add a short “project rules” file for your assistant if it supports one (e.g., instructions in `.github/`), pointing to the same docs.

## Suggested App-Repo Spec Layout

For enterprise apps, encourage convergent iteration:

- `specs/`: system-wide constraints, decisions, and tasks
- `apps/<service>/spec/`: service-local spec bundle (spec/contracts/plan/tasks/quickstart)

This mirrors `spec`.

## Acceptance

Integration is successful when:

- A conversational user can request a feature/bugfix without naming skills and the agent still:
  - updates specs/contracts appropriately for boundary changes
  - standardizes repeated cross-cutting behavior via shared primitives
  - hardens boundaries (timeouts/idempotency/security/telemetry)
  - adds consumer-visible tests
- The app repo has an `AGENTS.md` (or equivalent) that instructs auto-skill routing.
