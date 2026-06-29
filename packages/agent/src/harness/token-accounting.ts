import type { AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";

export interface TokenUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
}

export interface OpenAiPricing {
	inputPerMillion: number;
	cachedInputPerMillion: number;
	outputPerMillion: number;
	effectiveDate: string;
	source: string;
}

export interface CalculatedTokenCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	pricing: "unknown" | "openai";
	effectiveDate?: string;
	source?: string;
}

export interface ApiRequestCapture {
	callId: string;
	provider: "openai";
	model: string;
	turnIndex: number;
	timestamp: string;
	context: unknown;
	options: unknown;
}

export interface ApiPayloadCapture {
	callId: string;
	provider: "openai";
	model: string;
	turnIndex: number;
	timestamp: string;
	payload: unknown;
}

export interface ApiUsageCapture {
	callId: string;
	provider: "openai";
	model: string;
	turnIndex: number;
	timestamp: string;
	responseId?: string;
	stopReason: AssistantMessage["stopReason"];
	errorMessage?: string;
	usage: TokenUsageTotals & { reasoning?: number };
	cost: CalculatedTokenCost;
	providerReportedCost: Usage["cost"];
}

export interface TurnUsageCapture extends TokenUsageTotals {
	provider: "openai";
	turnIndex: number;
	models: string[];
	callIds: string[];
	timestamp: string;
}

export interface TokenAccountingSnapshot {
	sessionTotal: TokenUsageTotals;
	turns: TurnUsageCapture[];
}

export interface PendingApiCall {
	callId: string;
	provider: "openai";
	model: string;
	turnIndex: number;
}

const UNKNOWN_COST: CalculatedTokenCost = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
	pricing: "unknown",
};

export function createEmptyTokenUsage(): TokenUsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: 0,
	};
}

export function isOpenAiModel(model: Model<any>): boolean {
	return model.provider === "openai";
}

export function calculateOpenAiCost(usage: Usage, pricing?: OpenAiPricing): CalculatedTokenCost {
	if (!pricing) {
		if (usage.cost) {
			return {
				input: usage.cost.input,
				output: usage.cost.output,
				cacheRead: usage.cost.cacheRead,
				cacheWrite: usage.cost.cacheWrite,
				total: usage.cost.total,
				pricing: "openai",
			};
		}
		return { ...UNKNOWN_COST };
	}
	const input = (usage.input * pricing.inputPerMillion) / 1_000_000;
	const cacheRead = (usage.cacheRead * pricing.cachedInputPerMillion) / 1_000_000;
	const output = (usage.output * pricing.outputPerMillion) / 1_000_000;
	const cacheWrite = (usage.cacheWrite * pricing.inputPerMillion) / 1_000_000;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: input + output + cacheRead + cacheWrite,
		pricing: "openai",
		effectiveDate: pricing.effectiveDate,
		source: pricing.source,
	};
}

export function usageToTotals(usage: Usage, cost: CalculatedTokenCost): ApiUsageCapture["usage"] {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		total: usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
		cost: cost.total,
		reasoning: usage.reasoning,
	};
}

export function safeCaptureValue(value: unknown): unknown {
	if (value === undefined) return undefined;
	return JSON.parse(
		JSON.stringify(value, (_key, nested) => {
			if (typeof nested === "function") return undefined;
			if (typeof nested === "bigint") return nested.toString();
			return nested;
		}),
	);
}

export function createApiRequestCapture(
	call: PendingApiCall,
	context: Context,
	options: unknown,
	timestamp = new Date().toISOString(),
): ApiRequestCapture {
	return {
		...call,
		timestamp,
		context: safeCaptureValue(context),
		options: safeCaptureValue(options),
	};
}

export function createApiPayloadCapture(
	call: PendingApiCall,
	payload: unknown,
	timestamp = new Date().toISOString(),
): ApiPayloadCapture {
	return {
		...call,
		timestamp,
		payload: safeCaptureValue(payload),
	};
}

export function createApiUsageCapture(
	call: PendingApiCall,
	message: AssistantMessage,
	pricing?: OpenAiPricing,
	timestamp = new Date().toISOString(),
): ApiUsageCapture {
	const cost = calculateOpenAiCost(message.usage, pricing);
	return {
		...call,
		timestamp,
		responseId: message.responseId,
		stopReason: message.stopReason,
		errorMessage: message.errorMessage,
		usage: usageToTotals(message.usage, cost),
		cost,
		providerReportedCost: { ...message.usage.cost },
	};
}

export class TokenAccounting {
	private sessionTotal = createEmptyTokenUsage();
	private pendingTurn = createEmptyTokenUsage();
	private pendingModels = new Set<string>();
	private pendingCallIds: string[] = [];
	private turns: TurnUsageCapture[] = [];

	recordUsage(capture: ApiUsageCapture): void {
		this.add(this.sessionTotal, capture.usage);
		this.add(this.pendingTurn, capture.usage);
		this.pendingModels.add(capture.model);
		this.pendingCallIds.push(capture.callId);
	}

	finishTurn(turnIndex: number, timestamp = new Date().toISOString()): TurnUsageCapture | undefined {
		if (this.pendingCallIds.length === 0) return undefined;
		const turn: TurnUsageCapture = {
			...this.pendingTurn,
			provider: "openai",
			turnIndex,
			models: [...this.pendingModels],
			callIds: [...this.pendingCallIds],
			timestamp,
		};
		this.turns.push(turn);
		this.pendingTurn = createEmptyTokenUsage();
		this.pendingModels.clear();
		this.pendingCallIds = [];
		return turn;
	}

	getSnapshot(): TokenAccountingSnapshot {
		return {
			sessionTotal: { ...this.sessionTotal },
			turns: this.turns.map((turn) => ({ ...turn, models: [...turn.models], callIds: [...turn.callIds] })),
		};
	}

	private add(target: TokenUsageTotals, usage: TokenUsageTotals): void {
		target.input += usage.input;
		target.output += usage.output;
		target.cacheRead += usage.cacheRead;
		target.cacheWrite += usage.cacheWrite;
		target.total += usage.total;
		target.cost += usage.cost;
	}
}
