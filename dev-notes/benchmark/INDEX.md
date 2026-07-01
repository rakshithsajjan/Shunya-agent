# Benchmark Index

This is the first file to read before changing Shunya benchmark scripts,
results, or agent behavior based on benchmark results.

## Current Question

For the same SWE-bench Lite task, model, goal plugin, and Docker task
environment, can Shunya match Pi Native quality while reducing useful token
cost?

## Canonical Run

Current baseline:

- Run name: VPS Docker 20-task Pi Native vs Shunya
- Local result path: `dev-notes/benchmark/results/swebench-lite-vps-docker-20/`
- VPS repo path: `/opt/Shunya-agent`
- VPS access: `ssh hermes`
- Model: `gpt-5.4-mini`
- Goal plugin: `@narumitw/pi-goal@0.9.2`
- Runner: `scripts/swebench-lite-run-docker.mjs`
- Launch wrapper: `scripts/swebench-lite-vps-20.sh`
- Summary: `dev-notes/benchmark/results/swebench-lite-vps-docker-20/summary-20-tasks.md`
- CSV: `dev-notes/benchmark/results/swebench-lite-vps-docker-20/results-20-tasks.csv`

Result:

| Variant | Tasks | Successes | Success rate | Cost USD | Cost/success | Tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `pi-native` | 20 | 15 | 75.0% | 1.538622 | 0.102575 | 7,498,916 |
| `shunya` | 20 | 13 | 65.0% | 1.691311 | 0.130101 | 8,132,697 |

Observed signal:

- Shunya saved cost on several Astropy tasks.
- Shunya had higher total cost across all 20 tasks because short Django tasks
  paid prompt/schema overhead.
- Shunya lost correctness on two Astropy tasks that Pi Native solved:
  `astropy__astropy-14182` and `astropy__astropy-14365`.

## Current Regression Targets

Investigate these first:

1. `astropy__astropy-14182`
2. `astropy__astropy-14365`

Why:

- Pi Native solved both in the canonical run.
- Shunya failed both in the canonical run.
- They are likely tied to compression losing exact evidence needed later.

## Latest Candidate Fix

Current local code change under investigation:

- `packages/agent/src/harness/retention-policy.ts`
- `packages/agent/test/harness/retention-policy.test.ts`

Concept:

- `store_evidence` can include `retain_call_ids`.
- Matching tool results stay exact in later projected context.
- This should preserve critical traces, failing tests, or file snippets while
  still compressing the rest of the turn.

## Contaminated Or Non-Canonical Runs

Do not treat these as clean evidence without rechecking artifact roots:

- `dev-notes/benchmark/results/swebench-lite-vps-docker-retry/`

Reason:

- The retry wrapper passed `--result-root`, but the runner's default
  `traceRoot`, `sessionRoot`, `evaluationRoot`, and `experimentsRoot` did not
  automatically move under that result root.
- On the VPS, retry CSV rows pointed at
  `dev-notes/benchmark/results/swebench-lite-vps-docker-20/traces/...`.
- Some retry traces may have overwritten or contaminated canonical trace paths.

Use the retry run only as a clue. Rerun in a fresh isolated run directory before
drawing conclusions.

## Artifact Map

Local durable artifacts:

- `dev-notes/benchmark/benchmarking-first-principles.md`
- `dev-notes/benchmark/schema/run-trace.schema.json`
- `dev-notes/benchmark/results/swebench-lite-vps-docker-20/`
- `dev-notes/benchmark/results/swebench-lite-vps-docker-retry/`
- `dev-notes/benchmark/experiments-local/`
- `logs/build_images/`
- `logs/run_evaluation/`

VPS artifacts:

- Repo: `/opt/Shunya-agent`
- Root eval JSONs: `/root/*shunya*json`, `/root/*pi-native*json`
- Evaluation logs: `/root/logs/run_evaluation/`
- Docker benchmark outputs: `/opt/Shunya-agent/dev-notes/benchmark/results/`
- Experiments layout: `/opt/Shunya-agent/dev-notes/benchmark/experiments-vps-docker/`

Root-level local probe JSONs should be classified before moving:

- `gold.shunya_django_probe.json`
- `gold.shunya_django_probe2.json`
- `pi-native-gpt-5.4-mini.shunya_pi-native_1.json`

## Next Recommended Experiment

Run a clean two-task Astropy retry after fixing root isolation:

1. Create a unique run directory under `dev-notes/benchmark/runs/`, for example:
   `dev-notes/benchmark/runs/20260701_astropy-retain-call-ids_retry_gpt-5.4-mini/`
2. Ensure `resultRoot`, `traceRoot`, `sessionRoot`, `evaluationRoot`, and
   `experimentsRoot` all point under that directory.
3. Run only:
   - `astropy__astropy-14182`
   - `astropy__astropy-14365`
4. Compare against the canonical 20-task run, not the contaminated retry run.
5. Decide whether `retain_call_ids` restores correctness and what cost it adds.

## Test Evidence Rule

Every new run must include `TESTS.md` in its run directory. It should be a
human-readable ledger of all checks used to judge the run:

- agent run status
- SWE-bench evaluation status
- artifact verification status
- any focused unit or integration tests
- skipped checks and why they were acceptable
- links to logs, reports, traces, and verification files

If `TESTS.md` is missing or incomplete, the run is not canonical.

## Commands To Inspect State

Read local summaries:

```bash
cat dev-notes/benchmark/results/swebench-lite-vps-docker-20/summary-20-tasks.md
cat dev-notes/benchmark/results/swebench-lite-vps-docker-20/results-20-tasks.csv
```

Inspect VPS benchmark state:

```bash
ssh hermes 'cd /opt/Shunya-agent && git status --short'
ssh hermes 'cd /opt/Shunya-agent && find dev-notes/benchmark/results -maxdepth 3 -type f | sort'
```

## Update Rules

Update this file when:

- a new run becomes canonical
- a run is found contaminated or invalid
- regression targets change
- the next recommended experiment changes
- artifact paths move
