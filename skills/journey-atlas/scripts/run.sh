#!/usr/bin/env bash
# journey-atlas pipeline: analyze → derive → (neo4j up + load) → build the atlas.
# Usage: run.sh <repo> [--no-neo4j] [--skip-analyze] [--fragment]
#   --skip-analyze  reuse graph.json (after editing review.json, only derive onward needs to rerun)
#   --no-neo4j      skip starting/loading Neo4j
#   --fragment      also write atlas-artifact.html for publishing as a claude.ai Artifact
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${1:?usage: run.sh <repo> [--no-neo4j] [--skip-analyze] [--fragment]}" && pwd)"; shift
NEO=1; ANALYZE=1; FRAG=0
for a in "$@"; do case "$a" in --no-neo4j) NEO=0;; --skip-analyze) ANALYZE=0;; --fragment) FRAG=1;; esac; done
DIR="$REPO/.journey-atlas"
mkdir -p "$DIR"
# keep the workspace out of git without touching the repo's .gitignore
if [[ -d "$REPO/.git" ]] && ! grep -qx '.journey-atlas/' "$REPO/.git/info/exclude" 2>/dev/null; then echo '.journey-atlas/' >> "$REPO/.git/info/exclude"; fi

# analyzer: config.json "analyzer" ("ts" | "python" | a path to a custom one), else python when the repo has no package.json
ANALYZER="$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.analyzer??"")}catch{}' "$DIR/config.json")"
if [[ -z "$ANALYZER" ]]; then
  if [[ ! -f "$REPO/package.json" ]] && [[ -f "$REPO/pyproject.toml" || -f "$REPO/setup.py" || -f "$REPO/setup.cfg" ]]; then ANALYZER=python; else ANALYZER=ts; fi
fi
if [[ $ANALYZE == 1 ]]; then
  echo "▸ analyze ($ANALYZER)"
  case "$ANALYZER" in
    ts)
      if [[ ! -d "$REPO/node_modules/typescript" && ! -d "$HERE/node_modules/typescript" ]]; then (cd "$HERE" && npm install --silent --no-audit --no-fund); fi
      node --max-old-space-size=8192 "$HERE/ts/analyze.mjs" --repo "$REPO" --config "$DIR/config.json" --out "$DIR/graph.json";;
    python) python3 -I "$HERE/python/analyze.py" --repo "$REPO" --config "$DIR/config.json" --out "$DIR/graph.json";;
    *) echo "custom analyzer $ANALYZER: run it yourself to write $DIR/graph.json, then rerun with --skip-analyze" >&2; exit 2;;
  esac
fi
echo "▸ derive"; node "$HERE/derive.mjs" --dir "$DIR" --repo "$REPO"
echo "▸ lenses"; node "$HERE/lenses.mjs" --dir "$DIR" | tail -1
if [[ $NEO == 1 ]]; then
  echo "▸ neo4j"; bash "$HERE/neo4j-up.sh" "$DIR" && node "$HERE/load-neo4j.mjs" --dir "$DIR" || echo "neo4j step failed; the atlas does not need it, continuing" >&2
  # load-neo4j replaces the whole project, so findings must be reloaded after it
  if [[ -f "$DIR/findings.json" || -f "$DIR/lenses.json" ]]; then echo "▸ findings"; node "$HERE/load-findings.mjs" --dir "$DIR" || echo "findings load failed" >&2; fi
fi
echo "▸ atlas"; node "$HERE/build-atlas.mjs" --dir "$DIR"
[[ $FRAG == 1 ]] && node "$HERE/build-atlas.mjs" --dir "$DIR" --fragment
echo "done: $DIR/atlas.html"
