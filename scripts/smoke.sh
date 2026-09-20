#!/usr/bin/env bash
# Run the same handshake, schema and negative-call checks as CI.
set -euo pipefail
cd "$(dirname "$0")/.."
exec npm run smoke:protocol
