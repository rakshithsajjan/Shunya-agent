# Improving Cache Hits and Lowering Token Costs

Based on the research notes, progress, and goal, here is an analysis of how we can improve cache hits and lower token costs overall.

## 1. Eliminate Overhead on Short Tasks (Dynamic Thresholding)
**Problem:** The 20-task benchmark showed Shunya has a 9.9% cost overhead across all tasks because short Django tasks pay for the `store_evidence` prompt schemas and system guidelines, even when they don't need compression.
**Solution:** Do not register the `store_evidence` tool or inject its system guidelines until the context actually needs compression (e.g., when raw tool outputs exceed 2,000 tokens).
This requires Shunya to dynamically expose the `store_evidence` tool only when `estimateTokens` or `calculateShunyaSavings` indicates that the raw tool outputs in the current context have passed the threshold. This makes short tasks behave exactly like Pi Native, saving 100% of the overhead.

## 2. Protect Exact Evidence to Prevent Correctness Regressions
**Problem:** Shunya failed on two Astropy tasks (`astropy-14182`, `astropy-14365`) because lossy compression discarded exact evidence (like line numbers or specific stack traces) that the model needed later.
**Solution:** `retention-policy.ts` recently added `retain_call_ids` to `store_evidence`. This is a great start. To go further, we should explore **Extractive Summaries**. Instead of relying on the model to summarize *everything*, the Shunya harness can automatically generate deterministic evidence cards for tools (e.g., `bash` exit codes, `read_file` paths, `grep` matches) without asking the model to re-generate them. The model's `store_evidence` call should only be used to capture its *intent* and *decisions*, not to transcribe code snippets. This prevents hallucination and loss of exact details while lowering the output tokens the model must generate.

## 3. Cache-Aware Projection Policy (The 4th Option)
**Problem:** Replacing raw tool outputs with a summary too early can actually *increase* costs if the raw outputs were already cheaply cached by the provider's prompt cache. Inserting a new summary breaks the prefix and forces an uncached write for the summary.
**Solution:** Defer context projection based on cache economics. When `projectContext` runs, it shouldn't immediately drop raw outputs just because `store_evidence` was called. It should calculate the break-even point:
- **Cost of keeping raw:** `(Raw Tokens) * (Cached Input Price)`
- **Cost of replacing with summary:** `(Summary Tokens) * (Uncached Input Price)`
If replacing it is more expensive in the current turn, *keep the raw output in context* and only project it out on a future turn when the cumulative cached cost would exceed the one-time uncached summary cost. This maximizes the benefit of provider prompt caches.

## 4. Batch Summaries (Same-Turn / End-of-Task)
**Problem:** Per-output compression is expensive.
**Solution:** As implemented in the current baseline, but explicitly enforcing that `store_evidence` is only called *once per user task loop*, directly before the agent responds to the user. This "User-turn batch compression" saves ~14-15% compared to 8-10% for per-output summaries.

## Summary of Actionable Changes
1. **Dynamic Tool Registration:** Hide `store_evidence` when context < 2000 tokens.
2. **Deterministic Evidence:** Supplement `store_evidence` with automatic local extraction (paths, exit codes, hashes) so the LLM doesn't have to output them.
3. **Cache-Aware Projection:** Update `projectContext()` in `retention-policy.ts` to defer projection if the cache-economics don't justify it yet.
