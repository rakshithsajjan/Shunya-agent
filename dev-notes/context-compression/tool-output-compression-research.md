# Tool Output Compression Research

## Problem

Coding agents often receive long tool outputs, use them to understand the repo or diagnose failures, and then make edits based on that context. After the agent has already acted on the output, the full raw output may be less useful than a compact representation of the important facts.

The question is whether compressing those long tool outputs after use actually saves money and improves context efficiency.

## Core Tension

Compression looks attractive because it reduces visible context length. A long command output could become a short summary such as:

- which command ran
- what the agent learned from it
- which files, errors, or lines mattered
- what edits were made because of it
- what details may still need exact lookup later

But raw tool output that is already in the model/provider prompt cache may be cheap to keep on later turns. Cache reads can cost much less than fresh input tokens. If the agent replaces cached raw output with a new compressed summary, that summary may be uncached and may also discard details needed later.

So the real research question is not just:

> Does compression reduce token count?

It is:

> When is replacing cached long tool output with a fresh compressed representation more economical than leaving the cached output in context?

## Intent-Aware Evidence Cards

The compact replacement should not be a vague prose summary. It should be a structured evidence card that preserves exact anchors a coding agent may need later:

- file paths
- line ranges or symbol names
- function, class, and test names
- exact error messages and diagnostics
- commands, exit codes, and relevant stderr
- IDs, flags, and configuration names
- unresolved questions
- deterministic re-fetch instructions when safe

Before calling a tool, the agent should declare why it needs the result:

```text
Goal: find why expired tokens are accepted
Need exactly: relevant function names, expiry check, caller path
Can ignore: unrelated authentication helpers
```

That intent gives the compression layer a target. Instead of guessing what mattered after the fact, the system can preserve the evidence that matched the original retrieval purpose.

For example, after reading a large file and editing the relevant bug, the raw output could become:

```text
File: src/auth/session.ts
Relevant area: refreshSession(), around the expiry-check path
Finding: refreshSession() accepted expired tokens because expiry was not checked before refresh.
Important names: refreshSession, getSession, SessionExpiredError
Unresolved: confirm middleware rejects SessionExpiredError
Re-fetch: read_file(src/auth/session.ts, symbol=refreshSession, version=<blob-or-content-hash>)
```

For file reads, a line range alone is not enough because edits can shift lines. The evidence card should preserve a content hash, Git blob SHA, surrounding symbol, or similar version anchor.

## Model-Initiated Compaction

The model can participate directly in deciding what should be compressed. At turn `T_n`, it can state its retrieval intent, call a tool, read the full output, and act on it. After the action is taken, it can call a dedicated `compact_tool_result` tool to propose an evidence card.

Example payload:

```json
{
  "tool_call_id": "read-142",
  "reason_action_taken": "Added an expiry check in refreshSession().",
  "retain_exactly": {
    "paths": ["src/auth/session.ts"],
    "symbols": ["refreshSession", "getSession", "SessionExpiredError"],
    "diagnostics": []
  },
  "finding": "refreshSession() accepted expired tokens because expiry was not checked before refresh.",
  "unresolved": ["Confirm middleware rejects SessionExpiredError."],
  "refetch": {
    "tool": "read_file",
    "args": {
      "path": "src/auth/session.ts",
      "symbol": "refreshSession"
    },
    "version": "git-blob-sha-or-content-hash",
    "safe_to_replay": true
  },
  "recommended_retention": "evidence_card"
}
```

The model should be allowed to propose compaction, but not to destroy evidence unilaterally. The runtime should validate the card, preserve the raw artifact, and decide when to alter model-visible context.

Recommended flow:

```text
model decides relevance
  -> model calls compact_tool_result
  -> runtime validates the schema and exact anchors
  -> runtime preserves the raw output in an append-only store
  -> policy engine decides when replacement is worth the cache cost
  -> future model projections receive the evidence card instead of raw output
```

This keeps the agent involved in relevance judgments while preventing two failure modes:

- compressing before the model has actually used the raw output
- immediately rewriting old context and breaking a valuable prompt-cache prefix

## Retention State Machine

A useful lifecycle for each tool result:

```text
RAW_VISIBLE
  -> ACTION_OBSERVED
  -> COMPACTION_PROPOSED
  -> VALIDATED
  -> CARD_READY
  -> PROJECTED_AS_CARD
  -> POINTER_ONLY
```

The critical transition is `ACTION_OBSERVED`. A tool result should not become compactable immediately after `read_file` or `run_tests`. The system should wait until the assistant has taken a later action that demonstrates it used the output, such as editing a file, choosing a next inspection target, or explaining the failure.

The runtime can keep a local append-only ledger:

```text
.agent/
  evidence/
    <artifact-hash>.raw
    <tool-call-id>.json
```

The durable ledger stores full raw output, metadata, evidence cards, hashes, and re-fetch information. The model projection is separate and can leave the current cache epoch stable while replacing raw outputs at the next compaction boundary.

For shell commands, re-fetchability must be treated carefully. A command should not be marked safe to replay merely because it can be rerun. Builds, tests, migrations, deployments, and network calls may be expensive, nondeterministic, or side-effecting, so the card should preserve command, cwd, exit code, relevant stderr, test IDs, git commit, environment assumptions, and raw-output hash.

## Policies To Compare

- Keep full tool outputs and rely on prompt cache discounts.
- Compress every long tool output after the agent has used it.
- Compress only outputs above a size threshold.
- Compress only after the agent has made edits based on the output.
- Let the model call `compact_tool_result` after it has acted, then let the runtime validate and schedule projection.
- Keep exact relevant excerpts plus a short summary.
- Store raw outputs externally and keep only summaries or references in context.

## Measurements

- Total cost, including cached and uncached input tokens.
- Context window pressure.
- Latency.
- Task success rate.
- Regression rate from missing discarded details.
- Whether the agent needs to rerun tools because compressed context lost information.
- Cache-epoch churn caused by replacing old context too early.
- Stale-reference failures after edits move line numbers or invalidate prior file snippets.

## Hypothesis

Compression may help most when context pressure is high, when the raw output is unlikely to be revisited, or when cache hit rates are poor. Keeping the raw output may be better when prompt cache reads are very cheap, cache continuity is reliable, and future reasoning may depend on exact details from the original output.

## Minimal Prototype Scope

Start with a narrow coding-agent substrate:

- one model provider
- four tools: read, grep, edit, bash/test
- sandboxed command execution
- append-only raw artifact store
- `compact_tool_result` for model-proposed evidence cards
- cache-aware projection policy

Avoid building unrelated product surface at first: no TUI, browser, MCP, subagents, planning mode, or multi-agent orchestration. The unique research contribution is the retention and projection runtime, not another full terminal agent.

The narrow novelty claim is:

> An action-confirmed, intent-conditioned retention policy for individual tool results, which selects raw output, structured evidence, pointer-only retention, or deletion using version-valid re-fetchability and cache economics.

## Initial Local Codex Log Exploration

Date: 2026-06-29

Sample: local Codex session logs under `~/.codex/sessions` and `~/.codex/archived_sessions`.

- Files scanned: 616 JSONL session files.
- Tool output records found: 30,183.
- Actual stored tool-output payload estimate: 45,988,242 tokens total.
- Average actual stored tool output: 1,524 tokens.
- Median actual stored tool output: 149 tokens.
- P90: 2,387 tokens.
- P95: 3,806 tokens.
- P99: 13,398 tokens.

The average is much higher than the median because a small number of very large tool outputs dominate total context usage.

Important distinction:

- `Original token count` in shell outputs appears to describe raw command output before truncation.
- Actual context pressure is closer to the stored/truncated payload size.
- Raw pre-truncation command output across the same sample was about 272M tokens, while stored payloads were about 46M tokens.

Category-level actual stored payload estimates:

| Category | Count | Average | Median | P95 | Total |
|---|---:|---:|---:|---:|---:|
| File reads (`sed`, `cat`, `nl`, `head`, `tail`) | 6,746 | 1,440 | 1,076 | 3,841 | 9.7M |
| Search (`rg`, `grep`) | 1,658 | 2,536 | 800 | 11,149 | 4.2M |
| Git inspection | 1,623 | 775 | 157 | 3,409 | 1.3M |
| Listings (`find`, `ls`, `tree`) | 1,247 | 677 | 128 | 3,298 | 0.8M |
| Test/build commands | 1,090 | 602 | 129 | 1,753 | 0.7M |
| Patch outputs | 2,179 | 60 | 52 | 132 | 0.1M |

File-read breakdown:

| Command | Count | Average | Median | P95 |
|---|---:|---:|---:|---:|
| `sed` | 4,523 | 1,450 | 1,150 | 3,573 |
| `nl` | 1,524 | 1,638 | 1,172 | 4,530 |
| `cat` | 437 | 483 | 141 | 1,439 |
| `tail` | 251 | 1,714 | 760 | 5,711 |
| `head` | 11 | 1,397 | 315 | 5,619 |

Compression opportunity:

- Outputs at or above 1,000 tokens were 22.4% of records but about 90.2% of stored tool-output tokens.
- Outputs at or above 2,000 tokens were 12.6% of records but about 81.0% of stored tool-output tokens.
- Outputs at or above 4,000 tokens were 4.7% of records but about 66.8% of stored tool-output tokens.

If outputs above 2,000 tokens were replaced with 300-token summaries, visible stored tool-output payload would drop by roughly 78.6% in this sample. This does not yet account for prompt-cache pricing, cache hit rates, or quality loss from discarded exact details.

## Pricing-Based Cost Sketch

Date: 2026-06-29

Scenario: use the initial local Codex log sample and apply this policy:

- Compress only stored tool outputs at or above 2,000 tokens.
- Replace each with a 300-token summary.
- Raw cached tokens replaced: about 37.27M.
- Summary tokens inserted: about 1.14M.
- Future cached-token reduction per replay: about 36.13M.

This corrected calculation assumes the raw tool outputs are already cached. Compression has an extra one-time cost:

- read the raw cached output once to generate the summaries
- generate about 1.14M summary output tokens
- insert or cache-write about 1.14M new summary input tokens

Approximate cache-first cost impact:

| Model | Keep raw cached per turn | Summary cached per turn | Saved per future turn | One-time cost if model generates summaries | Break-even future turns |
|---|---:|---:|---:|---:|---:|
| GPT-5.5 | $18.64 | $0.57 | $18.06 | $58.59 | 3.24 |
| GPT-5.4-mini | $2.80 | $0.09 | $2.71 | $8.79 | 3.24 |
| Claude Sonnet 4.6, 5m cache write | $11.18 | $0.34 | $10.84 | $32.58 | 3.01 |
| Claude Sonnet 4.6, 1h cache write | $11.18 | $0.34 | $10.84 | $35.15 | 3.24 |
| Gemini 2.5 Flash | $1.12 | $0.03 | $1.08 | $4.31 | 3.98 |
| Grok Build 0.1 | $7.45 | $0.23 | $7.23 | $10.88 | 1.51 |

If summaries are made locally or extractively instead of model-generated, the one-time cost is only the first insertion/cache-write of the summary tokens:

| Model | One-time local-summary insertion cost | Break-even future turns |
|---|---:|---:|
| GPT-5.5 | $5.71 | 0.32 |
| GPT-5.4-mini | $0.86 | 0.32 |
| Claude Sonnet 4.6, 5m cache write | $4.28 | 0.39 |
| Claude Sonnet 4.6, 1h cache write | $6.85 | 0.63 |
| Gemini 2.5 Flash | $0.34 | 0.32 |
| Grok Build 0.1 | $1.14 | 0.16 |

Interpretation:

- Under always-cached assumptions, model-generated compression pays back after about 3-4 future cached replays for OpenAI, Claude, and Gemini in this sample.
- Local or extractive compression pays back almost immediately because it avoids paying model output cost to create summaries.
- The larger the original output, the faster compression wins.
- The missing measurement is quality: summaries may lose exact details and force tool reruns.

## Replay-Aware Script Result

Script: `scripts/tool_output_cache_math.py`

Default command:

```bash
python3 scripts/tool_output_cache_math.py --threshold 2000 --summary-tokens 300 --preset gpt-5.5
```

This script scans Codex session JSONL files and accounts for how many future `turn_context` replays each eligible tool output actually survived. By default it lets the next model call still see the raw tool output once, then models the summary as uncached/cache-write input on the first compressed replay and cached input on later compressed replays.

Use `--raw-use-replays 0` to model immediate compression before the next model call, or leave the default `--raw-use-replays 1` to model "let the model use the raw output once, then compress."

GPT-5.5 preset result over all local sessions with default `--raw-use-replays 1`:

- Sessions scanned: 617.
- Context replays: 7,540.
- Tool outputs: 30,253.
- Compressible outputs after raw-use replays: 2,966.
- Eligible raw tokens: 28.00M.
- Replacement summary tokens: 0.89M.
- Future raw replays retained before compression: 2,966.
- Future compressed replays: 105,461.
- Keep raw cached cost: $357.13.
- Compress with local/extractive summaries: $33.82.
- Local/extractive savings: $323.31, or 90.5%.
- Compress with model-generated summaries: $74.52.
- Model-generated savings: $282.61, or 79.1%.

Preset comparison:

| Preset | Keep raw cached | Local/extractive compressed | Local savings | Model-generated compressed | Model savings |
|---|---:|---:|---:|---:|---:|
| GPT-5.5 | $357.13 | $33.82 | $323.31 | $74.52 | $282.61 |
| GPT-5.4-mini | $53.57 | $5.07 | $48.50 | $11.18 | $42.39 |
| Claude Sonnet 4.6, 5m | $214.28 | $20.96 | $193.32 | $42.71 | $171.57 |
| Claude Sonnet 4.6, 1h | $214.28 | $22.96 | $191.32 | $44.71 | $169.57 |
| Gemini 2.5 Flash | $21.43 | $2.03 | $19.40 | $5.09 | $16.33 |
| Grok Build 0.1 | $142.85 | $12.64 | $130.21 | $20.02 | $122.83 |

This replay-aware result is stronger than the simple break-even sketch because many large outputs in the historical logs remained in context for many later model calls.

## Turn-By-Turn Full-Context Estimator

Script: `scripts/turn_by_turn_cache_estimator.py`

Default command:

```bash
python3 scripts/turn_by_turn_cache_estimator.py --threshold 2000 --summary-tokens 300 --preset gpt-5.5
```

This estimator replays each session at every `turn_context`. It charges first appearances at the uncached/cache-write price and later appearances at the cached-read price. It includes user messages, developer/system context, assistant messages, tool calls, tool outputs, and compaction summaries. Only large tool outputs differ between normal mode and compressed mode.

GPT-5.5 preset result over all local sessions:

- Sessions scanned: 617.
- Turns charged: 7,544.
- Tool outputs: 30,270.
- Eligible tool outputs: 3,815.
- Non-tool context items: 66,565.
- Total tool-output tokens: 46.05M.
- Eligible tool-output tokens: 37.31M.
- Total non-tool context tokens: 48.22M.
- Normal, raw outputs with caching: $1,881.92.
- Our tech, local/extractive summaries: $1,689.17.
- Local/extractive savings: $192.75, or 10.2%.
- Our tech, model-generated summaries: $1,723.26.
- Model-generated savings: $158.66, or 8.4%.

Interpretation:

- Absolute savings are lower than the replay-aware tool-only shortcut because this estimator resets active context at compaction boundaries.
- Percentage savings are much lower because the denominator now includes shared user/system/assistant context that both normal mode and compressed mode must pay for.
- User input is charged as uncached/cache-write the first time it appears and cached on later turns.
- The compression benefit remains isolated to large tool outputs.

## Same-Turn Model Summary Estimator

Script: `scripts/turn_by_turn_same_turn_summary_estimator.py`

Default command:

```bash
python3 scripts/turn_by_turn_same_turn_summary_estimator.py --threshold 2000 --summary-tokens 300 --preset gpt-5.5 --only-tool-sessions
```

This models a cheaper model-generated path: the main model emits the retention summary during the same turn where it already used the raw tool output. That means there is no separate raw-output reread. The summary output tokens are paid once, and the 300-token summary becomes future input context.

GPT-5.5 tool-use-session result:

- Normal, raw outputs with caching: $1,881.08.
- Local/extractive summaries: $1,688.23.
- Local savings: $192.85, or 10.3%.
- Same-turn model summaries: $1,714.53.
- Same-turn savings: $166.55, or 8.9%.
- Separate model summaries: $1,722.31.
- Separate savings: $158.77, or 8.4%.

Representative same-turn comparison:

| Model | Normal | Local | Same-turn | Separate | Same-turn savings | Same-turn % |
|---|---:|---:|---:|---:|---:|---:|
| GPT-5.5 Pro | $1,881.08 | $1,688.23 | $1,714.53 | $1,722.31 | $166.55 | 8.9% |
| GPT-5.4 Mini | $282.16 | $253.23 | $257.18 | $258.35 | $24.98 | 8.9% |
| Claude Sonnet 4.6 | $1,186.86 | $1,071.73 | $1,084.89 | $1,089.86 | $101.97 | 8.6% |
| Gemini 2.5 Flash | $112.86 | $101.29 | $103.49 | $103.88 | $9.37 | 8.3% |
| Kimi K2.7 Code | $505.33 | $446.89 | $449.96 | $452.86 | $55.37 | 11.0% |
| DeepSeek V3.2 Exp | $827.16 | $721.14 | $721.50 | $727.34 | $105.66 | 12.8% |
| MiniMax M3 | $202.44 | $179.07 | $180.12 | $181.30 | $22.32 | 11.0% |

Same-turn summaries recover most of the benefit of local summaries while preserving the semantic quality of a model-generated retention note.

## User-Turn Batch Compression Estimator

Script: `scripts/user_turn_batch_compression_estimator.py`

Default command:

```bash
python3 scripts/user_turn_batch_compression_estimator.py --threshold 2000 --summary-tokens 300 --preset gpt-5.5 --only-tool-sessions
```

This models a batch-level policy:

- Keep all raw tool outputs while the agent is working on the current user turn.
- When the next real user request arrives, finalize the previous tool batch.
- If the combined tool-output tokens for that user turn are over 2,000, replace the whole batch with one 300-token retention summary for future turns.

GPT-5.5 tool-use-session result:

- Sessions: 314.
- Real user turns: 3,709.
- Tool outputs: 30,294.
- Tool batches: 3,386.
- Eligible batches: 1,042.
- Tool tokens: 46.06M.
- Eligible batch tool tokens: 33.60M.
- Normal, raw outputs with caching: $1,881.56.
- Local/extractive batch summaries: $1,598.31.
- Local savings: $283.25, or 15.1%.
- Same-turn batch summaries: $1,606.72.
- Same-turn savings: $274.84, or 14.6%.
- Separate batch summaries: $1,620.44.
- Separate savings: $261.12, or 13.9%.

This batch policy is stronger than per-output compression because one summary can replace many tool outputs from the same user task.
