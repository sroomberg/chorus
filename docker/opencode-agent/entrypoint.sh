#!/usr/bin/env bash
set -euo pipefail

PORT="${OPENCODE_PORT:-4096}"
NAME="${AGENT_NAME:-agent}"

echo "chorus-docker-agent: starting ${NAME} on :${PORT}"
echo "  CHORUS_RELAY_HOST=${CHORUS_RELAY_HOST:-unset}"
echo "  CHORUS_EXTERNAL_RELAY=${CHORUS_EXTERNAL_RELAY:-}"
echo "  CHORUS_PUBLIC_HOST=${CHORUS_PUBLIC_HOST:-unset}"

exec opencode serve --port "${PORT}" --hostname 0.0.0.0
