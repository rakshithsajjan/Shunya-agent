import { encoding_for_model, get_encoding, type Tiktoken, type TiktokenModel } from "@dqbd/tiktoken";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens, projectContext } from "@earendil-works/pi-agent-core";

interface PricingModel {
	provider: string;
	id: string;
	cost?: {
		input: number;
		cacheRead?: number;
	};
}

export interface ShunyaSavings {
	tokensSaved: number;
	firstUseTokensSaved: number;
	replayTokensSaved: number;
	toolTokensWithShunya: number;
	toolTokensWithoutShunya: number;
	costSaved: number;
}

interface TokenCounterCache {
	encoders: Map<string, Tiktoken>;
	tokenCounts: WeakMap<AgentMessage, Map<string, number>>;
}

function getFallbackEncodingName(modelId: string): "cl100k_base" | "o200k_base" {
	const lower = modelId.toLowerCase();
	if (
		lower.startsWith("gpt-5") ||
		lower.startsWith("gpt-4o") ||
		lower.startsWith("gpt-4.1") ||
		lower.startsWith("gpt-4.5") ||
		lower.startsWith("o1") ||
		lower.startsWith("o3") ||
		lower.startsWith("o4") ||
		lower.startsWith("chatgpt-4o")
	) {
		return "o200k_base";
	}
	return "cl100k_base";
}

function getEncoder(modelId: string, cache: TokenCounterCache): Tiktoken {
	const cached = cache.encoders.get(modelId);
	if (cached) return cached;

	let encoder: Tiktoken;
	try {
		encoder = encoding_for_model(modelId as TiktokenModel);
	} catch {
		encoder = get_encoding(getFallbackEncodingName(modelId));
	}
	cache.encoders.set(modelId, encoder);
	return encoder;
}

function countToolResultTokens(message: AgentMessage, modelId: string, cache: TokenCounterCache): number {
	const cachedCounts = cache.tokenCounts.get(message);
	if (cachedCounts?.has(modelId)) {
		return cachedCounts.get(modelId)!;
	}

	let tokenCount = 0;
	let hasText = false;

	if (message.role === "toolResult" && Array.isArray(message.content)) {
		for (const block of message.content) {
			if (block.type === "text") {
				hasText = true;
				tokenCount += getEncoder(modelId, cache).encode(block.text).length;
			}
		}
	}

	if (!hasText) {
		tokenCount = estimateTokens(message);
	}

	const nextCounts = cachedCounts ?? new Map<string, number>();
	nextCounts.set(modelId, tokenCount);
	cache.tokenCounts.set(message, nextCounts);
	return tokenCount;
}

function getModelCost(model: PricingModel | undefined): { input: number; cacheRead: number } | undefined {
	if (!model?.cost) return undefined;
	return {
		input: model.cost.input,
		cacheRead: model.cost.cacheRead ?? model.cost.input,
	};
}

function costFromTokens(tokens: number, ratePerMillion: number): number {
	return (tokens * ratePerMillion) / 1_000_000;
}

export function calculateShunyaSavings(
	messages: AgentMessage[],
	findModel: (provider: string, modelId: string) => PricingModel | undefined,
): ShunyaSavings {
	const cache: TokenCounterCache = {
		encoders: new Map<string, Tiktoken>(),
		tokenCounts: new WeakMap<AgentMessage, Map<string, number>>(),
	};
	const seenDroppedMessages = new Set<AgentMessage>();
	let tokensSaved = 0;
	let firstUseTokensSaved = 0;
	let replayTokensSaved = 0;
	let toolTokensWithShunya = 0;
	let toolTokensWithoutShunya = 0;
	let costSaved = 0;

	try {
		for (let i = 0; i < messages.length; i++) {
			const message = messages[i];
			if (message.role !== "assistant") continue;

			const model = findModel(message.provider, message.model);
			const pricing = getModelCost(model);
			if (!pricing) continue;

			const preceding = messages.slice(0, i);
			const projectedPreceding = projectContext(preceding);
			const projectedSet = new Set<AgentMessage>(projectedPreceding);

			for (const precedingMessage of preceding) {
				if (precedingMessage.role !== "toolResult") continue;

				const toolTokens = countToolResultTokens(precedingMessage, message.model, cache);
				toolTokensWithoutShunya += toolTokens;
				if (projectedSet.has(precedingMessage)) {
					toolTokensWithShunya += toolTokens;
					continue;
				}

				const droppedTokens = toolTokens;
				tokensSaved += droppedTokens;

				if (seenDroppedMessages.has(precedingMessage)) {
					replayTokensSaved += droppedTokens;
					costSaved += costFromTokens(droppedTokens, pricing.cacheRead);
				} else {
					firstUseTokensSaved += droppedTokens;
					costSaved += costFromTokens(droppedTokens, pricing.input);
					seenDroppedMessages.add(precedingMessage);
				}
			}
		}
	} finally {
		for (const encoder of cache.encoders.values()) {
			encoder.free();
		}
	}

	return {
		tokensSaved,
		firstUseTokensSaved,
		replayTokensSaved,
		toolTokensWithShunya,
		toolTokensWithoutShunya,
		costSaved,
	};
}
