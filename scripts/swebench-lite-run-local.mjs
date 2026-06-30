#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const DEFAULT_CONFIG = "dev-notes/benchmark/swebench-lite-v1-tasks.json";
const DEFAULT_WORK_ROOT = "dev-notes/benchmark/workspaces/swebench-lite-v1";
const DEFAULT_EXPERIMENTS_ROOT = "dev-notes/benchmark/experiments-local";
const DEFAULT_TRACE_ROOT = "dev-notes/benchmark/results/swebench-lite-v1/traces";
const DEFAULT_SESSION_ROOT = "dev-notes/benchmark/results/swebench-lite-v1/sessions";
const DEFAULT_EVALUATION_ROOT = "dev-notes/benchmark/swebench-eval-runs";
const DEFAULT_GOAL_EXTENSION = ".pi/npm/node_modules/@narumitw/pi-goal/src/goal.ts";
const DEFAULT_PROVIDER = "openai";
const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_PRICING = {
	currency: "USD",
	input_per_1m_tokens: 0.75,
	cache_read_per_1m_tokens: 0.075,
	cache_write_per_1m_tokens: 0,
	output_per_1m_tokens: 4.5,
};

function parseArgs(argv) {
	const args = {
		config: DEFAULT_CONFIG,
		workRoot: DEFAULT_WORK_ROOT,
		experimentsRoot: DEFAULT_EXPERIMENTS_ROOT,
		traceRoot: DEFAULT_TRACE_ROOT,
		sessionRoot: DEFAULT_SESSION_ROOT,
		evaluationRoot: DEFAULT_EVALUATION_ROOT,
		goalExtension: DEFAULT_GOAL_EXTENSION,
		provider: DEFAULT_PROVIDER,
		model: DEFAULT_MODEL,
		variant: "both",
		limit: 1,
		runAgent: false,
		runEvaluation: false,
		force: false,
		envFile: ".env",
		collectExisting: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--config") args.config = argv[++i];
		else if (arg === "--work-root") args.workRoot = argv[++i];
		else if (arg === "--experiments-root") args.experimentsRoot = argv[++i];
		else if (arg === "--trace-root") args.traceRoot = argv[++i];
		else if (arg === "--session-root") args.sessionRoot = argv[++i];
		else if (arg === "--evaluation-root") args.evaluationRoot = argv[++i];
		else if (arg === "--goal-extension") args.goalExtension = argv[++i];
		else if (arg === "--provider") args.provider = argv[++i];
		else if (arg === "--model") args.model = argv[++i];
		else if (arg === "--variant") args.variant = argv[++i];
		else if (arg === "--limit") args.limit = Number.parseInt(argv[++i], 10);
		else if (arg === "--run-agent") args.runAgent = true;
		else if (arg === "--run-evaluation") args.runEvaluation = true;
		else if (arg === "--force") args.force = true;
		else if (arg === "--env-file") args.envFile = argv[++i];
		else if (arg === "--collect-existing") args.collectExisting = true;
		else if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!["pi-native", "shunya", "both"].includes(args.variant)) {
		throw new Error("--variant must be pi-native, shunya, or both");
	}
	if (!Number.isInteger(args.limit) || args.limit < 1) {
		throw new Error("--limit must be a positive integer");
	}
	return args;
}

function printHelp() {
	console.log(`Usage: node scripts/swebench-lite-run-local.mjs [options]

Prepares and optionally runs local SWE-bench Lite tasks with Pi Native and/or
Shunya. The script writes SWE-bench experiments-style artifacts plus normalized
Shunya benchmark traces consumed by scripts/swebench-lite-compare.mjs.

By default this only prepares workspaces and prompts. Add --run-agent to spend
model tokens. Add --run-evaluation after predictions exist to invoke the
official SWE-bench Docker evaluator when the swebench Python package is present.

Options:
  --limit <n>                 Number of pinned tasks to process
  --variant <name>            pi-native, shunya, or both
  --provider <name>           Pi provider, default: openai
  --model <name>              Pi model, default: gpt-5.4-mini
  --run-agent                 Run pi -p against each task workspace
  --run-evaluation            Run uvx --from swebench python -m swebench.harness.run_evaluation
  --evaluation-root <path>    Root containing SWE-bench evaluator reports
  --goal-extension <path>     pi-goal extension path loaded for both variants
  --env-file <path>           dotenv file loaded into child processes, default: .env
  --collect-existing          Rebuild artifacts from existing session/workspace files
  --force                     Recreate existing task workspaces
`);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

function run(command, commandArgs, options = {}) {
	const result = spawnSync(command, commandArgs, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		encoding: "utf8",
		maxBuffer: 1000 * 1000 * 200,
	});
	if (options.captureOnly) return result;
	if (result.status !== 0) {
		throw new Error(
			[
				`Command failed: ${command} ${commandArgs.join(" ")}`,
				result.stdout.trim(),
				result.stderr.trim(),
			]
				.filter(Boolean)
				.join("\n"),
		);
	}
	return result;
}

function parseEnvFile(path) {
	if (!existsSync(path)) return {};
	const env = {};
	for (const rawLine of readFileSync(path, "utf8").split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		let value = match[2] ?? "";
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		env[match[1]] = value;
	}
	return env;
}

function childEnv(args) {
	return { ...process.env, ...parseEnvFile(args.envFile) };
}

function currentDockerHost() {
	if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
	const result = run("docker", ["context", "inspect"], { captureOnly: true });
	if (result.status !== 0) return undefined;
	try {
		const contexts = JSON.parse(result.stdout);
		return contexts[0]?.Endpoints?.docker?.Host;
	} catch {
		return undefined;
	}
}

function evaluatorEnv(args) {
	const env = childEnv(args);
	env.DOCKER_HOST = env.DOCKER_HOST ?? currentDockerHost() ?? "";
	if (!env.DOCKER_CONFIG) {
		const dockerConfig = join(tmpdir(), "shunya-swebench-docker-config");
		ensureDir(dockerConfig);
		writeJson(join(dockerConfig, "config.json"), { auths: {} });
		env.DOCKER_CONFIG = dockerConfig;
	}
	return env;
}

async function fetchFirstRows() {
	const url = "https://datasets-server.huggingface.co/first-rows?dataset=SWE-bench%2FSWE-bench_Lite&config=default&split=test";
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Failed to fetch SWE-bench Lite rows: ${response.status} ${response.statusText}`);
	const body = await response.json();
	return body.rows.map((entry) => entry.row);
}

function selectVariants(config, variantName) {
	if (variantName === "both") return config.variants;
	return config.variants.filter((variant) => variant.name === variantName);
}

function ensureDir(path) {
	mkdirSync(path, { recursive: true });
}

function writeIfMissing(path, content) {
	if (!existsSync(path)) writeFileSync(path, content, "utf8");
}

function workspacePath(args, variant, task) {
	return join(args.workRoot, variant.name, task.instance_id);
}

function cloneTaskWorkspace(args, variant, task, row) {
	const workspace = workspacePath(args, variant, task);
	const workspaceExists = existsSync(workspace);
	if (existsSync(workspace) && args.force) rmSync(workspace, { recursive: true, force: true });
	if (!existsSync(workspace)) {
		ensureDir(dirname(workspace));
		run("git", ["clone", "--no-tags", `https://github.com/${row.repo}.git`, workspace]);
	}
	if (!args.collectExisting || !workspaceExists) {
		run("git", ["checkout", row.base_commit], { cwd: workspace, env: childEnv(args) });
	}
	if (!args.collectExisting) {
		run("git", ["reset", "--hard", row.base_commit], { cwd: workspace, env: childEnv(args) });
		run("git", ["clean", "-fd"], { cwd: workspace, env: childEnv(args) });
	}
	return workspace;
}

function buildPrompt(row) {
	return [
		`SWE-bench Lite instance: ${row.instance_id}`,
		`Repository: ${row.repo}`,
		"",
		"Fix the bug described below by editing the repository files.",
		"Do not use SWE-bench hints, FAIL_TO_PASS, PASS_TO_PASS, or the reference patch.",
		"Do not browse the web for the solution.",
		"After editing, run a focused local check if it is practical, then stop.",
		"",
		"Problem statement:",
		row.problem_statement,
	].join("\n");
}

function buildGoalPrompt(row) {
	return [
		"Goal-mode benchmark instruction: complete this SWE-bench Lite task end-to-end. Edit the repository to fix the reported bug, avoid SWE-bench hints and reference patches, run a focused local check when practical, produce a patch, and stop only after the task is ready for official local SWE-bench evaluation.",
		"",
		`Instance: ${row.instance_id}`,
		`Repository: ${row.repo}`,
		"",
		"Problem statement:",
		row.problem_statement,
	].join("\n");
}

function experimentsSubmissionPath(args, variant) {
	return join(args.experimentsRoot, variant.submission_dir);
}

function ensureSubmission(args, config, variant, tasks) {
	const submissionPath = experimentsSubmissionPath(args, variant);
	ensureDir(join(submissionPath, "logs"));
	ensureDir(join(submissionPath, "trajs"));
	writeIfMissing(
		join(submissionPath, "metadata.yaml"),
		`info:\n  name: Shunya ${variant.name} local benchmark\n  report: dev-notes/benchmark/benchmarking-first-principles.md\n  authors: Rakshith Sajjan\n  site: https://github.com/swe-bench/experiments\n  logo: null\ntags:\n  checked: false\n  model:\n    - ${args.model}\n  org:\n    - Shunya-agent\n  os_model: false\n  os_system: true\n  system:\n    attempts: "1"\n`,
	);
	writeIfMissing(
		join(submissionPath, "README.md"),
		`# Shunya ${variant.name} Local SWE-bench Lite Run\n\nRun generated predictions through the official SWE-bench harness, then compare with:\n\n\`\`\`bash\nnode scripts/swebench-lite-compare.mjs --limit ${tasks.length}\n\`\`\`\n`,
	);
	return submissionPath;
}

function collectAssistantText(messages) {
	const assistant = [...messages].reverse().find((message) => message.type === "message" && message.message?.role === "assistant");
	const content = assistant?.message?.content ?? [];
	return content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function usageFromSession(messages) {
	const calls = [];
	let index = 0;
	for (const entry of messages) {
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "assistant" || !message.usage) continue;
		index += 1;
		const usage = message.usage;
		const inputTokens = usage.input ?? 0;
		const cachedInputTokens = usage.cacheRead ?? 0;
		const cacheWriteTokens = usage.cacheWrite ?? 0;
		const outputTokens = usage.output ?? 0;
		const reasoningTokens = usage.reasoning ?? 0;
		calls.push({
			call_id: `${entry.id ?? "assistant"}:${index}`,
			provider: message.provider ?? "unknown",
			requested_model: message.model ?? "unknown",
			response_model: message.model ?? "unknown",
			timestamp: entry.timestamp,
			usage: {
				input_tokens: inputTokens,
				cached_input_tokens: cachedInputTokens,
				cache_write_tokens: cacheWriteTokens,
				output_tokens: outputTokens,
				reasoning_tokens: reasoningTokens,
				total_tokens: usage.totalTokens ?? inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens,
			},
			pricing_snapshot: DEFAULT_PRICING,
			cost_usd: usage.cost?.total ?? 0,
		});
	}
	return calls;
}

function readJsonl(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function latestSessionFile(sessionDir) {
	if (!existsSync(sessionDir)) return undefined;
	const candidates = readdirSync(sessionDir)
		.filter((name) => name.endsWith(".jsonl") && !name.endsWith(".shunya.trace.jsonl") && !name.endsWith(".compressed.jsonl"))
		.map((name) => join(sessionDir, name))
		.sort();
	return candidates.at(-1);
}

function writeTrace(args, config, variant, task, row, workspace, sessionFile, stdout, stderr, command) {
	const sessionEntries = sessionFile ? readJsonl(sessionFile) : [];
	const patchResult = run("git", ["diff", "--binary"], { cwd: workspace, captureOnly: true });
	const patch = patchResult.stdout;
	const apiCalls = usageFromSession(sessionEntries);
	const tracePath = join(args.traceRoot, variant.name, `${task.instance_id}.trace.json`);
	ensureDir(dirname(tracePath));
	writeJson(tracePath, {
		benchmark_name: config.benchmark_name,
		task_id: task.instance_id,
		variant: variant.name,
		question: row.problem_statement,
		ground_truth: "SWE-bench evaluator report.json",
		goal_plugin: config.goal_plugin,
		goal_plugin_version: config.goal_plugin_version,
		model: args.model,
		token_budget: null,
		final_answer: collectAssistantText(sessionEntries),
		success: false,
		patch_produced: patch.trim().length > 0,
		patch_path: relative(process.cwd(), join(experimentsSubmissionPath(args, variant), "logs", task.instance_id, "patch.diff")),
		runtime_sec: null,
		tool_calls: sessionEntries.filter((entry) => entry.type === "message" && entry.message?.role === "toolCall").length,
		api_calls: apiCalls,
		events: [],
		session_entries: sessionEntries,
		stdout,
		stderr,
		command,
		environment: {
			provider: args.provider,
			model: args.model,
			goal_extension: relative(process.cwd(), resolve(args.goalExtension)),
			workspace: relative(process.cwd(), workspace),
			session_file: sessionFile ? relative(process.cwd(), sessionFile) : null,
		},
		failure_reason: "not evaluated yet",
	});
	return { tracePath, patch };
}

function writeRunArtifacts(args, variant, task, traceResult, stdout, stderr) {
	const submissionPath = experimentsSubmissionPath(args, variant);
	const logPath = join(submissionPath, "logs", task.instance_id);
	ensureDir(logPath);
	writeFileSync(join(logPath, "patch.diff"), traceResult.patch, "utf8");
	writeFileSync(join(logPath, "test_output.txt"), "SWE-bench evaluation has not been run yet.\n", "utf8");
	writeJson(join(logPath, "report.json"), {
		[task.instance_id]: {
			resolved: false,
		},
	});
	writeFileSync(join(submissionPath, "trajs", `${task.instance_id}.jsonl`), stdout, "utf8");
	writeFileSync(join(logPath, "agent.stderr.txt"), stderr, "utf8");
}

function updatePredictions(args, variant, tasks) {
	const submissionPath = experimentsSubmissionPath(args, variant);
	const lines = [];
	for (const task of tasks) {
		const patchPath = join(submissionPath, "logs", task.instance_id, "patch.diff");
		if (!existsSync(patchPath)) continue;
		lines.push(
			JSON.stringify({
				instance_id: task.instance_id,
				model_name_or_path: `${variant.name}-${args.model}`,
				model_patch: readFileSync(patchPath, "utf8"),
			}),
		);
	}
	writeFileSync(join(submissionPath, "all_preds.jsonl"), `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`, "utf8");
}

function runAgent(args, variant, task, row, workspace, config) {
	const sessionDir = resolve(join(args.sessionRoot, variant.name, task.instance_id));
	if (existsSync(sessionDir) && args.force) rmSync(sessionDir, { recursive: true, force: true });
	ensureDir(sessionDir);
	const piScript = resolve("pi-test.sh");
	const costLoggerPath = resolve(".pi/extensions/cost-logger.ts");
	const shunyaPath = resolve(".pi/extensions/shunya.ts");
	const goalExtensionPath = resolve(args.goalExtension);
	const prompt = buildPrompt(row);
	const goalPrompt = buildGoalPrompt(row);
	const commandArgs = [
		"--mode",
		"json",
		"--provider",
		args.provider,
		"--model",
		args.model,
		"--session-dir",
		sessionDir,
		"--append-system-prompt",
		goalPrompt,
		"--extension",
		goalExtensionPath,
		"--extension",
		costLoggerPath,
		"--approve",
		"-p",
		prompt,
	];
	if (variant.name === "shunya") {
		commandArgs.splice(commandArgs.indexOf("--approve"), 0, "--extension", shunyaPath, "--shunya");
	}
	const started = Date.now();
	const result = run(piScript, commandArgs, { cwd: workspace, env: childEnv(args), captureOnly: true });
	const runtimeSec = (Date.now() - started) / 1000;
	const sessionFile = latestSessionFile(sessionDir);
	const command = [piScript, ...commandArgs];
	const traceResult = writeTrace(args, config, variant, task, row, workspace, sessionFile, result.stdout, result.stderr, command);
	const trace = readJson(traceResult.tracePath);
	trace.runtime_sec = runtimeSec;
	trace.failure_reason = result.status === 0 ? "not evaluated yet" : `agent exited ${result.status}`;
	writeJson(traceResult.tracePath, trace);
	writeRunArtifacts(args, variant, task, traceResult, result.stdout, result.stderr);
	if (result.status !== 0) throw new Error(`Agent failed for ${variant.name}/${task.instance_id}: ${result.stderr || result.stdout}`);
}

function collectExistingArtifacts(args, config, variant, task, row, workspace) {
	const sessionDir = resolve(join(args.sessionRoot, variant.name, task.instance_id));
	const sessionFile = latestSessionFile(sessionDir);
	if (!sessionFile) throw new Error(`No existing session file for ${variant.name}/${task.instance_id} in ${sessionDir}`);
	const submissionPath = experimentsSubmissionPath(args, variant);
	const logPath = join(submissionPath, "logs", task.instance_id);
	const trajPath = join(submissionPath, "trajs", `${task.instance_id}.jsonl`);
	const stdout = existsSync(trajPath) ? readFileSync(trajPath, "utf8") : "";
	const stderrPath = join(logPath, "agent.stderr.txt");
	const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : "";
	const command = ["existing-session", relative(process.cwd(), sessionFile)];
	const traceResult = writeTrace(args, config, variant, task, row, workspace, sessionFile, stdout, stderr, command);
	writeRunArtifacts(args, variant, task, traceResult, stdout, stderr);
}

function runEvaluation(args, variant, tasks) {
	const submissionPath = experimentsSubmissionPath(args, variant);
	const instanceIds = tasks.map((task) => task.instance_id);
	const runId = `shunya_${variant.name}_${tasks.length}`;
	const reportDir = join(args.evaluationRoot, `${variant.name}-${tasks.length}`);
	ensureDir(reportDir);
	const result = run(
		"uvx",
		[
			"--from",
			"swebench",
			"python",
			"-m",
			"swebench.harness.run_evaluation",
			"--dataset_name",
			"SWE-bench/SWE-bench_Lite",
			"--predictions_path",
			join(submissionPath, "all_preds.jsonl"),
			"--run_id",
			runId,
			"--max_workers",
			"1",
			"--namespace",
			"none",
			"--report_dir",
			reportDir,
			"--instance_ids",
			...instanceIds,
		],
		{ env: evaluatorEnv(args), captureOnly: true },
	);
	writeFileSync(join(submissionPath, "swebench-evaluation.stdout.txt"), result.stdout, "utf8");
	writeFileSync(join(submissionPath, "swebench-evaluation.stderr.txt"), result.stderr, "utf8");
	if (result.status !== 0) throw new Error(`SWE-bench evaluation failed for ${variant.name}: ${result.stderr || result.stdout}`);
	copyEvaluationArtifacts(args, variant, tasks, runId);
}

function copyEvaluationArtifacts(args, variant, tasks, runId) {
	const submissionPath = experimentsSubmissionPath(args, variant);
	for (const task of tasks) {
		const modelName = `${variant.name}-${args.model}`.replaceAll("/", "__");
		const evalLogPath = join("logs", "run_evaluation", runId, modelName, task.instance_id);
		const logPath = join(submissionPath, "logs", task.instance_id);
		const reportPath = join(evalLogPath, "report.json");
		const testOutputPath = join(evalLogPath, "test_output.txt");
		if (!existsSync(reportPath)) throw new Error(`Missing SWE-bench report: ${reportPath}`);
		if (!existsSync(testOutputPath)) throw new Error(`Missing SWE-bench test output: ${testOutputPath}`);
		copyFileSync(reportPath, join(logPath, "report.json"));
		copyFileSync(testOutputPath, join(logPath, "test_output.txt"));
		const tracePath = join(args.traceRoot, variant.name, `${task.instance_id}.trace.json`);
		if (existsSync(tracePath)) {
			const trace = readJson(tracePath);
			const report = readJson(reportPath);
			const resolved = report[task.instance_id]?.resolved;
			trace.success = resolved === true;
			trace.failure_reason = resolved === true ? "" : "SWE-bench evaluator unresolved";
			writeJson(tracePath, trace);
		}
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const config = readJson(args.config);
	const tasks = config.tasks.slice(0, args.limit);
	const variants = selectVariants(config, args.variant);
	const rows = await fetchFirstRows();
	for (const variant of variants) {
		ensureSubmission(args, config, variant, tasks);
		for (const task of tasks) {
			const row = rows.find((candidate) => candidate.instance_id === task.instance_id);
			if (!row) throw new Error(`Could not find task data for ${task.instance_id}`);
			const workspace = cloneTaskWorkspace(args, variant, task, row);
			const promptPath = join(workspace, ".shunya-swebench-prompt.md");
			writeFileSync(promptPath, buildPrompt(row), "utf8");
			if (args.collectExisting) collectExistingArtifacts(args, config, variant, task, row, workspace);
			else if (args.runAgent) runAgent(args, variant, task, row, workspace, config);
		}
		updatePredictions(args, variant, tasks);
		if (args.runEvaluation) runEvaluation(args, variant, tasks);
	}
	console.log(
		`${args.runAgent ? "Ran" : "Prepared"} ${tasks.length} task(s) for ${variants.map((variant) => variant.name).join(", ")}.`,
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
