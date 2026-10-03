#!/bin/sh
# Scan the repository, then report the actual passing, failing or unchecked CI verification.
# The scan sends paths, lines, symbols, field names and env var names only; never file contents.
set -eu
npx --no-install swfte scan --ci --json
npx --no-install swfte verify --report --json
