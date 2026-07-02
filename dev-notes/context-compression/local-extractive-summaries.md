# Exploring Local/Extractive Summaries

## Observation
The compression estimators (`scripts/tool_output_cache_math.py`, `scripts/turn_by_turn_cache_estimator.py`, etc.) indicate that local/extractive summaries save significantly more than model-generated summaries.
- Local savings: ~90.5%
- Model-generated savings: ~79.1%
Model-generated summaries have an inherent overhead since we must run the model to generate the summary, which costs time and API tokens. Extractive summaries process tool output purely logically/programmatically, extracting paths, names, file contents, etc. without needing an LLM call.

## Current Setup
The current `store_evidence` tool allows the LLM to choose what to store. The user prompt explains this:
```typescript
	description:
		"Call this to record a concise, hindsight-aware summary of key facts, file paths, and findings from raw tool outputs generated during this turn. The harness will drop the heavy raw outputs from your context on the next turn, retaining only this summary.",
```
This forces the model to synthesize the summary in a separate call (`store_evidence`), adding tokens to its output.

## Alternative: Extractive Summaries
Instead of letting the model freely generate text, we can capture the "hindsight" of the model (why it ran the tool, what actions it took afterwards) but we extract the "exact facts" (paths, snippet indices, tool output headers) deterministically.

**Wait**, the issue is the Shunya overhead on small tasks. If the model decides to run `store_evidence` on short tasks, it's paying for prompt schemas and system guidelines overhead.

### Dynamic Thresholds
The estimators show that compression is only worth it above a size threshold (default 2000 tokens). Short tasks don't breach this threshold often.
If we enforce a size limit *before* enabling `store_evidence`, the model never even sees the tool or the instruction unless the context gets large.
This eliminates overhead on short Django tasks.

### Local Extraction
If we want to avoid model generation entirely:
When a tool runs, we record:
- Tool executed (e.g., `bash: run_tests.sh`)
- Relevant paths (extracted via regex or simple parsing)
- Exit code
- Truncated stderr/stdout

We project this directly without the model calling `store_evidence`.
However, the whole premise of Shunya is "hindsight-aware" summaries. If we do pure local extraction, we lose the model's insight on *why* it ran the tool or *what it learned*.

### Hybrid Approach
1. Only make `store_evidence` available when context pressure crosses a threshold (e.g., total raw tool output tokens > 2,000).
2. The `store_evidence` tool can ask the model for a *short string* about what it learned, but the system *automatically* bundles the exact commands, exit codes, and re-fetch pointers into the evidence card. This reduces the number of tokens the model needs to generate.

## The 4th Option: Cache-Aware Projection Policy
The `roadmap.md` mentions: "cache-aware policy that avoids breaking valuable prompt-cache prefixes too early"

When a model is actively using the raw output (same turn or immediately after), the provider prompt cache has it for extremely cheap.
If we replace the cached raw output with a fresh `store_evidence` summary *too soon*, we break the cache prefix and pay for uncached tokens on the summary.

**The idea:**
Don't project out the raw tool output immediately on the next turn if it is cheaper to keep it as cached context.
We can calculate:
- Cost of keeping raw output as cached input for the next turn.
- Cost of inserting the `store_evidence` summary as uncached input.
If (cost of uncached summary) > (cost of keeping raw cached output), we defer projection.

We should investigate implementing this threshold and cache-awareness in `packages/agent/src/harness/retention-policy.ts` or the Shunya extension.
