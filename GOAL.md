# shunya

Build the most token-efficient coding agent harness we can, using `pi` as the reference system and rebuilding only the parts that prove their value.

The research question is no longer just "can we build a minimal Python coding agent?" It is:

> What is the smallest, cleanest harness that lets a coding agent do real work while spending the fewest useful tokens across tools, context, cache reads, cache writes, summaries, and session replay?

## North Star

shunya should be a measurement-first agent harness for code work:

- Keep task success observable
- Keep context small by default
- Preserve exact evidence only when it will matter later
- Treat cache behavior as part of architecture, not an afterthought
- Prefer local deterministic compaction before spending model tokens
- Make every context policy measurable against real session traces

## Philosophy

### Token efficiency is the product
- Count prompt, cache-read, cache-write, output, and tool-result tokens separately
- Measure policies on full sessions, not isolated examples
- Optimize for repeated coding turns where old evidence becomes context drag

### Keep the core small
- The harness should be readable in one sitting
- New behavior defaults to narrow policy modules, not core bloat
- Every feature should answer: does this reduce useful-token cost, improve success, or make measurement sharper?

### Evidence beats transcript hoarding
- Tool outputs should degrade into evidence cards, not remain full logs forever
- File paths, symbols, diagnostics, diffs, and decisions matter more than raw terminal noise
- Refetchable evidence should be replayed from tools when cheaper than retaining it

### Build for controlled experiments
- Context assembly must be inspectable
- Retention policies must be swappable
- Session traces must support replay and cost comparison
- Quality failures should be attributable to a policy decision

## Harness Shape

```
user message
  -> context builder
       system prompt
       repo instructions
       active session state
       retained evidence
       tool schemas
       cache markers
  -> LLM provider
  -> parse tool calls
  -> execute tools
  -> classify tool results
  -> retain exact output, evidence card, summary, or refetch handle
  -> persist session trace
  -> measure token and cache cost
  -> loop or respond
```

## Core Components

| Component | Responsibility |
|---|---|
| `core/` | Agent loop, message model, tool-call lifecycle, policy hooks |
| `tools/` | Small coding tool set: read, write, edit, bash, grep, find, ls |
| `context/` | Context builder, repo instructions, budget planner, retention assembly |
| `retention/` | Exact-retain, truncate, evidence-card, summary, and refetch policies |
| `cache/` | Provider-aware cache markers and cache-cost accounting |
| `providers/` | Stub first, then real streaming/function-calling adapters |
| `sessions/` | JSONL traces with enough structure for replay and policy comparison |
| `evals/` | Cost estimators, trace replayers, and task-success checks |

## Retention Model

Every tool result should move through an explicit retention decision:

| State | Meaning |
|---|---|
| `fresh` | Full result is available in the current turn |
| `exact` | Keep full output because exact text is needed |
| `evidence` | Keep structured facts: paths, symbols, diagnostics, decisions |
| `summary` | Keep compact natural-language context |
| `refetch` | Drop output and keep a safe tool replay handle |
| `discarded` | Drop because it has no future task value |

The default research target is task-level batch compression: compress the combined tool-output batch for a user turn when it crosses a threshold, while retaining exact snippets only for data the next turn is likely to need.

## Metrics

Track these per session and per turn:

- Raw tool-output tokens
- Retained-context tokens
- Input tokens
- Cache-write tokens
- Cache-read tokens
- Output tokens
- Summary-generation tokens
- Context rebuild cost
- Number of tool calls per user turn
- Refetch count and refetch cost
- Task success and recovery failures

## Current Research Anchors

- Local Codex trace analysis showed tool outputs are heavy-tailed.
- Outputs above a threshold are a small share of records but dominate stored context.
- Same-turn batch summaries look more promising than per-output summaries in early cost estimates.
- The next harness should make that policy real enough to test against coding tasks.

See `tool-output-compression-research.md` for the current measurements and policy sketches.

## Implementation Phases

### Phase 1 - Minimal Measured Harness
- Stub provider
- Basic coding tools
- JSONL session trace
- Context builder with token accounting
- Simple CLI: `shunya -p "query"` and REPL mode

### Phase 2 - Retention Policies
- Tool-result classification
- Exact, evidence-card, summary, refetch, and discard states
- Task-level batch compression
- Replayable cost reports over recorded sessions

### Phase 3 - Real Providers And Cache Accounting
- OpenAI provider with streaming/tool calls
- Anthropic provider with streaming/tool calls
- Provider-aware cache markers
- Cost model that separates uncached input, cache writes, cache reads, and output

### Phase 4 - Coding Quality Evals
- Small coding-task suite
- Replay traces with different retention policies
- Measure cost versus task success
- Identify when compression loses necessary evidence

### Phase 5 - Self-Extension
- Let shunya edit its own source
- Keep extension points small and measurable
- Add skills/prompt templates only when they reduce repeated context cost or improve task success

## Development

```bash
uv sync
uv run shunya -p "hello"
uv run shunya
uv run pytest
```
