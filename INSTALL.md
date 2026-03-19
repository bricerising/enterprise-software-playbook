# Install & Integrate

Installation differs by assistant/platform. Codex CLI and Claude Code use different local "skills" directories; Antigravity Kit-style projects load skills from `.agent/skills/`; tool-agnostic assistants often work best by vendoring this repo into the app repo.

## Codex CLI

Codex CLI is OpenAI's terminal-based coding agent: https://github.com/openai/codex

Tell Codex:

```text
Fetch and follow instructions from https://raw.githubusercontent.com/bricerising/enterprise-software-playbook/refs/heads/main/.codex/INSTALL.md
```

Manual install (shell):

1. Clone this repo anywhere you like.
2. Symlink (or copy) the skill folders into `$CODEX_HOME/skills` (commonly `~/.codex/skills`).

Example (symlinks; installs every skill folder in this repo):

```sh
git clone https://github.com/bricerising/enterprise-software-playbook.git ~/.codex/enterprise-software-playbook
mkdir -p ~/.codex/skills
for f in ~/.codex/enterprise-software-playbook/skills/*/SKILL.md; do
  ln -s "${f%/SKILL.md}" ~/.codex/skills/
done
ln -sf ~/.codex/enterprise-software-playbook/specs/skills-manifest.json ~/.codex/skills/skills-manifest.json
```

## Claude Code

Claude Code is Anthropic's terminal-based coding agent: https://docs.anthropic.com/en/docs/claude-code

Tell Claude Code:

```text
Fetch and follow instructions from https://raw.githubusercontent.com/bricerising/enterprise-software-playbook/refs/heads/main/.claude/INSTALL.md
```

Manual install (shell):

1. Clone this repo anywhere you like.
2. Symlink (or copy) the skill folders into your Claude Code skills directory (commonly `~/.claude/skills`).

Example (symlinks; installs every skill folder in this repo):

```sh
git clone https://github.com/bricerising/enterprise-software-playbook.git ~/.claude/enterprise-software-playbook
mkdir -p ~/.claude/skills
for f in ~/.claude/enterprise-software-playbook/skills/*/SKILL.md; do
  ln -s "${f%/SKILL.md}" ~/.claude/skills/
done
ln -sf ~/.claude/enterprise-software-playbook/specs/skills-manifest.json ~/.claude/skills/skills-manifest.json
```

## Antigravity

Antigravity Kit-style projects load skills from `.agent/skills/` in the project root.

Tell Antigravity:

```text
Fetch and follow instructions from https://raw.githubusercontent.com/bricerising/enterprise-software-playbook/refs/heads/main/.antigravity/INSTALL.md
```

Manual install (shell):

1. Vendor this repo into your project (submodule or clone).
2. Symlink `tools/enterprise-software-playbook/skills/*` into `.agent/skills/*`.
3. Symlink `tools/enterprise-software-playbook/specs/skills-manifest.json` to `.agent/skills/skills-manifest.json`.

## Tool-agnostic: vendor it into your project

Many assistants can only reliably follow rules that live *inside the repo they're editing*. A simple approach is to add this repo as a submodule (or just copy the files), then point your assistant at the specific skill(s) you want.

```sh
git submodule add https://github.com/bricerising/enterprise-software-playbook.git tools/enterprise-software-playbook
```

Then reference files like `tools/enterprise-software-playbook/skills/typescript/SKILL.md` in your assistant's project instructions.
