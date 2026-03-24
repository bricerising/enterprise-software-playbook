# intel

`intel` is a lightweight intelligence collector and query tool backed by SQLite. It continuously polls curated sources (RSS, Hacker News, SEC EDGAR), classifies events into ~100 topics, and exposes the data via CLI commands and MCP tools for agent integration.

> **Part of [enterprise-software-playbook](../../README.md).**
> This tool is the implementation behind the [`intel` skill](../../skills/intel/SKILL.md).
> For the full design spec, see [`specs/006-intelligence-tool.md`](../../specs/006-intelligence-tool.md).

## What it does

- **Collects** events from RSS/Atom feeds, Hacker News, and SEC EDGAR filings
- **Classifies** each event into topics using keyword/regex matching with priority resolution
- **Extracts** article content via Mozilla Readability for richer search and classification
- **Deduplicates** across sources using canonical URL normalization
- **Queries** trends, full-text search, event browsing, and evidence packs
- **Exposes** all queries as MCP tools for direct agent integration

## Requirements

- Node.js 18+ (LTS recommended)
- npm

## Install

From the playbook repo root:

```bash
cd tools/intelligence
npm install
npm run build
npm link        # makes `intel` available globally
```

## Configure

```bash
mkdir -p ~/.config/intel ~/.local/share/intel

# Copy the example config and customize
cp config/feeds.example.yaml ~/.config/intel/config.yaml
```

Edit `~/.config/intel/config.yaml` to set your feeds, polling intervals, and (if using EDGAR) your contact email. Key settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `database` | `~/.local/share/intel/intelligence.db` | SQLite database path |
| `collector.poll_interval_seconds` | `300` | Default interval between polls |
| `collector.fetch_content` | `true` | Extract full article content |
| `collector.retention_days` | `30` | Prune events older than this |
| `collector.edgar_contact` | *(required for EDGAR)* | Email for SEC EDGAR User-Agent |
| `topics_file` | `~/.config/intel/topics.yaml` | Topic classification rules |

Copy the default topics file:

```bash
cp config/topics.yaml ~/.config/intel/topics.yaml
```

## Usage

### Seed the database

```bash
intel collect --once      # single poll cycle, then exit
```

### Run the collector

```bash
intel collect             # foreground (Ctrl+C to stop)
intel collect --daemon    # background (writes PID file)
intel collect status      # check if daemon is running
intel collect stop        # stop background daemon
```

### Install as a service

For persistent background collection, install as an OS-managed service (launchd on macOS, systemd on Linux):

```bash
./service/install.sh            # install and start
./service/install.sh uninstall  # stop and remove
```

**macOS:** Logs at `~/Library/Logs/intel-collector.log`. Check status with `launchctl print gui/$(id -u)/com.intel.collector`.

**Linux:** Logs via `journalctl --user -u intel-collector -f`. Check status with `systemctl --user status intel-collector`. Run `loginctl enable-linger $USER` once to survive logout.

### Query commands

```bash
# Trends — what topics are spiking
intel trends                         # top 10 topics, 60m window
intel trends --window 15m            # shorter window
intel trends --since 24h             # longer lookback

# Search — full-text search across all events
intel search "bedrock agents"
intel search "CVE-2026" --since 7d
intel search "kubernetes" --source rss

# Events — browse by topic, source, or time
intel events --topic ai.foundation-models --since 7d
intel events --source hackernews
intel events --id rss:aws-blog:abc123    # full content for one event

# Sources — check feed health
intel sources
intel sources --stale 30m

# Topics — list configured topics
intel topics --active

# Stats — database overview
intel stats

# Evidence pack — bounded bundle for agent synthesis
intel pack --since 24h --top 5
```

All commands output JSON by default (agent-friendly). Add `--format text` for human-readable output.

### Database maintenance

```bash
intel db schema                      # schema version info
intel db checkpoint                  # force WAL checkpoint
intel db prune                       # delete old events
intel db vacuum                      # incremental vacuum
intel db backup <path>               # online backup
intel db rebuild-fts                 # rebuild full-text search index
intel db rebuild-topic-index         # rebuild topic side table
intel db quick-check                 # integrity check
```

### MCP server

```bash
intel mcp                            # start MCP server (stdio transport)
```

Exposes `intel_trends`, `intel_search`, `intel_events`, `intel_sources`, `intel_topics`, `intel_stats`, and `intel_pack` as MCP tools. Configure in your agent's MCP settings to enable direct tool invocation without shelling out.

## Architecture

```
intel collect (daemon)  ──write──▶  intelligence.db (SQLite)
                                         │ read
intel trends / search / events  ◀────────┘
         │
         ▼
  JSON (stdout) ──▶ agent context / human reading
```

Two concerns, one binary: the **collector** writes events continuously; **query commands** read on-demand. SQLite WAL mode handles concurrent read/write safely without coordination infrastructure.

## Dependencies

| Package | Purpose |
|---------|---------|
| `better-sqlite3` | Synchronous SQLite with native bindings |
| `rss-parser` | RSS/Atom feed parsing |
| `@mozilla/readability` + `jsdom` | Article content extraction |
| `yaml` | Config file parsing |
| `zod` | Runtime type validation |
| `commander` | CLI framework |
| `@modelcontextprotocol/sdk` | MCP server |
