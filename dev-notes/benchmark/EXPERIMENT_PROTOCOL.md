# Experiment Protocol

Use this protocol for every Shunya benchmark run. The goal is to make each
experiment replayable, auditable, and safe for future agents to interpret.

## Non-Negotiables

- Use a unique run directory for every experiment.
- Do not overwrite traces, sessions, experiments, or evaluation outputs from
  another run.
- Keep Pi Native and Shunya identical except for the harness behavior being
  tested.
- Record the hypothesis before running.
- Record the conclusion only after artifacts verify.
- Treat missing-artifact reports as blockers, not results.

## Run Directory Layout

Preferred layout:

```text
dev-notes/benchmark/runs/<run-id>/
  RUN.md
  config.json
  results.csv
  summary.md
  verification.json
  TESTS.md
  commands.log
  traces/
    pi-native/
    shunya/
  sessions/
    pi-native/
    shunya/
  experiments/
    evaluation/lite/<submission>/
  swebench-eval-runs/
  prompts/
  logs/
```

Use the old `dev-notes/benchmark/results/<name>/` layout only for legacy runs.
New runs should use `dev-notes/benchmark/runs/<run-id>/`.

## Run ID Convention

Use:

```text
YYYYMMDD_<scope>_<hypothesis>_<model>
```

Examples:

- `20260701_vps-docker-20_baseline-shunya_gpt-5.4-mini`
- `20260701_astropy-retain-call-ids_retry_gpt-5.4-mini`

Keep names stable after artifacts are created.

## Required `RUN.md`

Each run needs a short `RUN.md` with:

- run id
- date
- local path
- VPS path, if used
- git commit and dirty diff summary
- model and provider
- goal plugin and version
- variants
- task list
- hypothesis
- exact commands
- validation command and result
- conclusion
- follow-up work

## Required `TESTS.md`

Every run needs a readable test ledger at `TESTS.md`. This is the place future
agents should inspect before trusting the result.

Use this shape:

```markdown
# Test Ledger

## Summary

- Overall status: pass/fail/blocked
- Final verifier: <command or evaluator>
- Evidence root: <relative path>

## Test Matrix

| Check | Command or source | Scope | Status | Evidence |
| --- | --- | --- | --- | --- |
| Agent run | `<command>` | pi-native/shunya | pass | `logs/...` |
| SWE-bench eval | `<command>` | all tasks | pass | `swebench-eval-runs/...` |
| Artifact verification | `<command>` | run root | pass | `verification.json` |

## Notes

- Important failures, flakes, retries, or manual interpretation.
- Why any skipped check was acceptable.
- Whether the run is canonical, exploratory, or invalid.
```

Rules:

- Record every validator, evaluator, smoke test, or manual check used to judge
  the run.
- Link each row to a file inside the run directory when possible.
- Mark skipped checks explicitly. Do not omit them.
- If a check fails and is later rerun, keep both entries with timestamps or
  ordering notes.
- `RUN.md` should summarize the outcome. `TESTS.md` should hold the detailed
  evidence ledger.

## Root Isolation Rule

All output roots must be inside the run directory.

For `scripts/swebench-lite-run-docker.mjs`, explicitly set all roots:

```bash
RUN_ROOT=dev-notes/benchmark/runs/<run-id>

node scripts/swebench-lite-run-docker.mjs \
  --config "$RUN_ROOT/config.json" \
  --result-root "$RUN_ROOT" \
  --trace-root "$RUN_ROOT/traces" \
  --session-root "$RUN_ROOT/sessions" \
  --evaluation-root "$RUN_ROOT/swebench-eval-runs" \
  --experiments-root "$RUN_ROOT/experiments" \
  --run-agent \
  --run-evaluation
```

Do not rely on defaults when running retries, subsets, or experimental variants.

## Required Artifacts

A run is complete only when these exist:

- `config.json`
- `results.csv`
- `summary.md`
- `verification.json` with no missing or invalid artifacts
- `TESTS.md` with every test, verifier, and evidence path
- per-task trace JSON for each variant
- per-task session JSONL for each variant, if the agent produced one
- SWE-bench `all_preds.jsonl`
- SWE-bench `patch.diff`
- SWE-bench `report.json`
- SWE-bench `test_output.txt`
- stdout and stderr from each agent run
- exact command log or commands in `RUN.md`

If any are missing, write a blocker in `RUN.md` and do not use the run as
evidence.

## Controlled Variables

Both variants must share:

- task prompt
- task order policy
- model and provider
- auth path and API endpoint
- goal plugin and version
- allowed tools
- Docker task image or image digest
- base commit workspace
- environment variables
- PATH
- permissions
- local-test policy
- timeout policy
- network policy

If any controlled variable differs, record it in `RUN.md` and treat the run as
exploratory.

## Variant Definitions

Use these variant names consistently:

- `pi-native`: vanilla Pi plus the shared goal plugin and benchmark logger only.
- `shunya`: Pi plus the shared goal plugin, benchmark logger, Shunya extension,
  and Shunya harness flag or policy under test.

Do not change the goal plugin between variants.

## Cost Accounting

For each model call, preserve provider usage when available:

- input tokens
- cached-input or cache-read tokens
- cache-write tokens
- output tokens
- reasoning tokens
- total tokens
- model requested
- model returned
- provider
- timestamp
- pricing snapshot used for cost calculation

If provider usage is missing, mark the trace as estimated or incomplete.

## VPS Sync Expectations

The canonical VPS repo path is:

```text
/opt/Shunya-agent
```

Use:

```bash
ssh hermes 'cd /opt/Shunya-agent && git status --short'
```

Before copying or comparing VPS artifacts, record whether the VPS worktree has
uncommitted changes. Do not assume local and VPS artifacts match unless paths,
timestamps, and summaries have been checked.

## What To Commit

Good candidates to commit:

- configs
- summaries
- CSVs
- verification JSON
- protocol notes
- compact trace samples when needed for debugging

Usually do not commit:

- full SWE-bench workspaces
- huge raw sessions
- huge trace payloads
- Docker build outputs
- transient logs

If a large artifact is necessary evidence, document why in `RUN.md`.

## Validation Checklist

Before drawing conclusions:

1. `verification.json` reports no missing artifacts.
2. Results CSV rows point at the current run directory.
3. Pi Native and Shunya used the same task config.
4. Trace/session/evaluation roots are isolated under the run directory.
5. SWE-bench reports were copied back into the experiments layout.
6. Cost totals match trace usage totals.
7. Failures have a concrete reason or are labeled unresolved by the evaluator.
8. `TESTS.md` records all checks, pass/fail status, skipped checks, and evidence paths.
9. `dev-notes/benchmark/INDEX.md` is updated if the run changes the next step.
10. `progress.md` records the run and outcome.

## Invalidating A Run

Mark a run non-canonical if:

- roots point outside the run directory
- artifacts were overwritten
- variants used different prompts, model, goal plugin, or task environment
- results were generated from missing-artifact summaries
- evaluation was not run or reports are absent
- trace cost accounting is incomplete and not labeled as such

Record invalidation in both `RUN.md` and `dev-notes/benchmark/INDEX.md`.
