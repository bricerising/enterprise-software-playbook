#!/usr/bin/env bash
# Make a Neo4j available for journey-atlas and write its connection to <dir>/neo4j.env.
# Order of preference: an env file from a previous run → NEO4J_URL/NEO4J_PASSWORD already exported →
# a running journey-atlas container → start a new container with Docker.
# Usage: neo4j-up.sh <dir>   (dir = the repo's .journey-atlas folder)
set -euo pipefail
DIR="${1:-.journey-atlas}"
mkdir -p "$DIR"
ENV_FILE="$DIR/neo4j.env"
NAME="${NEO4J_CONTAINER:-journey-atlas-neo4j}"

ping() { # url user password
  curl -s -o /dev/null -w '%{http_code}' -u "$2:$3" -H 'Content-Type: application/json' \
    -d '{"statements":[{"statement":"RETURN 1"}]}' "$1/db/neo4j/tx/commit" 2>/dev/null || true
}
write_env() { printf 'NEO4J_URL=%s\nNEO4J_USER=%s\nNEO4J_PASSWORD=%s\n' "$1" "$2" "$3" > "$ENV_FILE"; chmod 600 "$ENV_FILE"; echo "neo4j ready at $1 (credentials in $ENV_FILE)"; }

# 1. a previous run's connection
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  if [[ "$(ping "$NEO4J_URL" "$NEO4J_USER" "$NEO4J_PASSWORD")" == "200" ]]; then echo "neo4j ready at $NEO4J_URL (from $ENV_FILE)"; exit 0; fi
fi
# 2. connection given in the environment
if [[ -n "${NEO4J_URL:-}" && -n "${NEO4J_PASSWORD:-}" ]]; then
  if [[ "$(ping "$NEO4J_URL" "${NEO4J_USER:-neo4j}" "$NEO4J_PASSWORD")" == "200" ]]; then write_env "$NEO4J_URL" "${NEO4J_USER:-neo4j}" "$NEO4J_PASSWORD"; exit 0; fi
  echo "NEO4J_URL is set but did not answer with those credentials" >&2
fi
command -v docker >/dev/null || { echo "Docker is not installed and no reachable Neo4j was given. Install Docker or export NEO4J_URL, NEO4J_USER and NEO4J_PASSWORD." >&2; exit 3; }
docker info >/dev/null 2>&1 || { echo "Docker is installed but not running. Start Docker Desktop (or the docker daemon) and retry." >&2; exit 3; }

# 3. our own container, possibly stopped
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  docker start "$NAME" >/dev/null
  PASS="$(docker inspect "$NAME" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's#^NEO4J_AUTH=neo4j/##p')"
  HTTP_PORT="$(docker port "$NAME" 7474/tcp | head -1 | sed 's/.*://')"
else
  # 4. a new container on free ports
  PASS="ja-$(od -An -N12 -tx1 /dev/urandom | tr -d " \n")"
  HTTP_PORT=7474; BOLT_PORT=7687
  port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
  if port_busy 7474 || port_busy 7687; then HTTP_PORT=17474; BOLT_PORT=17687; fi
  docker run -d --name "$NAME" -p "$HTTP_PORT:7474" -p "$BOLT_PORT:7687" \
    -e NEO4J_AUTH="neo4j/$PASS" -e NEO4J_server_memory_heap_max__size=2G \
    -v "$NAME-data:/data" neo4j:5 >/dev/null
  echo "started container $NAME (browser: http://localhost:$HTTP_PORT, bolt: $BOLT_PORT)"
fi
URL="http://localhost:$HTTP_PORT"
for _ in $(seq 1 90); do
  if [[ "$(ping "$URL" neo4j "$PASS")" == "200" ]]; then write_env "$URL" neo4j "$PASS"; exit 0; fi
  sleep 2
done
echo "neo4j did not become ready at $URL; check: docker logs $NAME" >&2
exit 4
