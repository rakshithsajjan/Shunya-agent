# Progress

## 2026-06-30

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
