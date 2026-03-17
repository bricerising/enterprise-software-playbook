# Manual Fallback (Git-Only Trajectory)

When archobs artifacts are not available, extract trajectory signals directly from git. See the main [SKILL.md](../SKILL.md) for the primary workflow.

## Commands

```bash
# 1. Active directories — where development is concentrated (last 90 days)
git log --since="90 days ago" --name-only --format="" | sort | sed '/^$/d' \
  | xargs -I{} dirname {} | sort | uniq -c | sort -rn | head -30

# 2. Acceleration — compare recent vs older activity
# Last 30 days:
git log --since="30 days ago" --name-only --format="" | sort | sed '/^$/d' \
  | xargs -I{} dirname {} | sort | uniq -c | sort -rn | head -20
# Previous 30–60 days:
git log --since="60 days ago" --until="30 days ago" --name-only --format="" | sort | sed '/^$/d' \
  | xargs -I{} dirname {} | sort | uniq -c | sort -rn | head -20

# 3. Commit message themes
git log --since="30 days ago" --format="%s" | tr '[:upper:]' '[:lower:]' \
  | tr -cs '[:alpha:]' '\n' | sort | uniq -c | sort -rn | head -20

# 4. Branch signals — direct feature declarations (highest confidence)
git branch -r --sort=-committerdate | head -20
```

## Interpretation

Compare directory counts between the two 30-day windows to identify acceleration (growing) vs deceleration (shrinking).

Branch names are the highest-confidence signal — they're direct feature declarations.

Commit message prefixes (e.g. `feat(loyalty):`, `chore(db):`) identify which domains are receiving feature work vs maintenance.

## When to Use

- Archobs artifacts are missing and `archobs report` cannot be run (no Python env, no tool installed)
- Quick trajectory check where archobs overhead isn't justified
- Validating archobs findings against raw git data
