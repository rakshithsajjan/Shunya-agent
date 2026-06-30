#!/usr/bin/env node

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";

const DEFAULT_CONFIG = "dev-notes/benchmark/swebench-lite-vps-20-tasks.json";
const DEFAULT_EXPERIMENTS_ROOT = "dev-notes/benchmark/experiments-vps-docker";
const DEFAULT_RESULT_ROOT = "dev-notes/benchmark/results/swebench-lite-vps-docker-20";
const DEFAULT_TRACE_ROOT = `${DEFAULT_RESULT_ROOT}/traces`;
const DEFAULT_SESSION_ROOT = `${DEFAULT_RESULT_ROOT}/sessions`;
const DEFAULT_EVALUATION_ROOT = `${DEFAULT_RESULT_ROOT}/swebench-eval-runs`;
const DEFAULT_PROVIDER = "openai";
const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_GOAL_EXTENSION = ".pi/npm/node_modules/@narumitw/pi-goal/src/goal.ts";
const DEFAULT_NODE_IMAGE = "node:22-bullseye-slim";
const DEFAULT_PRICING = {
	currency: "USD",
	input_per_1m_tokens: 0.75,
	cache_read_per_1m_tokens: 0.075,
	cache_write_per_1m_tokens: 0,
	output_per_1m_tokens: 4.5,
};

const VARIANTS = [
	{
		name: "pi-native",
		submission_dir: "evaluation/lite/20260630_vps_docker_pi_native_gpt-5.4-mini",
	},
	{
		name: "shunya",
		submission_dir: "evaluation/lite/20260630_vps_docker_shunya_gpt-5.4-mini",
	},
];

function parseArgs(argv) {
	const args = {
		config: DEFAULT_CONFIG,
		experimentsRoot: DEFAULT_EXPERIMENTS_ROOT,
		resultRoot: DEFAULT_RESULT_ROOT,
		traceRoot: DEFAULT_TRACE_ROOT,
		sessionRoot: DEFAULT_SESSION_ROOT,
		evaluationRoot: DEFAULT_EVALUATION_ROOT,
		provider: DEFAULT_PROVIDER,
		model: DEFAULT_MODEL,
		goalExtension: DEFAULT_GOAL_EXTENSION,
		envFile: ".env",
		limit: 20,
		variant: "both",
		runAgent: false,
		runEvaluation: false,
		force: false,
		keepImages: false,
		nodeImage: DEFAULT_NODE_IMAGE,
		timeoutSec: 1800,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--config") args.config = argv[++i];
		else if (arg === "--experiments-root") args.experimentsRoot = argv[++i];
		else if (arg === "--result-root") args.resultRoot = argv[++i];
		else if (arg === "--trace-root") args.traceRoot = argv[++i];
		else if (arg === "--session-root") args.sessionRoot = argv[++i];
		else if (arg === "--evaluation-root") args.evaluationRoot = argv[++i];
		else if (arg === "--provider") args.provider = argv[++i];
		else if (arg === "--model") args.model = argv[++i];
		else if (arg === "--goal-extension") args.goalExtension = argv[++i];
		else if (arg === "--env-file") args.envFile = argv[++i];
		else if (arg === "--limit") args.limit = Number.parseInt(argv[++i], 10);
		else if (arg === "--variant") args.variant = argv[++i];
		else if (arg === "--timeout-sec") args.timeoutSec = Number.parseInt(argv[++i], 10);
		else if (arg === "--node-image") args.nodeImage = argv[++i];
		else if (arg === "--run-agent") args.runAgent = true;
		else if (arg === "--run-evaluation") args.runEvaluation = true;
		else if (arg === "--force") args.force = true;
		else if (arg === "--keep-images") args.keepImages = true;
		else if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error("--limit must be a positive integer");
	if (!Number.isInteger(args.timeoutSec) || args.timeoutSec < 60) {
		throw new Error("--timeout-sec must be an integer >= 60");
	}
	if (!["pi-native", "shunya", "both"].includes(args.variant)) {
		throw new Error("--variant must be pi-native, shunya, or both");
	}
	return args;
}

function printHelp() {
	console.log(`Usage: node scripts/swebench-lite-run-docker.mjs [options]

Runs Pi Native and/or Shunya inside SWE-bench Lite Docker task images, saves
experiments-style predictions plus normalized trace JSON, then optionally runs
the official SWE-bench evaluator and derives CSV/Markdown comparison results.

Options:
  --limit <n>                 Number of SWE-bench Lite test rows, default: 20
  --variant <name>            pi-native, shunya, or both
  --run-agent                 Spend model tokens and run agents in Docker
  --run-evaluation            Run official SWE-bench evaluator after agents
  --force                     Remove existing task/variant artifacts first
  --keep-images               Do not remove task runner/base images after agent runs
  --timeout-sec <n>           Per-agent Docker timeout, default: 1800
  --env-file <path>           dotenv file passed to Docker, default: .env
`);
}

function run(command, commandArgs, options = {}) {
	const result = spawnSync(command, commandArgs, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		encoding: "utf8",
		maxBuffer: 1000 * 1000 * 250,
		timeout: options.timeoutMs,
	});
	if (options.captureOnly) return result;
	if (result.status !== 0) {
		throw new Error(
			[
				`Command failed: ${command} ${commandArgs.join(" ")}`,
				result.error ? String(result.error) : "",
				result.stdout.trim(),
				result.stderr.trim(),
			]
				.filter(Boolean)
				.join("\n"),
		);
	}
	return result;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
	ensureDir(dirname(path));
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

function ensureDir(path) {
	mkdirSync(path, { recursive: true });
}

async function fetchFirstRows(limit) {
	const url = `https://datasets-server.huggingface.co/rows?dataset=SWE-bench%2FSWE-bench_Lite&config=default&split=test&offset=0&length=${limit}`;
	let body;
	try {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
		body = await response.json();
	} catch (error) {
		const result = run("curl", ["-fsSL", url], { captureOnly: true });
		if (result.status !== 0) {
			throw new Error(
				`Failed to fetch SWE-bench Lite rows: ${error instanceof Error ? error.message : String(error)}\n${result.stderr.trim()}`,
			);
		}
		body = JSON.parse(result.stdout);
	}
	return body.rows.map((entry) => entry.row).slice(0, limit);
}

function selectVariants(args) {
	if (args.variant === "both") return VARIANTS;
	return VARIANTS.filter((variant) => variant.name === args.variant);
}

function taskFromRow(row) {
	return {
		instance_id: row.instance_id,
		repo: row.repo,
		base_commit: row.base_commit,
		version: row.version,
	};
}

function writeConfig(args, rows) {
	const config = {
		benchmark_name: "swe-bench-lite",
		split: "lite",
		source_dataset: "SWE-bench/SWE-bench_Lite",
		source_split: "test",
		selection_date: new Date().toISOString().slice(0, 10),
		selection_rationale:
			"First N SWE-bench Lite test rows for VPS Dockerized Pi Native versus Shunya comparison.",
		model: args.model,
		goal_plugin: "@narumitw/pi-goal",
		goal_plugin_version: "0.9.2",
		variants: VARIANTS,
		tasks: rows.map(taskFromRow),
	};
	writeJson(args.config, config);
	return config;
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

function imageNameForTask(task) {
	return `swebench/sweb.eval.x86_64.${task.instance_id.toLowerCase().replaceAll("__", "_1776_")}:latest`;
}

function safeName(value) {
	return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replaceAll("__", "_");
}

function runnerImageName(task) {
	return `shunya-swebench-agent:${safeName(task.instance_id)}`;
}

function ensureRunnerImage(args, task) {
	const baseImage = imageNameForTask(task);
	const runnerImage = runnerImageName(task);
	run("docker", ["pull", baseImage]);
	const buildDir = join(tmpdir(), `shunya-swebench-runner-${safeName(task.instance_id)}`);
	if (existsSync(buildDir)) rmSync(buildDir, { recursive: true, force: true });
	ensureDir(buildDir);
	writeFileSync(
		join(buildDir, "Dockerfile"),
		[
			`FROM ${args.nodeImage} AS node_source`,
			`FROM ${baseImage}`,
			"COPY --from=node_source /usr/local/bin/node /usr/local/bin/node",
			"COPY --from=node_source /usr/local/bin/npm /usr/local/bin/npm",
			"COPY --from=node_source /usr/local/bin/npx /usr/local/bin/npx",
			"COPY --from=node_source /usr/local/lib/node_modules /usr/local/lib/node_modules",
			'ENV PATH="/usr/local/bin:${PATH}"',
			"WORKDIR /testbed",
			"",
		].join("\n"),
		"utf8",
	);
	run("docker", ["build", "-q", "-t", runnerImage, buildDir]);
	rmSync(buildDir, { recursive: true, force: true });
	return { baseImage, runnerImage };
}

function cleanupImages(task, images) {
	for (const image of [images.runnerImage, images.baseImage]) {
		run("docker", ["image", "rm", "-f", image], { captureOnly: true });
	}
}

function experimentsSubmissionPath(args, variant) {
	return join(args.experimentsRoot, variant.submission_dir);
}

function ensureSubmission(args, variant, tasks) {
	const submissionPath = experimentsSubmissionPath(args, variant);
	ensureDir(join(submissionPath, "logs"));
	ensureDir(join(submissionPath, "trajs"));
	writeFileSync(
		join(submissionPath, "metadata.yaml"),
		`info:\n  name: Shunya ${variant.name} VPS Docker benchmark\n  report: dev-notes/benchmark/benchmarking-first-principles.md\n  authors: Rakshith Sajjan\n  site: https://github.com/swe-bench/experiments\n  logo: null\ntags:\n  checked: false\n  model:\n    - ${args.model}\n  org:\n    - Shunya-agent\n  os_model: false\n  os_system: true\n  system:\n    attempts: "1"\n`,
		"utf8",
	);
	writeFileSync(
		join(submissionPath, "README.md"),
		`# Shunya ${variant.name} VPS Docker SWE-bench Lite Run\n\nAgents ran inside SWE-bench task containers. Regenerate comparison with:\n\n\`\`\`bash\nnode scripts/swebench-lite-compare.mjs --config ${args.config} --experiments-root ${args.experimentsRoot} --trace-root ${args.traceRoot} --out ${args.resultRoot} --limit ${tasks.length}\n\`\`\`\n`,
		"utf8",
	);
	for (const task of tasks) ensureDir(join(submissionPath, "logs", task.instance_id));
	return submissionPath;
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

function collectAssistantText(messages) {
	const assistant = [...messages].reverse().find((entry) => entry.type === "message" && entry.message?.role === "assistant");
	const content = assistant?.message?.content ?? [];
	return content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function toolCallCount(sessionEntries) {
	let count = 0;
	for (const entry of sessionEntries) {
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "assistant") continue;
		for (const item of message.content ?? []) {
			if (item.type === "toolCall") count += 1;
		}
	}
	return count;
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

function hostGoalExtension(args) {
	const candidates = [
		resolve(args.goalExtension),
		join(homedir(), ".pi", "agent", "npm", "node_modules", "@narumitw", "pi-goal", "src", "goal.ts"),
	];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) throw new Error(`Missing pi-goal extension. Tried: ${candidates.join(", ")}`);
	return found;
}

function hostGoalPackageRoot(args) {
	return dirname(dirname(hostGoalExtension(args)));
}

function dockerVolumePath(path) {
	return resolve(path);
}

function runAgentInDocker(args, config, variant, task, row, images) {
	const submissionPath = experimentsSubmissionPath(args, variant);
	const logPath = join(submissionPath, "logs", task.instance_id);
	const sessionDir = resolve(join(args.sessionRoot, variant.name, task.instance_id));
	if (args.force) {
		rmSync(sessionDir, { recursive: true, force: true });
		rmSync(logPath, { recursive: true, force: true });
	}
	ensureDir(sessionDir);
	ensureDir(logPath);
	ensureDir(join(submissionPath, "trajs"));

	const promptDir = resolve(join(args.resultRoot, "prompts", task.instance_id));
	ensureDir(promptDir);
	const promptPath = join(promptDir, "prompt.md");
	const goalPromptPath = join(promptDir, "goal.md");
	writeFileSync(promptPath, buildPrompt(row), "utf8");
	writeFileSync(goalPromptPath, buildGoalPrompt(row), "utf8");

	const repoRoot = resolve(".");
	const costLoggerPath = "/runner/.pi/extensions/cost-logger.ts";
	const shunyaPath = "/runner/.pi/extensions/shunya.ts";
	const goalExtensionPath = "/root/.pi/agent/npm/node_modules/@narumitw/pi-goal/src/goal.ts";
	const commandArgs = [
		"/runner/pi-test.sh",
		"--mode",
		"json",
		"--provider",
		args.provider,
		"--model",
		args.model,
		"--session-dir",
		`/bench/sessions/${variant.name}/${task.instance_id}`,
		"--append-system-prompt",
		readFileSync(goalPromptPath, "utf8"),
		"--extension",
		goalExtensionPath,
		"--extension",
		costLoggerPath,
	];
	if (variant.name === "shunya") {
		commandArgs.push("--extension", shunyaPath, "--shunya");
	}
	commandArgs.push("--approve", "-p", `$(cat /bench/prompts/${task.instance_id}/prompt.md)`);

	const shellCommand = [
		"set -uo pipefail",
		"cd /testbed",
		`printf '%s\\n' ${shellQuote(buildPrompt(row))} > .shunya-swebench-prompt.md`,
		"set +e",
		`${commandArgs.map((arg) => (arg.startsWith("$(") ? `"${arg}"` : shellQuote(arg))).join(" ")}`,
		"status=$?",
		"set -e",
		`git diff --binary > /bench/experiments/${variant.submission_dir}/logs/${task.instance_id}/patch.diff`,
		"exit $status",
	].join("\n");

	const containerName = `shunya-agent-${safeName(variant.name)}-${safeName(task.instance_id)}-${Date.now()}`;
	const dockerArgs = [
		"run",
		"--rm",
		"--name",
		containerName,
		"--env-file",
		resolve(args.envFile),
		"-e",
		"HOME=/root",
		"-v",
		`${dockerVolumePath(repoRoot)}:/runner:ro`,
		"-v",
		`${dockerVolumePath(hostGoalPackageRoot(args))}:/root/.pi/agent/npm/node_modules/@narumitw/pi-goal:ro`,
		"-v",
		`${dockerVolumePath(args.resultRoot)}:/bench`,
		"-v",
		`${dockerVolumePath(args.experimentsRoot)}:/bench/experiments`,
		"-w",
		"/testbed",
		images.runnerImage,
		"bash",
		"-lc",
		shellCommand,
	];

	const started = Date.now();
	const result = run("docker", dockerArgs, { captureOnly: true, timeoutMs: args.timeoutSec * 1000 });
	const runtimeSec = (Date.now() - started) / 1000;
	const sessionFile = latestSessionFile(sessionDir);
	const sessionEntries = sessionFile ? readJsonl(sessionFile) : [];
	const patchPath = join(logPath, "patch.diff");
	const patch = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
	const tracePath = join(args.traceRoot, variant.name, `${task.instance_id}.trace.json`);
	const apiCalls = usageFromSession(sessionEntries);
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
		patch_path: relative(process.cwd(), patchPath),
		runtime_sec: runtimeSec,
		tool_calls: toolCallCount(sessionEntries),
		api_calls: apiCalls,
		events: [],
		session_entries: sessionEntries,
		stdout: result.stdout,
		stderr: result.stderr,
		command: ["docker", ...dockerArgs],
		environment: {
			provider: args.provider,
			model: args.model,
			docker_image: images.runnerImage,
			base_docker_image: images.baseImage,
			session_file: sessionFile ? relative(process.cwd(), sessionFile) : null,
			goal_extension: goalExtensionPath,
			cost_logger_extension: costLoggerPath,
			shunya_extension: variant.name === "shunya" ? shunyaPath : null,
		},
		failure_reason: result.status === 0 ? "not evaluated yet" : `agent exited ${result.status ?? "timeout"}`,
	});
	writeFileSync(join(submissionPath, "trajs", `${task.instance_id}.stdout.txt`), result.stdout, "utf8");
	writeFileSync(join(logPath, "agent.stderr.txt"), result.stderr, "utf8");
	writeJson(join(logPath, "report.json"), { [task.instance_id]: { resolved: false } });
	writeFileSync(join(logPath, "test_output.txt"), "SWE-bench evaluation has not been run yet.\n", "utf8");
	if (result.status !== 0) {
		throw new Error(`Agent failed for ${variant.name}/${task.instance_id}: ${result.stderr || result.stdout}`);
	}
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function evaluatorEnv(args) {
	const env = { ...process.env };
	if (existsSync(args.envFile)) {
		for (const rawLine of readFileSync(args.envFile, "utf8").split("\n")) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
			if (!match) continue;
			env[match[1]] = match[2]?.replace(/^['"]|['"]$/g, "") ?? "";
		}
	}
	const dockerConfig = join(tmpdir(), "shunya-swebench-docker-config");
	ensureDir(dockerConfig);
	writeJson(join(dockerConfig, "config.json"), { auths: {} });
	env.DOCKER_CONFIG = dockerConfig;
	return env;
}

function runEvaluation(args, variant, tasks) {
	const submissionPath = experimentsSubmissionPath(args, variant);
	const runId = `shunya_${variant.name}_vps_docker_${tasks.length}`;
	const reportDir = join(args.evaluationRoot, variant.name);
	ensureDir(reportDir);
	const instanceIds = tasks.map((task) => task.instance_id);
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
		const candidates = [
			join("logs", "run_evaluation", runId, modelName, task.instance_id),
			join(homedir(), "logs", "run_evaluation", runId, modelName, task.instance_id),
		];
		const evalLogPath = candidates.find((candidate) => existsSync(join(candidate, "report.json")));
		if (!evalLogPath) throw new Error(`Missing SWE-bench report for ${variant.name}/${task.instance_id}`);
		const logPath = join(submissionPath, "logs", task.instance_id);
		copyFileSync(join(evalLogPath, "report.json"), join(logPath, "report.json"));
		copyFileSync(join(evalLogPath, "test_output.txt"), join(logPath, "test_output.txt"));
		const tracePath = join(args.traceRoot, variant.name, `${task.instance_id}.trace.json`);
		if (existsSync(tracePath)) {
			const trace = readJson(tracePath);
			const report = readJson(join(evalLogPath, "report.json"));
			const resolved = report[task.instance_id]?.resolved === true;
			trace.success = resolved;
			trace.failure_reason = resolved ? "" : "SWE-bench evaluator unresolved";
			writeJson(tracePath, trace);
		}
	}
}

function runCompare(args, tasks) {
	run("node", [
		"scripts/swebench-lite-compare.mjs",
		"--config",
		args.config,
		"--experiments-root",
		args.experimentsRoot,
		"--trace-root",
		args.traceRoot,
		"--out",
		args.resultRoot,
		"--limit",
		String(tasks.length),
	]);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const rows = await fetchFirstRows(args.limit);
	const config = writeConfig(args, rows);
	const tasks = config.tasks;
	const variants = selectVariants(args);
	for (const variant of variants) ensureSubmission(args, variant, tasks);

	if (args.runAgent) {
		for (let index = 0; index < tasks.length; index++) {
			const task = tasks[index];
			const row = rows[index];
			console.log(`[${index + 1}/${tasks.length}] ${task.instance_id}: preparing Docker image`);
			const images = ensureRunnerImage(args, task);
			try {
				for (const variant of variants) {
					console.log(`[${index + 1}/${tasks.length}] ${task.instance_id}: running ${variant.name}`);
					try {
						runAgentInDocker(args, config, variant, task, row, images);
					} catch (error) {
						console.error(
							`Failed ${variant.name}/${task.instance_id}: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
			} finally {
				if (!args.keepImages) cleanupImages(task, images);
			}
			for (const variant of variants) updatePredictions(args, variant, tasks);
		}
	}

	for (const variant of variants) updatePredictions(args, variant, tasks);
	if (args.runEvaluation) {
		for (const variant of variants) {
			console.log(`Evaluating ${variant.name} with SWE-bench`);
			runEvaluation(args, variant, tasks);
		}
		runCompare(args, tasks);
	}
	console.log(`${args.runAgent ? "Ran" : "Prepared"} ${tasks.length} Docker task(s) for ${variants.map((variant) => variant.name).join(", ")}.`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
