#!/bin/sh
# CI stub: scan this repository and upload its code map (CM-G15 evidence).
# The scan sends paths, lines, symbols, field names and env var names only; never file contents.
set -eu
npx --no-install swfte scan --ci --json
