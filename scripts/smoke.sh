#!/usr/bin/env bash
# Spawns the MCP server, sends a tools/list JSON-RPC request over stdio,
# and prints the names of the discovered tools.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f dist/index.js ]; then
  echo "[smoke] dist/index.js missing — running build first" >&2
  npm run build
fi

export SWFTE_API_KEY="${SWFTE_API_KEY:-smoke-fake-key}"
export SWFTE_BASE_URL="${SWFTE_BASE_URL:-https://example.invalid}"

REQ='{"jsonrpc":"2.0","id":1,"method":"tools/list"}
'

# Send a single tools/list and capture stdout.
RESP=$(printf '%s' "$REQ" | node dist/index.js 2>/dev/null | head -1 || true)

if [ -z "$RESP" ]; then
  echo "[smoke] no response — server may have crashed before responding" >&2
  exit 1
fi

echo "$RESP" | node -e '
  let s = ""; process.stdin.on("data", d => s += d);
  process.stdin.on("end", () => {
    try {
      const j = JSON.parse(s);
      const tools = j?.result?.tools ?? [];
      console.log(`[smoke] ${tools.length} tools discovered:`);
      for (const t of tools) console.log("  -", t.name);
    } catch (e) {
      console.error("[smoke] failed to parse response:", s.slice(0, 400));
      process.exit(1);
    }
  });
'
