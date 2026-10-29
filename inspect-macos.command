#!/bin/bash
set -u
SPEED_ROOT="$(cd -- "$(dirname "$0")" && pwd)" || exit 1
SPEED_NODE="$SPEED_ROOT/runtime/node"
if [ -f "$SPEED_NODE" ] && [ ! -x "$SPEED_NODE" ]; then
  printf '%s\n' 'The bundled Node.js is not executable. In this package folder, run: chmod +x ./runtime/node ./*.command'
  exit 1
fi
if [ ! -f "$SPEED_NODE" ]; then
  SPEED_NODE="$(command -v node || true)"
fi
if [ -z "$SPEED_NODE" ]; then
  printf '%s\n' 'Node.js is missing. Extract the complete portable package, or install Node.js 22+.'
  exit 1
fi
cd -- "$SPEED_ROOT" || exit 1
"$SPEED_NODE" "$SPEED_ROOT/src/cli.mjs" inspect "$@"
SPEED_EXIT=$?
printf '\n%s\n' 'Inspection finished. Press Return to close this window.'
read -r _
exit "$SPEED_EXIT"
