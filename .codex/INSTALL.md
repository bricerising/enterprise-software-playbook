# Installing enterprise-software-playbook for Codex

Quick setup to install the skills into your personal Codex skills directory.

## Install

1) Clone this repo (or update it):

```bash
mkdir -p ~/.codex

if [ -d ~/.codex/enterprise-software-playbook/.git ]; then
  git -C ~/.codex/enterprise-software-playbook pull
else
  git clone https://github.com/bricerising/enterprise-software-playbook.git ~/.codex/enterprise-software-playbook
fi
```

2) Symlink skills into `~/.codex/skills/`:

```bash
mkdir -p ~/.codex/skills

for skill_dir in ~/.codex/enterprise-software-playbook/skills/*; do
  name="$(basename "$skill_dir")"
  dest="$HOME/.codex/skills/$name"

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
ln -sf ~/.codex/enterprise-software-playbook/specs/skills-manifest.json ~/.codex/skills/skills-manifest.json
```

3) Install tools:

```bash
# archobs — architecture observability CLI (requires Python 3.11+)

# Install Codanna (provides semantic search embeddings)
# macOS
brew install codanna
# Linux / other
# curl -fsSL --proto '=https' --tlsv1.2 https://install.codanna.sh | sh

pip install -e "$HOME/.codex/enterprise-software-playbook/tools/archobs[full]"
```

## Verify

```bash
test -f ~/.codex/skills/workflow/SKILL.md && echo "OK: workflow installed"
command -v codanna >/dev/null 2>&1 && echo "OK: codanna installed"
archobs --help >/dev/null 2>&1 && echo "OK: archobs installed"
```

## Use

Start with the “Conversational bootstrap (auto-route)” in `PROMPTS.md`.
