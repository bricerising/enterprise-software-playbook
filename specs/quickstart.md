# Quickstart (Specs + Skills)

This repo is designed to be iterated on locally without network access.

## Validate Skills

Validate a single skill:

```sh
python3 .system/skill-creator/scripts/quick_validate.py skills/<skill-folder>
```

Validate every skill folder in the repo:

```sh
for f in skills/*/SKILL.md; do python3 .system/skill-creator/scripts/quick_validate.py "${f%/SKILL.md}"; done
```

Validate repo-level docs/skill navigation consistency:

```sh
python3 .system/skill-creator/scripts/check_repo_consistency.py
```

## Package Skills (Optional)

Package a skill into `dist/<skill-name>.skill`:

```sh
python3 .system/skill-creator/scripts/package_skill.py skills/<skill-folder> ./dist
```

## Create a New Skill (Optional)

Initialize a new skill folder:

```sh
python3 .system/skill-creator/scripts/init_skill.py <skill-name> --path skills --resources scripts,references --examples
```

Then:

1. Edit `skills/<skill-name>/SKILL.md`
2. Add only the minimal `references/` and `scripts/` needed
3. Validate and update `README.md` + `PROMPTS.md`

## Common Maintenance

Find “taxonomy drift” (e.g., legacy terms):

```sh
rg -n "\\bGoF\\b|architecture pattern|design pattern" -S .
```

Confirm the workflow-stage grouping is consistent:

```sh
rg -n "Define \\(what are we building\\?\\)|Standardize \\(make it consistent\\)|Harden \\(make it survive reality\\)|Verify \\(prove behavior\\)" -S README.md PROMPTS.md
```
