# Option 4: Cache-Aware Projection Policy

This document explores the fourth approach to improving cache hits and lowering token costs: making the context projection engine aware of provider cache economics.

## The Problem
When a coding agent reads a large file or runs a test suite, the raw tool output enters the context window. Modern LLM providers (like Anthropic, OpenAI) implement prompt caching. Once this large block of text is processed, subsequent turns that share this prefix are charged at a much lower "cached input" rate (often 50-90% cheaper).

If Shunya aggressively calls `store_evidence` and projects the raw tool output out of the context *immediately* on the next turn, it replaces the raw text with a new summary string.

Because this summary is new, it breaks the cache prefix. The provider must now process the summary (and anything that follows it) as "uncached input".

As `tool-output-compression-research.md` notes:
> "Raw tool output that is already in the model/provider prompt cache may be cheap to keep on later turns. Cache reads can cost much less than fresh input tokens. If the agent replaces cached raw output with a new compressed summary, that summary may be uncached..."

If the agent only takes 1 or 2 more turns to finish the task, it might be cheaper to just pay the cached read cost for the raw output rather than pay the uncached write cost for the summary.

## The Math
Let's define:
- `T_raw` = Tokens in the raw tool output
- `T_sum` = Tokens in the summary
- `P_uncached` = Uncached input price (per token)
- `P_cached` = Cached input price (per token)

For a given future turn:
- Cost to keep raw: `T_raw * P_cached`
- Cost to introduce summary: `T_sum * P_uncached` (first time), then `T_sum * P_cached` (subsequent times)

**Break-even point:**
The number of future turns `N` required for compression to save money is roughly:
`N = (T_sum * P_uncached) / (T_raw * P_cached)`
*(Assuming T_sum is very small, we can ignore its future cached cost for a rough estimate).*

For example, with GPT-4o pricing (using hypothetical numbers for simplicity):
- Uncached: $5.00 / 1M
- Cached: $2.50 / 1M
If raw is 2000 tokens, and summary is 300 tokens:
- Keep raw: 2000 * $2.50 = $0.005 per turn
- Introduce summary: 300 * $5.00 = $0.0015 one-time
In this specific case, it's immediately cheaper to compress.

But consider a provider where cache reads are extremely cheap (e.g., $0.50 / 1M cached vs $5.00 / 1M uncached):
- Keep raw: 2000 * $0.50 = $0.001 per turn
- Introduce summary: 300 * $5.00 = $0.0015 one-time
Here, keeping the raw output for 1 more turn is cheaper than compressing it. You only save money if the session lasts 2+ more turns.

## The Solution: Deferring Projection
The Shunya `projectContext()` hook in `retention-policy.ts` currently projects out raw outputs *immediately* as soon as `store_evidence` is recorded.

To make this cache-aware:
1. **Track Epochs:** We need to know how many times the current prefix has been used.
2. **Economic Threshold:** Before projecting out a raw tool result, the system compares the cost of keeping it vs replacing it.
3. **Deferred Projection:** If keeping it is cheaper (or if the cache is still hot and unbroken), we leave the raw output in the `messages` array for the LLM. We only project it out and replace it with the summary when the cost tips, or when the prefix is naturally broken by something else (like a large new user message).

### Implementation Outline
1. Expand the `ProjectContextOptions` or harness to include `pricing: PricingModel` and `currentTurn: number`.
2. When evaluating a `store_evidence` block, calculate the raw tokens it wants to replace.
3. Calculate the cached cost of keeping the raw tokens.
4. Calculate the uncached cost of the summary.
5. If `cached_cost < uncached_cost` AND `estimated_remaining_turns < break_even_turns`, skip projection for this turn.
6. The `store_evidence` tool result is still recorded in the backend so it can be used on a future turn when it becomes economical.

This policy ensures we never lose money by compressing too early.
