#!/usr/bin/env bash
set -euo pipefail

SESSION="${SESSION:-shunya-retry}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT"

if tmux has-session -t "$SESSION" 2>/dev/null; then
	echo "tmux session already exists: $SESSION"
	echo "Attach with: tmux attach -t $SESSION"
	exit 1
fi

echo "Compiling latest TypeScript changes..."
npm run build

tmux new-session -d -s "$SESSION" \
	"node scripts/swebench-lite-run-docker.mjs --config dev-notes/benchmark/suites/shunya-retry-tasks.json --run-agent --run-evaluation --force"

echo "Started $SESSION"
echo "Attach: tmux attach -t $SESSION"
