import * as fs from "node:fs";
import { type AgentMessage, projectContext, storeEvidenceTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface PendingCall {
	callId: string;
	provider: string;
	model: string;
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
}

const REDACTED = "[redacted]";

/**
 * Shunya Extension: Implement task-level tool output batch compression
 * via agent self-summary at the end of a tool-calling sequence.
 */
export default function shunyaExtension(pi: ExtensionAPI) {
	// Register the CLI flag --shunya
	pi.registerFlag("shunya", {
		description: "Enable Shunya task-level batch compression (store_evidence + context projection)",
		type: "boolean",
		default: false,
	});

	let shunyaEnabled = false;
	let registered = false;
	let apiCallSequence = 0;
	let pendingCalls: PendingCall[] = [];
	let pendingTurnUsage: UsageTotals = createEmptyUsageTotals();
	let pendingTurnCallIds: string[] = [];
	let pendingTurnModels = new Set<string>();

	function registerShunyaTool() {
		if (registered) return;
		pi.registerTool({
			name: storeEvidenceTool.name,
			label: storeEvidenceTool.label,
			description: storeEvidenceTool.description,
			promptSnippet: storeEvidenceTool.promptSnippet,
			promptGuidelines: storeEvidenceTool.promptGuidelines,
			parameters: Type.Object({
				summary: Type.String({
					description: "Clear summary of findings, paths, schemas, or decisions that must be remembered.",
				}),
			}),
			execute: async (toolCallId, params, signal, onUpdate) => {
				if (!shunyaEnabled) {
					throw new Error("Shunya compression is currently disabled. Use /shunya to enable it.");
				}
				return storeEvidenceTool.execute(toolCallId, params, signal, onUpdate);
			},
		});
		registered = true;
	}

	function createEmptyUsageTotals(): UsageTotals {
		return {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			cost: 0,
		};
	}

	function addUsage(target: UsageTotals, usage: UsageTotals): void {
		target.input += usage.input;
		target.output += usage.output;
		target.cacheRead += usage.cacheRead;
		target.cacheWrite += usage.cacheWrite;
		target.total += usage.total;
		target.cost += usage.cost;
	}

	function traceFileFor(ctx: ExtensionContext): string | undefined {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return undefined;
		return sessionFile.endsWith(".jsonl")
			? sessionFile.replace(/\.jsonl$/, ".shunya.trace.jsonl")
			: `${sessionFile}.shunya.trace.jsonl`;
	}

	function redactCaptureValue(value: unknown): unknown {
		return JSON.parse(
			JSON.stringify(value, (key, nested) => {
				const lowerKey = key.toLowerCase();
				if (
					lowerKey === "apikey" ||
					lowerKey === "api_key" ||
					lowerKey === "authorization" ||
					lowerKey === "x-api-key"
				) {
					return REDACTED;
				}
				if (typeof nested === "function") return undefined;
				if (typeof nested === "bigint") return nested.toString();
				return nested;
			}),
		);
	}

	function appendTrace(ctx: ExtensionContext, entry: Record<string, unknown>): void {
		const traceFile = traceFileFor(ctx);
		if (!traceFile) return;
		fs.appendFileSync(
			traceFile,
			`${JSON.stringify({
				...entry,
				timestamp: new Date().toISOString(),
				sessionId: ctx.sessionManager.getSessionId(),
			})}\n`,
			"utf8",
		);
	}

	function usageTotalsFromMessage(message: AssistantMessage): UsageTotals {
		const usage = message.usage;
		return {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			total: usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
			cost: usage.cost.total,
		};
	}

	function resetTraceState(): void {
		apiCallSequence = 0;
		pendingCalls = [];
		pendingTurnUsage = createEmptyUsageTotals();
		pendingTurnCallIds = [];
		pendingTurnModels = new Set<string>();
	}

	async function saveCompressedSession(ctx: ExtensionContext) {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;

		const compressedFile = sessionFile.endsWith(".jsonl")
			? sessionFile.replace(/\.jsonl$/, ".compressed.jsonl")
			: `${sessionFile}.compressed.jsonl`;

		try {
			const header = ctx.sessionManager.getHeader();
			const allEntries = ctx.sessionManager.getEntries();
			const messages = allEntries.flatMap((e) => (e.type === "message" ? [e.message] : []));
			const projectedMessages = projectContext(messages);
			const projectedMessageSet = new Set(projectedMessages);
			const droppedParents = new Map<string, string | null>();

			for (const entry of allEntries) {
				if (entry.type === "message") {
					const message = entry.message as AgentMessage;
					if (!projectedMessageSet.has(message)) {
						droppedParents.set(entry.id, entry.parentId);
					}
				}
			}

			function resolveParent(parentId: string | null): string | null {
				let nextParentId = parentId;
				while (nextParentId !== null && droppedParents.has(nextParentId)) {
					nextParentId = droppedParents.get(nextParentId) ?? null;
				}
				return nextParentId;
			}

			const compressedEntries = allEntries
				.filter((entry) => !droppedParents.has(entry.id))
				.map((entry) => ({ ...entry, parentId: resolveParent(entry.parentId) }));

			const fileEntries = header ? [header, ...compressedEntries] : compressedEntries;
			const lines = `${fileEntries.map((e) => JSON.stringify(e)).join("\n")}\n`;
			await fs.promises.writeFile(compressedFile, lines, "utf8");
		} catch (err) {
			ctx.ui.notify(
				`Failed to save compressed session: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		resetTraceState();
		shunyaEnabled = pi.getFlag("shunya") === true;
		if (shunyaEnabled) {
			registerShunyaTool();
			ctx.ui.setStatus("shunya", ctx.ui.theme.fg("accent", "⚡ Shunya"));
		}
	});

	// Register /shunya command to toggle compression
	pi.registerCommand("shunya", {
		description: "Toggle Shunya compression mode",
		handler: async (_args, ctx) => {
			shunyaEnabled = !shunyaEnabled;
			ctx.ui.notify(`Shunya compression: ${shunyaEnabled ? "ENABLED" : "DISABLED"}`, "info");
			if (shunyaEnabled) {
				resetTraceState();
				registerShunyaTool();
				ctx.ui.setStatus("shunya", ctx.ui.theme.fg("accent", "⚡ Shunya"));
				await saveCompressedSession(ctx);
			} else {
				ctx.ui.setStatus("shunya", undefined);
			}
		},
	});

	// Register context projection to replace raw outputs with the stored evidence
	pi.on("context", async (event) => {
		if (!shunyaEnabled) {
			return event;
		}
		const projected = projectContext(event.messages);
		return { messages: projected };
	});

	pi.on("provider_payload", (event, ctx) => {
		if (!shunyaEnabled || event.provider !== "openai") return;
		const call: PendingCall = {
			callId: `${ctx.sessionManager.getSessionId()}:${++apiCallSequence}`,
			provider: event.provider,
			model: event.model,
		};
		pendingCalls.push(call);
		appendTrace(ctx, {
			type: "api_payload_capture",
			callId: call.callId,
			provider: call.provider,
			model: call.model,
			payload: redactCaptureValue(event.payload),
		});
	});

	pi.on("message_end", (event, ctx) => {
		if (!shunyaEnabled || event.message.role !== "assistant" || event.message.provider !== "openai") return;
		const message = event.message as AssistantMessage;
		const call =
			pendingCalls.shift() ??
			({
				callId: `${ctx.sessionManager.getSessionId()}:${++apiCallSequence}`,
				provider: message.provider,
				model: message.model,
			} satisfies PendingCall);
		const usage = usageTotalsFromMessage(message);
		addUsage(pendingTurnUsage, usage);
		pendingTurnCallIds.push(call.callId);
		pendingTurnModels.add(call.model);
		appendTrace(ctx, {
			type: "api_call_usage",
			callId: call.callId,
			provider: call.provider,
			model: call.model,
			responseId: message.responseId,
			stopReason: message.stopReason,
			errorMessage: message.errorMessage,
			usage: {
				...usage,
				reasoning: message.usage.reasoning,
			},
			cost: message.usage.cost,
		});
	});

	pi.on("turn_end", (event, ctx) => {
		if (!shunyaEnabled || pendingTurnCallIds.length === 0) return;
		appendTrace(ctx, {
			type: "turn_usage",
			turnIndex: event.turnIndex,
			provider: "openai",
			models: [...pendingTurnModels],
			callIds: [...pendingTurnCallIds],
			usage: { ...pendingTurnUsage },
		});
		pendingTurnUsage = createEmptyUsageTotals();
		pendingTurnCallIds = [];
		pendingTurnModels = new Set<string>();
	});

	// Save compressed session data on agent end
	pi.on("agent_end", async (_event, ctx) => {
		if (shunyaEnabled) {
			await saveCompressedSession(ctx);
		}
	});
}
