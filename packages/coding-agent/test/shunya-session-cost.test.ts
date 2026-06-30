import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { calculateShunyaSavings } from "../src/core/shunya-session-cost.ts";

function userMessage(content: string): AgentMessage {
	return { role: "user", content, timestamp: "2026-06-29T00:00:00.000Z" } as unknown as AgentMessage;
}

function assistantCompressionMessage(): AgentMessage {
	return {
		role: "assistant",
		provider: "openai",
		model: "gpt-4o",
		timestamp: "2026-06-29T00:00:00.000Z",
		content: [
			{ type: "toolCall", id: "call-1", name: "calculate", arguments: { value: 1 } },
			{ type: "toolCall", id: "call-2", name: "store_evidence", arguments: { summary: "keep it" } },
		],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as unknown as AgentMessage;
}

function assistantTextMessage(id: string): AgentMessage {
	return {
		role: "assistant",
		provider: "openai",
		model: "gpt-4o",
		timestamp: "2026-06-29T00:00:00.000Z",
		content: [{ type: "text", text: `reply-${id}` }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as unknown as AgentMessage;
}

function toolResultMessage(content: string, toolName: string, toolCallId: string, details?: unknown): AgentMessage {
	return {
		role: "toolResult",
		toolName,
		toolCallId,
		content: [{ type: "text", text: content }],
		details,
		timestamp: "2026-06-29T00:00:00.000Z",
	} as unknown as AgentMessage;
}

describe("calculateShunyaSavings", () => {
	it("prices the first dropped tool result as input and later replays as cache reads", () => {
		const messages: AgentMessage[] = [
			userMessage("hello"),
			assistantCompressionMessage(),
			toolResultMessage("raw tool output", "calculate", "call-1"),
			toolResultMessage("Evidence stored.", "store_evidence", "call-2", { summary: "keep it" }),
			userMessage("next turn"),
			assistantTextMessage("2"),
			userMessage("next turn again"),
			assistantTextMessage("3"),
		];

		const model = {
			id: "gpt-4o",
			provider: "openai",
			cost: { input: 1_000_000, cacheRead: 500_000 },
		};

		const result = calculateShunyaSavings(messages, () => model);

		expect(result.tokensSaved).toBeGreaterThan(0);
		expect(result.firstUseTokensSaved).toBeGreaterThan(0);
		expect(result.replayTokensSaved).toBeGreaterThan(0);
		expect(result.tokensSaved).toBe(result.firstUseTokensSaved + result.replayTokensSaved);
		expect(result.toolTokensWithShunya).toBeGreaterThan(0);
		expect(result.toolTokensWithoutShunya).toBe(result.toolTokensWithShunya + result.tokensSaved);
		expect(result.costSaved).toBeCloseTo(result.firstUseTokensSaved + result.replayTokensSaved / 2, 5);
	});
});
