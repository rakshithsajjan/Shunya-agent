#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const DEFAULT_CONFIG = "dev-notes/benchmark/swebench-lite-v1-tasks.json";
const DEFAULT_EXPERIMENTS_ROOT = "dev-notes/benchmark/experiments-local";
const DEFAULT_TRACE_ROOT = "dev-notes/benchmark/results/swebench-lite-v1/traces";
const DEFAULT_OUT = "dev-notes/benchmark/results/swebench-lite-v1";

const CSV_HEADER = [
	"task_id",
	"variant",
	"model",
	"goal_plugin",
	"success",
	"patch_produced",
	"runtime_sec",
	"tool_calls",
	"input_tokens",
	"cached_input_tokens",
	"cache_write_tokens",
	"output_tokens",
	"reasoning_tokens",
	"total_tokens",
	"cost_usd",
	"failure_reason",
	"trace_path",
	"experiments_path",
];

function parseArgs(argv) {
	const args = {
		config: DEFAULT_CONFIG,
		experimentsRoot: DEFAULT_EXPERIMENTS_ROOT,
		traceRoot: DEFAULT_TRACE_ROOT,
		out: DEFAULT_OUT,
		limit: undefined,
		scaffold: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--config") args.config = argv[++i];
		else if (arg === "--experiments-root") args.experimentsRoot = argv[++i];
		else if (arg === "--trace-root") args.traceRoot = argv[++i];
		else if (arg === "--out") args.out = argv[++i];
		else if (arg === "--limit") args.limit = Number.parseInt(argv[++i], 10);
		else if (arg === "--scaffold") args.scaffold = true;
		else if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
		throw new Error("--limit must be a positive integer");
	}
	return args;
}

function printHelp() {
	console.log(`Usage: node scripts/swebench-lite-compare.mjs [options]

Validates local SWE-bench experiments-style artifacts for Pi Native and Shunya,
then writes a comparison CSV and Markdown report.

Options:
  --config <path>             Task/variant config JSON
  --experiments-root <path>   Root containing evaluation/lite/... folders
  --trace-root <path>         Root containing <variant>/<task>.trace.json
  --out <path>                Output directory for results.csv and summary.md
  --limit <n>                 Compare the first n configured tasks
  --scaffold                  Create expected directories and placeholder README/metadata files
`);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

function csvEscape(value) {
	if (value === null || value === undefined) return "";
	const text = String(value);
	if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
	return text;
}

function costForCall(call) {
	if (typeof call.cost_usd === "number") return call.cost_usd;
	const usage = call.usage ?? {};
	const pricing = call.pricing_snapshot ?? {};
	return (
		((usage.input_tokens ?? 0) * (pricing.input_per_1m_tokens ?? 0) +
			(usage.cached_input_tokens ?? 0) * (pricing.cache_read_per_1m_tokens ?? 0) +
			(usage.cache_write_tokens ?? 0) * (pricing.cache_write_per_1m_tokens ?? 0) +
			(usage.output_tokens ?? 0) * (pricing.output_per_1m_tokens ?? 0)) /
		1_000_000
	);
}

function sumUsage(apiCalls) {
	const totals = {
		inputTokens: 0,
		cachedInputTokens: 0,
		cacheWriteTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
		costUsd: 0,
	};
	for (const call of apiCalls) {
		const usage = call.usage ?? {};
		totals.inputTokens += usage.input_tokens ?? 0;
		totals.cachedInputTokens += usage.cached_input_tokens ?? 0;
		totals.cacheWriteTokens += usage.cache_write_tokens ?? 0;
		totals.outputTokens += usage.output_tokens ?? 0;
		totals.reasoningTokens += usage.reasoning_tokens ?? 0;
		totals.totalTokens += usage.total_tokens ?? 0;
		totals.costUsd += costForCall(call);
	}
	return totals;
}

function reportResolved(report, taskId) {
	if (typeof report.resolved === "boolean") return report.resolved;
	if (report[taskId] && typeof report[taskId].resolved === "boolean") return report[taskId].resolved;
	if (Array.isArray(report.resolved)) return report.resolved.includes(taskId);
	return undefined;
}

function findTraj(submissionPath, taskId) {
	const trajsPath = join(submissionPath, "trajs");
	if (!existsSync(trajsPath)) return undefined;
	const candidates = readdirSync(trajsPath).filter((name) => name.includes(taskId));
	return candidates.length > 0 ? join(trajsPath, candidates[0]) : undefined;
}

function ensureScaffold(config, args, tasks) {
	for (const variant of config.variants) {
		const submissionPath = join(args.experimentsRoot, variant.submission_dir);
		mkdirSync(join(submissionPath, "logs"), { recursive: true });
		mkdirSync(join(submissionPath, "trajs"), { recursive: true });
		mkdirSync(join(args.traceRoot, variant.name), { recursive: true });
		const metadataPath = join(submissionPath, "metadata.yaml");
		if (!existsSync(metadataPath)) {
			writeFileSync(
				metadataPath,
				`info:\n  name: Shunya ${variant.name} local benchmark\n  report: dev-notes/benchmark/benchmarking-first-principles.md\n  authors: Rakshith Sajjan\n  site: https://github.com/swe-bench/experiments\n  logo: null\ntags:\n  checked: false\n  model:\n    - ${config.model}\n  org:\n    - Shunya-agent\n  os_model: false\n  os_system: true\n  system:\n    attempts: "1"\n`,
				"utf8",
			);
		}
		const readmePath = join(submissionPath, "README.md");
		if (!existsSync(readmePath)) {
			writeFileSync(
				readmePath,
				`# Shunya ${variant.name} Local SWE-bench Lite Run\n\nRun locally, then regenerate results with:\n\n\`\`\`bash\npython -m analysis.get_results ${variant.submission_dir}\n\`\`\`\n\nThis directory follows the SWE-bench experiments submission layout for local verification.\n`,
				"utf8",
			);
		}
		const predsPath = join(submissionPath, "all_preds.jsonl");
		if (!existsSync(predsPath)) writeFileSync(predsPath, "", "utf8");
		for (const task of tasks) {
			mkdirSync(join(submissionPath, "logs", task.instance_id), { recursive: true });
		}
	}
}

function validateAndCollect(config, args) {
	const tasks = config.tasks.slice(0, args.limit ?? config.tasks.length);
	const errors = [];
	const rows = [];
	for (const variant of config.variants) {
		const submissionPath = join(args.experimentsRoot, variant.submission_dir);
		const predsPath = join(submissionPath, "all_preds.jsonl");
		if (!existsSync(submissionPath)) errors.push(`Missing submission directory: ${submissionPath}`);
		if (!existsSync(predsPath) && !existsSync(join(submissionPath, "preds.json"))) {
			errors.push(`Missing predictions file: ${predsPath}`);
		}
		for (const task of tasks) {
			const logPath = join(submissionPath, "logs", task.instance_id);
			const patchPath = join(logPath, "patch.diff");
			const reportPath = join(logPath, "report.json");
			const testOutputPath = join(logPath, "test_output.txt");
			const tracePath = join(args.traceRoot, variant.name, `${task.instance_id}.trace.json`);
			const trajPath = existsSync(submissionPath) ? findTraj(submissionPath, task.instance_id) : undefined;
			for (const requiredPath of [logPath, patchPath, reportPath, testOutputPath, tracePath]) {
				if (!existsSync(requiredPath)) errors.push(`Missing required artifact: ${requiredPath}`);
			}
			if (!trajPath) errors.push(`Missing trajectory for ${task.instance_id} under ${join(submissionPath, "trajs")}`);
			if (!existsSync(tracePath) || !existsSync(reportPath) || !existsSync(patchPath)) continue;

			const trace = readJson(tracePath);
			const report = readJson(reportPath);
			const apiCalls = Array.isArray(trace.api_calls) ? trace.api_calls : [];
			if (apiCalls.length === 0) errors.push(`Trace has no api_calls: ${tracePath}`);
			const usage = sumUsage(apiCalls);
			const resolved = reportResolved(report, task.instance_id);
			if (resolved === undefined) errors.push(`Cannot read resolved status from ${reportPath}`);
			rows.push({
				taskId: task.instance_id,
				variant: variant.name,
				model: trace.model ?? config.model,
				goalPlugin: trace.goal_plugin ?? config.goal_plugin,
				success: resolved ?? trace.success,
				patchProduced: readFileSync(patchPath, "utf8").trim().length > 0,
				runtimeSec: trace.runtime_sec ?? "",
				toolCalls: trace.tool_calls ?? "",
				...usage,
				failureReason: resolved ? "" : trace.failure_reason ?? "unresolved or missing report status",
				tracePath,
				experimentsPath: submissionPath,
			});
		}
	}
	return { tasks, rows, errors };
}

function writeCsv(path, rows) {
	const lines = [CSV_HEADER.join(",")];
	for (const row of rows) {
		lines.push(
			[
				row.taskId,
				row.variant,
				row.model,
				row.goalPlugin,
				row.success,
				row.patchProduced,
				row.runtimeSec,
				row.toolCalls,
				row.inputTokens,
				row.cachedInputTokens,
				row.cacheWriteTokens,
				row.outputTokens,
				row.reasoningTokens,
				row.totalTokens,
				row.costUsd.toFixed(8),
				row.failureReason,
				relative(process.cwd(), row.tracePath),
				relative(process.cwd(), row.experimentsPath),
			]
				.map(csvEscape)
				.join(","),
		);
	}
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function totalsFor(rows, variant) {
	const selected = rows.filter((row) => row.variant === variant);
	const successCount = selected.filter((row) => row.success === true).length;
	const costUsd = selected.reduce((sum, row) => sum + row.costUsd, 0);
	const totalTokens = selected.reduce((sum, row) => sum + row.totalTokens, 0);
	const runtimeSec = selected.reduce((sum, row) => sum + (Number(row.runtimeSec) || 0), 0);
	return {
		count: selected.length,
		successCount,
		costUsd,
		totalTokens,
		runtimeSec,
		costPerSuccess: successCount === 0 ? undefined : costUsd / successCount,
	};
}

function appendToLedger(config, tasks, rows) {
	const ledgerPath = "dev-notes/benchmark/benchmark-history.csv";
	if (!existsSync(ledgerPath)) return;
	
	const timestamp = new Date().toISOString().replace(/T/, '_').replace(/\\..+/, '');
	const runId = `run_${timestamp}`;
	const suiteName = config.selection_rationale?.substring(0, 30).replace(/[^a-zA-Z0-9]/g, '_') || "unknown_suite";
	
	const lines = [];
	for (const variant of config.variants) {
		const totals = totalsFor(rows, variant.name);
		const rate = totals.count === 0 ? 0 : (totals.successCount / totals.count) * 100;
		const costPerSuccess = totals.successCount === 0 ? 0 : totals.costUsd / totals.successCount;
		
		const rowData = [
			timestamp,
			runId,
			suiteName,
			variant.name,
			totals.count,
			totals.successCount,
			rate.toFixed(2),
			totals.costUsd.toFixed(6),
			costPerSuccess.toFixed(6),
			totals.totalTokens,
			totals.runtimeSec.toFixed(1)
		];
		lines.push(rowData.join(","));
	}
	
	import("node:fs").then(fs => {
		fs.appendFileSync(ledgerPath, lines.join("\\n") + "\\n", "utf8");
		console.log(`Appended ${lines.length} rows to ${ledgerPath}`);
	});
}

function writeSummary(path, config, tasks, rows, errors) {
	const lines = [
		"# SWE-bench Lite Pi Native vs Shunya Comparison",
		"",
		`Generated from local SWE-bench experiments-style artifacts for ${tasks.length} task(s).`,
		"",
		"## Inputs",
		"",
		`- Benchmark: ${config.benchmark_name}`,
		`- Model: ${config.model}`,
		`- Goal plugin: ${config.goal_plugin}@${config.goal_plugin_version}`,
		`- Tasks: ${tasks.map((task) => task.instance_id).join(", ")}`,
		"",
		"## Variant Totals",
		"",
		"| Variant | Tasks | Successes | Success Rate | Cost USD | Cost / Success | Tokens | Runtime sec |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	];
	for (const variant of config.variants) {
		const totals = totalsFor(rows, variant.name);
		const rate = totals.count === 0 ? 0 : (totals.successCount / totals.count) * 100;
		lines.push(
			`| ${variant.name} | ${totals.count} | ${totals.successCount} | ${rate.toFixed(1)}% | ${totals.costUsd.toFixed(6)} | ${totals.costPerSuccess === undefined ? "n/a" : totals.costPerSuccess.toFixed(6)} | ${totals.totalTokens} | ${totals.runtimeSec.toFixed(1)} |`,
		);
	}
	lines.push("", "## Per-Task Rows", "");
	lines.push("| Task | Variant | Success | Cost USD | Tokens | Tool Calls | Failure Reason |");
	lines.push("| --- | --- | --- | ---: | ---: | ---: | --- |");
	for (const row of rows) {
		lines.push(
			`| ${row.taskId} | ${row.variant} | ${row.success} | ${row.costUsd.toFixed(6)} | ${row.totalTokens} | ${row.toolCalls} | ${row.failureReason || ""} |`,
		);
	}
	if (errors.length > 0) {
		lines.push("", "## Verification Blockers", "");
		for (const error of errors) lines.push(`- ${error}`);
	} else {
		lines.push("", "## Verification", "", "- All expected predictions, logs, reports, patches, trajectories, and traces were present.");
	}
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const config = readJson(args.config);
	const tasks = config.tasks.slice(0, args.limit ?? config.tasks.length);
	if (args.scaffold) ensureScaffold(config, args, tasks);
	const { rows, errors } = validateAndCollect(config, args);
	mkdirSync(args.out, { recursive: true });
	writeCsv(join(args.out, `results-${tasks.length}-tasks.csv`), rows);
	writeSummary(join(args.out, `summary-${tasks.length}-tasks.md`), config, tasks, rows, errors);
	if (errors.length === 0) appendToLedger(config, tasks, rows);
	writeJson(join(args.out, `verification-${tasks.length}-tasks.json`), { ok: errors.length === 0, errors });
	if (errors.length > 0) {
		console.error(`Verification failed with ${errors.length} missing or invalid artifact(s).`);
		process.exit(1);
	}
	console.log(`Wrote ${rows.length} comparison rows for ${tasks.length} task(s).`);
}

main();
