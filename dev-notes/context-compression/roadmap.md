# Context Compression Roadmap

This roadmap keeps Shunya focused on testing compression before building broad
agent surface area.

## Phase 0 - Baseline

Lock the current measurement baseline:

- normal raw tool-output retention
- per-output threshold compression
- user-turn batch compression
- same-turn evidence-card compression
- pointer/refetch-only retention for safe outputs

The baseline scripts are:

- `scripts/tool_output_cache_math.py`
- `scripts/turn_by_turn_cache_estimator.py`
- `scripts/turn_by_turn_same_turn_summary_estimator.py`
- `scripts/user_turn_batch_compression_estimator.py`
- `scripts/session_context_profile.py`

## Phase 1 - Offline Compression Lab

Before runtime integration, make replay/simulation answer:

- normal context cost
- compressed context cost
- exact evidence lost
- projected refetch count
- refetch cost
- cache-read and cache-write split

Next useful script: export the top most expensive user-turn tool batches as
reviewable fixtures so the evidence-card schema is shaped by real outputs.

## Phase 2 - Evidence Cards

Start deterministic before asking models to summarize. Each card should preserve:

- command or path
- retrieval intent
- important files, symbols, diagnostics, and exact snippets
- action taken from the evidence
- unresolved questions
- raw artifact hash
- safe refetch handle when available
- retention decision

## Phase 3 - Runtime Retention Layer

Add the durable pieces to the Pi-derived runtime:

- append-only raw artifact store
- retention states: `fresh`, `exact`, `evidence`, `summary`, `refetch`,
  `discarded`
- context projection that can replace raw outputs with cards on future turns
- cache-aware policy that avoids breaking valuable prompt-cache prefixes too
  early

## Phase 4 - Coding Quality Evals

Create small tasks where compression can fail:

- one useful error hidden in noisy test output
- line numbers shifting after edits
- grep output with many false positives
- build output that is not safe to replay
- stale cards after a file changes

Measure cost reduction and task quality together.

## Phase 5 - Provider Cache Accounting

After the offline and deterministic runtime paths work, add provider-aware
pricing and cache behavior:

- uncached input
- cache writes
- cache reads
- output tokens
- summary-generation tokens
- latency

## First Target

Add an exporter for the most expensive user-turn tool-output batches, inspect the
fixtures manually, then use them to define the first deterministic evidence-card
schema.
