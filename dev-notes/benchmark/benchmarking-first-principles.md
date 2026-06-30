# Benchmarking From First Principles

The benchmark exists to answer one question:

> For the same task and same model, does the custom harness produce the same or
> better answer quality at lower cost than vanilla Pi?

This is a controlled experiment. The comparison is useful only when the task,
model, prompt, tools, workspace, and environment are the same. The only intended
difference is the harness behavior.

## V1 Benchmark Decision

Use SWE-bench Lite as the benchmark source, but run only a fixed 10-task subset
for the first comparison.

Run each selected task with:

- Pi Native baseline
- Shunya harness
- `gpt-5.4-mini`
- the same goal plugin: `@narumitw/pi-goal`

The first report should compare both quality and cost:

- task success
- patch produced
- runtime
- tool-call count
- input, cached-input, cache-write, output, and reasoning tokens when available
- total estimated cost
- cost per successful task
- qualitative failure reason for each failed task

The reason to use the same goal plugin for both agents is isolation. Goal
persistence, continuation behavior, optional token budgets, and explicit
completion signaling should be shared infrastructure, not part of the harness
difference being measured.

Do not build a custom goal system for v1, and do not compare goal plugins in
v1. Only harness behavior may differ. Use the same pinned
`@narumitw/pi-goal` version for both Pi Native and Shunya.

Install the shared goal layer:

```bash
pi install npm:@narumitw/pi-goal
```

The current reviewed version is `@narumitw/pi-goal@0.9.2`; pin that exact
version unless a later review deliberately changes it.

Optional run-observability plugins are useful, but should be treated as
instrumentation rather than benchmark logic:

```bash
pi install npm:@narumitw/pi-statusline
pi install npm:@alexanderfortin/pi-token-usage
```

Use the SWE-bench experiments repository layout for saved quality evidence:

- `evaluation/lite/<date_model>/all_preds.jsonl`
- `evaluation/lite/<date_model>/metadata.yaml`
- `evaluation/lite/<date_model>/README.md`
- `evaluation/lite/<date_model>/trajs/<instance_id>.*`
- `evaluation/lite/<date_model>/logs/<instance_id>/patch.diff`
- `evaluation/lite/<date_model>/logs/<instance_id>/report.json`
- `evaluation/lite/<date_model>/logs/<instance_id>/test_output.txt`

The normalized Shunya trace is an extra local sidecar for cost accounting, not a
replacement for SWE-bench evaluation logs. Keep it outside the experiments
submission directory so `python -m analysis.get_results` can prune and
regenerate submission results without deleting Shunya comparison metadata.

Pinned local verification tasks:

1. `django__django-10914`
2. `django__django-10924`
3. `django__django-11001`

The first local Astropy candidates were rejected for this machine because the
SWE-bench `linux/amd64` Astropy image build was unstable under Apple Silicon
emulation. The local v1 smoke subset uses Django tasks until the Docker
execution path is stable enough to include C-extension-heavy repositories.

Use task 1 for the first paired smoke comparison. Use tasks 1-3 for the first
three-task comparison. The broader 10-task subset should stay blocked until
these local artifacts verify cleanly.

## Benchmark Work Plan

Track the benchmark as a sequence of small, auditable tasks. Do not advance to
the next task until the current one has a saved artifact or a written blocker.

1. Goal plugin review
   - Confirm the shared goal plugin for both Pi Native and Shunya.
   - Decision: pinned `@narumitw/pi-goal`, currently `0.9.2`.
   - Verify identical start, pause, resume, clear, and completion behavior in
     Pi Native and Shunya.
   - Confirm goal continuations align with Shunya `api_call_usage` and
     `turn_usage` sidecars.
   - Confirm `store_evidence` still runs after the last tool batch, not inside a
     plugin-specific continuation loop.
   - Output: short rationale plus integration-check notes.

2. Runner surface inventory
   - Identify the exact command for a Pi Native benchmark run.
   - Identify the exact command for a Shunya benchmark run.
   - Confirm how to pass `gpt-5.4-mini`, the goal prompt, the task workspace,
     and the token budget.
   - Output: command templates for both variants.

3. Trace format lock
   - Finalize the per-run trace JSON schema.
   - Include model, goal plugin, token budget, API usage, pricing snapshot,
     produced patch path, grader result, stdout, stderr, and environment summary.
   - Output: checked-in schema or documented JSON example.

4. SWE-bench Lite adapter
   - Load one SWE-bench Lite instance into an isolated workspace.
   - Produce the normalized prompt, repository checkout, base commit, grader
     config, experiments-style prediction, log folder, and trajectory.
   - Output: one normalized task descriptor plus one experiments-compatible
     local submission folder.

5. First paired dry run
   - Run one selected SWE-bench Lite task with Pi Native.
   - Run the same task with Shunya.
   - Use the same model, goal plugin, prompt, Docker task image, environment,
     and token budget.
   - Output: two trace files, two patches, and one derived CSV row pair.

6. First result audit
   - Compare the two traces by success, cost, tool-call count, runtime, and
     failure mode.
   - Verify the saved evidence is sufficient to explain the result without
     rerunning.
   - Output: one `summary.md` section for the paired task.

7. Freeze the 10-task subset
   - Select 10 SWE-bench Lite tasks only after the first paired dry run works.
   - Prefer a mix of repositories and failure modes while keeping runtime
     manageable.
   - Output: checked-in task list with task ids and selection rationale.

8. Run the remaining 9 tasks
   - Execute each task as a Pi Native/Shunya pair.
   - Stop after each pair if traces or grader output are incomplete.
   - Output: complete trace set, patches, `results.csv`, and `summary.md`.

9. Cost and quality report
   - Report success rate, total cost, cost per successful task, token categories,
     runtime, and qualitative failure reasons.
   - Separate observed savings from claims about quality.
   - Output: final benchmark report.

## What Must Be Controlled

Each task should run twice:

- once with the Pi baseline harness
- once with the custom Shunya harness

Both runs must use the same:

- task prompt
- repository or fixture files
- allowed tools
- model and provider
- auth path and API endpoint
- working directory shape
- environment variables
- task order
- SWE-bench Lite task subset
- goal plugin and goal prompt
- token budget, if used
- container image digest or Dockerfile plus build args
- mounted workspace contents and permissions

If more than the harness changes, the cost or quality difference cannot be
trusted.

## Dockerized Agent Execution

The next benchmark run must execute the agents inside a Docker task container,
not only verify their patches with Docker after the fact.

This is required because the first one-task run exposed a confound: the two
agents used separate host workspaces, but local tool behavior and test attempts
depended on the host Python, installed tools, warmed caches, and prior Docker
state. Even when both variants solve the same task, those differences can change
how much setup, dependency probing, and test-discovery work each agent performs.

For the next fair run:

- Build or prepare one task container for the SWE-bench instance.
- Start both Pi Native and Shunya from the same container image digest.
- Mount or copy a fresh checkout at the same base commit for each run.
- Use the same environment variables, PATH, Python, package manager state,
  locale, user, working directory, file permissions, and network policy.
- Predefine whether dependency installation and local tests are allowed.
- Do not let the second variant reuse a mutated workspace, installed packages,
  build outputs, or generated files from the first variant.
- Keep SWE-bench `run_evaluation` as the final grader that applies the produced
  patch and writes `report.json` plus `test_output.txt`.

Order effects still matter. Run paired tasks in both orders:

- task A: Pi Native first, Shunya second
- task B: Shunya first, Pi Native second

Only compare token/cost deltas after the container image, task prompt, tool
surface, goal layer, and local-test policy are identical.

## What Must Be Measured

For every model API call, keep the raw usage metadata when the provider returns
it:

- input tokens
- cached input tokens, or cache-read tokens
- cache-write tokens
- long-retention cache-write tokens if reported
- output tokens
- reasoning tokens if reported
- total tokens
- provider
- requested model
- response model if different
- timestamp

Also snapshot the pricing used for that call:

- input price
- output price
- cache-read price
- cache-write price
- any special long-cache pricing rule

This matters because model pricing can change. If the benchmark stores both
usage metadata and the pricing snapshot, task cost can be recomputed later
without depending on today's model catalog.

## Is This Already Done?

The cost-measurement piece is partly done.

Existing useful pieces:

- assistant messages already carry provider `usage` data when available
- Shunya tracing already records `api_call_usage` entries for each captured API
  call
- the current cost code can calculate cost from token usage and model pricing

Missing benchmark pieces:

- a normalized per-run trace file that works for both Pi baseline and Shunya
- a stable per-task result row
- a pricing snapshot saved beside every API call
- fallback token estimation when provider usage is missing
- adapters for external benchmark formats

So the answer is: the raw ingredients are present, but the benchmark packaging
around them is not finished.

## What "Saved Evidence" Means

The benchmark should save enough evidence to debug every result without rerunning
the task.

For each task and variant, save one trace file containing:

- task id
- benchmark name
- variant name
- question and prompts
- ground truth or grader config
- final answer
- success or failure
- runtime
- tool-call count
- all model API-call usage records
- all pricing snapshots
- full agent event stream, if available
- persisted session entries, if available
- stdout and stderr from the runner
- command and environment summary

This is the fourth point from the fundamentals: saved evidence. It is not just a
log dump. It is the audit trail that explains why one run was cheaper, slower,
or more successful than another run.

## How To Tackle Saved Evidence

Start with one trace format:

```json
{
  "benchmark_name": "swe-bench-lite",
  "task_id": "django__django-XXXXX",
  "variant": "baseline",
  "question": "...",
  "ground_truth": "...",
  "goal_plugin": "@narumitw/pi-goal",
  "model": "gpt-5.4-mini",
  "final_answer": "...",
  "success": true,
  "patch_produced": true,
  "runtime_sec": 12.3,
  "tool_calls": 4,
  "api_calls": [],
  "events": [],
  "session_entries": [],
  "stdout": "...",
  "stderr": "...",
  "command": [],
  "environment": {}
}
```

Then make every benchmark adapter produce this same shape. A custom YAML task,
SWE-bench task, or any other external benchmark should all normalize into the
same internal record.

The results CSV should be only the summary layer:

```text
task_id,variant,model,goal_plugin,success,patch_produced,runtime_sec,tool_calls,input_tokens,cached_input_tokens,cache_write_tokens,output_tokens,reasoning_tokens,total_tokens,cost_usd,failure_reason,trace_path
```

The trace JSON is the source of truth. The CSV and summary report are derived
from it.

## Local Experiments Verification

The task list is checked in at
`dev-notes/benchmark/swebench-lite-v1-tasks.json`.

Create the expected local folder skeleton:

```bash
node scripts/swebench-lite-compare.mjs --scaffold --limit 3
```

After running Pi Native and Shunya locally on task 1, place artifacts under:

```text
dev-notes/benchmark/experiments-local/evaluation/lite/20260630_shunya_pi_native_gpt-5.4-mini/
dev-notes/benchmark/experiments-local/evaluation/lite/20260630_shunya_harness_gpt-5.4-mini/
dev-notes/benchmark/results/swebench-lite-v1/traces/pi-native/
dev-notes/benchmark/results/swebench-lite-v1/traces/shunya/
```

Then verify the one-task smoke comparison:

```bash
node scripts/swebench-lite-compare.mjs --limit 1
```

After task 1 verifies, run tasks 1-3 for both variants and verify the
three-task comparison:

```bash
node scripts/swebench-lite-compare.mjs --limit 3
```

Successful verification writes:

- `dev-notes/benchmark/results/swebench-lite-v1/results-1-tasks.csv`
- `dev-notes/benchmark/results/swebench-lite-v1/summary-1-tasks.md`
- `dev-notes/benchmark/results/swebench-lite-v1/results-3-tasks.csv`
- `dev-notes/benchmark/results/swebench-lite-v1/summary-3-tasks.md`

If artifacts are missing, the same command writes a blocker summary and exits
non-zero. Do not treat missing-artifact summaries as benchmark results.

## Minimal Build Order

1. Define the trace JSON format.
2. Select and freeze the SWE-bench Lite 10-task subset.
3. Install `@narumitw/pi-goal` for both Pi Native and Shunya.
4. Run one selected task against Pi Native with `gpt-5.4-mini` and save a trace.
5. Run the same selected task against Shunya with `gpt-5.4-mini` and save a
   trace.
6. Extract API-call usage and pricing snapshots into `api_calls`.
7. Aggregate trace records into `results.csv`.
8. Generate `summary.md`.
9. Run the remaining 9 tasks only after the first paired task is explainable end
   to end.

Do not start with all 10 tasks at once. First make one SWE-bench Lite task
explainable end to end, then scale to the frozen 10-task subset.

## Proxy Or Not?

Do not add a proxy in v1.

Use provider usage metadata first. A proxy is only useful later if we need an
independent audit of provider payloads or if a provider path does not expose
usage metadata. A proxy adds moving parts before the basic experiment is
trustworthy.
