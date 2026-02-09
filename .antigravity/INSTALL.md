# Installing enterprise-software-playbook for Antigravity

Antigravity Kit-style projects load skills from `.agent/skills/` in the project root.

## Project install (recommended)

From your project root:

1) Vendor this repo into your project (pick one):

```bash
# Option A: submodule
git submodule add https://github.com/bricerising/enterprise-software-playbook.git tools/enterprise-software-playbook

# Option B: plain clone (no submodule)
# git clone https://github.com/bricerising/enterprise-software-playbook.git tools/enterprise-software-playbook
```

2) Symlink skills into `.agent/skills/`:

```bash
mkdir -p .agent/skills

for skill_dir in tools/enterprise-software-playbook/skills/*; do
  name="$(basename "$skill_dir")"
  dest=".agent/skills/$name"

  # Idempotent installs: replace existing symlinks, but don't delete real directories.
  if [ -L "$dest" ]; then
    rm "$dest"
  elif [ -e "$dest" ]; then
    echo "Skipping $dest (exists and is not a symlink)"
    continue
  fi

  ln -s "$skill_dir" "$dest"
done

# Also link the machine-readable skill index (used for routing).
ln -sf tools/enterprise-software-playbook/specs/skills-manifest.json .agent/skills/skills-manifest.json

# If you can't use symlinks, copy instead:
# cp -R tools/enterprise-software-playbook/skills/* .agent/skills/
# cp tools/enterprise-software-playbook/specs/skills-manifest.json .agent/skills/
```

## Verify

```bash
test -f .agent/skills/workflow/SKILL.md && echo "OK: workflow installed"
```

## Use

Start with the “Conversational bootstrap (auto-route)” in `PROMPTS.md`.
