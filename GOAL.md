# Shunya Goal

Build the most token-efficient coding-agent harness we can, using `pi` as the
reference system and changing only the pieces whose value can be measured.

## Research Question

What is the smallest, cleanest harness that lets a coding agent do real work
while spending the fewest useful tokens across tools, context, cache reads,
cache writes, summaries, and session replay?

## Principles

- Preserve task success as the first quality signal.
- Keep context small by default, but keep exact evidence when correctness needs
  it.
- Treat cache reads, cache writes, summaries, and replay as architecture costs.
- Prefer deterministic local compaction before spending model tokens.
- Make every retention policy measurable against real traces.
- Attribute quality failures to specific policy decisions whenever possible.

## Current Focus

Shunya is testing task-level tool-output retention against Pi Native on
SWE-bench Lite. The current candidate policy is:

1. Let the agent work with full tool outputs during the active turn.
2. Have the agent call `store_evidence` when it has enough hindsight to
   summarize the useful facts.
3. On later turns, project raw tool outputs out of context unless exact output
   was explicitly retained.

The near-term question is whether this saves cost without losing correctness on
real coding tasks.

## Metrics

Track these per run, task, variant, session, and turn when available:

- task success and failure reason
- patch produced
- runtime
- tool-call count
- input tokens
- cached-input tokens
- cache-write tokens
- output and reasoning tokens
- raw tool-output tokens
- retained-context tokens
- summary-generation cost
- total estimated cost and cost per successful task

## Retention States

| State | Meaning |
| --- | --- |
| `fresh` | Full result is available in the current turn. |
| `exact` | Keep full output because exact text matters. |
| `evidence` | Keep structured facts such as paths, symbols, diagnostics, and decisions. |
| `summary` | Keep compact natural-language context. |
| `refetch` | Drop output and keep a safe replay handle. |
| `discarded` | Drop because it has no expected future value. |

## Research Anchors

- `dev-notes/context-compression/tool-output-compression-research.md`
- `dev-notes/context-compression/session-context-profile.md`
- `dev-notes/context-compression/roadmap.md`
- `dev-notes/benchmark/INDEX.md`
- `dev-notes/benchmark/EXPERIMENT_PROTOCOL.md`
- `progress.md`

## Success Standard

A Shunya change is useful only if it improves one of these without hiding the
tradeoff:

- lower cost at comparable task success
- better task success at comparable cost
- sharper measurement or attribution
- simpler, smaller harness behavior
