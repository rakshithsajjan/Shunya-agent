#!/usr/bin/env bash
set -euo pipefail

SESSION="${SESSION:-opencode-swebench20}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_ROOT="${RESULT_ROOT:-dev-notes/benchmark/results/swebench-lite-vps-docker-opencode-20}"
LOG_PATH="$RESULT_ROOT/run.log"

cd "$ROOT"
mkdir -p "$RESULT_ROOT"

if tmux has-session -t "$SESSION" 2>/dev/null; then
	echo "tmux session already exists: $SESSION"
	echo "Attach with: tmux attach -t $SESSION"
	exit 1
fi

tmux new-session -d -s "$SESSION" \
	"node scripts/swebench-lite-run-docker.mjs --limit 20 --variant opencode --run-agent --run-evaluation --force 2>&1 | tee '$LOG_PATH'"

echo "Started $SESSION"
echo "Log: $ROOT/$LOG_PATH"
echo "Attach: tmux attach -t $SESSION"
