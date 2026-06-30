import * as fs from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
 * Cost Logger Extension: Logs API request payloads, usage stats, and cost details
 * to <session>.shunya.trace.jsonl for cost accounting and verification.
 */
export default function costLoggerExtension(pi: ExtensionAPI) {
	let apiCallSequence = 0;
	let pendingCalls: PendingCall[] = [];
	let pendingTurnUsage: UsageTotals = createEmptyUsageTotals();
	let pendingTurnCallIds: string[] = [];
	let pendingTurnModels = new Set<string>();

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

	pi.on("session_start", (_event, _ctx) => {
		resetTraceState();
	});

	pi.on("provider_payload", (event, ctx) => {
		if (event.provider !== "openai") return;
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
		if (event.message.role !== "assistant" || event.message.provider !== "openai") return;
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
		if (pendingTurnCallIds.length === 0) return;
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
}
