# Progress

## 2026-06-30

- Split benchmark instrumentation from Shunya compression: vanilla Pi now loads
  only the shared goal plugin plus `cost-logger.ts`, while Shunya loads the same
  goal/logger pair plus `shunya.ts` and `--shunya`. Set up `/opt/Shunya-agent`
  on the Hermes VPS, installed dependencies and pinned `@narumitw/pi-goal@0.9.2`,
  built the workspace there using checked-in generated model catalogs, and made
  the SWE-bench runner resolve the goal plugin from either the repo-local path
  or the standard Pi user package path.
- Recorded the fairness issue from the first one-task SWE-bench Lite run:
  although both Pi Native and Shunya resolved `django__django-10914`, the next
  benchmark must run the agents inside matched Docker task containers so host
  Python, installed tools, warmed caches, dependency setup, workspace state, and
  order effects do not contaminate the token/cost comparison. Updated
  `dev-notes/benchmark/benchmarking-first-principles.md` to require the same
  container image digest, fresh base-commit workspace, env vars, PATH, file
  permissions, local-test policy, and order-balanced runs.
- Anchored the benchmark plan to the upstream `swe-bench/experiments` evidence
  layout and pinned the first local SWE-bench Lite verification tasks:
  `django__django-10914`, `django__django-10924`, and
  `django__django-11001`. The initial Astropy candidates were rejected for the
  local smoke subset because their `linux/amd64` image build was unstable under
  Apple Silicon emulation.
- Added `dev-notes/benchmark/swebench-lite-v1-tasks.json`,
  `dev-notes/benchmark/schema/run-trace.schema.json`, and
  `scripts/swebench-lite-compare.mjs` to scaffold local experiments-style
  submission folders, validate Pi Native/Shunya artifacts, and derive
  one-task or three-task comparison CSV/Markdown reports from saved local
  results.
- Generated local scaffolds under `dev-notes/benchmark/experiments-local/` and
  blocker reports under `dev-notes/benchmark/results/swebench-lite-v1/`.
  Verification: `node scripts/swebench-lite-compare.mjs --scaffold --limit 3`
  produced the expected missing-artifact failure; `node
  scripts/swebench-lite-compare.mjs --limit 1` produced the expected one-task
  missing-artifact failure; `node scripts/swebench-lite-compare.mjs --help`
  succeeded; `npm run check` passed.
- Reviewed the goal-plugin choice with a `gpt-5.4-mini` subagent and locked the
  v1 benchmark plan to pinned `@narumitw/pi-goal`, currently `0.9.2`, for both
  Pi Native and Shunya. Added integration checks for identical lifecycle
  behavior, trace sidecar alignment, and `store_evidence` placement.
  Verification: docs-only change by direct file read.
- Added a concrete benchmark work plan to
  `dev-notes/benchmark/benchmarking-first-principles.md`, covering goal-plugin
  review, runner command inventory, trace schema lock, SWE-bench Lite adapter,
  first paired dry run, first result audit, 10-task subset freeze, remaining
  runs, and final cost/quality report. Verification: docs-only change by direct
  file read.
- Updated `dev-notes/benchmark/benchmarking-first-principles.md` with the v1
  benchmark decision: use a fixed 10-task SWE-bench Lite subset, run both Pi
  Native and Shunya with `gpt-5.4-mini`, share `@narumitw/pi-goal` as the goal
  plugin, and compare task quality plus token/cost results. Verification:
  docs-only change by direct file read.
- Added `dev-notes/benchmark/benchmarking-first-principles.md` to
  clarify the controlled-experiment framing for Pi-vs-Shunya benchmarking,
  explain that cost metadata capture is partly present but not yet packaged as a
  benchmark trace, and define how to tackle saved evidence through per-run trace
  JSON plus derived CSV/report outputs. Verification: docs-only change by direct
  file creation.
- Completed the Shunya-owned capture path for the real `shn` coding-agent flow. Added a read-only `provider_payload` extension event in `packages/coding-agent`, wired it after mutable provider payload hooks, and updated the Shunya extension to write `<session>.shunya.trace.jsonl` with `api_payload_capture`, `api_call_usage`, and `turn_usage` records while keeping compressed sessions in `<session>.compressed.jsonl`.
- Fixed the observed compression bug where the model calls `store_evidence` after reading prior tool results, not in the same assistant message as the raw tool call. `projectContext()` now projects raw tool outputs across the user-task batch once evidence is stored, and compressed JSONL sidecars preserve the session header and valid parent links.
- Verification: `npm run check`, `node node_modules/vitest/dist/cli.js --run test/extensions-runner.test.ts` from `packages/coding-agent`, and `node node_modules/vitest/dist/cli.js --run test/harness/retention-policy.test.ts` from `packages/agent` all passed.
- Added live Shunya cost-saved percentage to `/session`, calculated as `saved cost / cost without Shunya`, so the session view shows both absolute and percentage savings up to that point. Verification: `npm run check` passed.
- Added live tool-token savings to `/session`: tool tokens with Shunya, tool tokens without Shunya, and percentage reduced. Extended `calculateShunyaSavings()` with replayed tool-token totals and covered it in `packages/coding-agent/test/shunya-session-cost.test.ts`. Verification: focused Vitest test and `npm run check` passed.
- Updated `/session` command in `packages/coding-agent/src/modes/interactive/interactive-mode.ts` to calculate and display compressed token totals plus reconstructed savings when Shunya is active.
- Replaced the savings estimate with turn-by-turn reconstruction in `packages/coding-agent/src/core/shunya-session-cost.ts`, using `@dqbd/tiktoken` to price dropped raw tool outputs and separate first-use versus replayed cache tokens. Added `packages/coding-agent/test/shunya-session-cost.test.ts` and verified `npm run check` plus the focused Vitest case.
- Committed all files locally and rebuilt the workspace successfully.
- Completed the task-level tool output batch compression. Registered the `store_evidence` tool dynamically and added the `context` extension hook inside the new Shunya plugin at `packages/coding-agent/examples/extensions/shunya.ts`.
- Exported `retention-policy.ts` from `packages/agent/src/index.ts`.
- Cleaned up the automatic registration of `store_evidence` from the core `AgentHarness` constructor to keep baseline and compressed runs directly comparable and restore the core harness test suite compatibility.
- Added comprehensive unit and integration tests under `packages/agent/test/harness/retention-policy.test.ts` to verify that raw tool outputs are projected out of context once the `store_evidence` summary is executed.
- Verified that all 175 tests in the `packages/agent` workspace pass cleanly, and the entire project passes `npm run check`.

- Started the Shunya-owned OpenAI capture and token-accounting overlay in
  `packages/agent`: added `token-accounting.ts`, API request/payload/usage and
  per-turn usage session entries, session append/read helpers, and an
  `AgentHarness` stream wrapper hook that records OpenAI calls without changing
  the provider request flow. Added focused harness tests using the faux provider
  registered as `openai`. Verification:
  `npm exec --workspace packages/agent -- vitest --run test/harness/token-accounting.test.ts`
  passed, and `npm run check` passed after hydrating dependencies with
  `npm install --ignore-scripts` and regenerating the coding-agent shrinkwrap
  and install lock.

- Imported the prior Shunya token-efficiency research bundle into the
  Pi-derived `Shunya-agent` fork. Added `GOAL.md`, context-compression notes,
  generated session-profile analysis artifacts, and standalone Python estimator
  scripts. Added this progress log and a context-compression roadmap. Verification:
  `python3 -m py_compile scripts/tool_output_cache_math.py scripts/turn_by_turn_cache_estimator.py scripts/turn_by_turn_same_turn_summary_estimator.py scripts/user_turn_batch_compression_estimator.py scripts/session_context_profile.py`
  succeeded; `npm run check` could not run because `biome` was not installed in
  this fresh checkout; `git status --short` shows only the imported research
  files plus `README.md` and `AGENTS.md` edits from this transfer.

## Prior Research Imported From `/Users/rakshithsajjan/Documents/main/projects/research/shunya`

- Built the research direction around the most token-efficient coding-agent
  harness, using Pi as the reference system and focusing on measurable context
  retention, cache accounting, replayable traces, and coding-quality evals.
- Added the canonical tool-output compression research note with cache-first
  economics, intent-aware evidence cards, model-initiated `compact_tool_result`,
  runtime validation, retention states, and cache-aware projection.
- Scanned local Codex session logs under `~/.codex/sessions` and
  `~/.codex/archived_sessions`: 616 JSONL files, 30,183 tool-output records,
  roughly 46M stored tool-output tokens, with outputs above 2,000 tokens making
  up a small record share but most stored tool-output payload.
- Added replayable estimators for cache-first output compression, turn-by-turn
  cache accounting, same-turn summaries, user-turn batch compression, and full
  session context composition.
- Generated `analysis/session_context_profile/` CSV and SVG artifacts and the
  `dev-notes/context-compression/session-context-profile.md` report.

## Roadmap: Task-Level Batch Compression via Agent Self-Summary

Based on cache economics and agent behavior, the next implementation phase will use **agent-initiated batch summaries** at the end of a task loop:

1. **Active Loop (Cheap Cache Reads):** The agent freely chains tools (`cat`, `grep`, etc.). Raw outputs accumulate in context but are heavily discounted by the provider's prompt cache while the agent works.
2. **Yield & Summarize (`store_evidence`):** When the task is complete and the agent is ready to reply to the user, it calls a new `store_evidence` tool to record a concise, hindsight-aware summary of what it learned (paths, schemas, decisions).
3. **Context Projection:** On the *next* user turn, the Shunya harness uses the `transformContext` or `prepareNextTurn` hook to project the history: it drops the massive raw tool outputs from the previous turn, leaving only the agent's lightweight `store_evidence` summary.

**Next Implementation Steps:**
- [ ] Create the `store_evidence` tool definition.
- [ ] Update the system prompt with guidelines on when and how to summarize.
- [ ] Implement context projection in the harness to swap raw outputs for the summary across user-turn boundaries.
