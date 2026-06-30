import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { projectContext, storeEvidenceTool } from "../../src/harness/retention-policy.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentMessage } from "../../src/types.ts";
import { calculateTool } from "../utils/calculate.ts";

const models = createModels();
let fauxCount = 0;

function newFaux() {
	const faux = fauxProvider({ provider: `faux-retention-${++fauxCount}` });
	models.setProvider(faux.provider);
	return faux;
}

describe("Retention Policy", () => {
	describe("unit test: projectContext", () => {
		it("projects out raw tool results when store_evidence is called in the same assistant turn", () => {
			const messages: AgentMessage[] = [
				{ role: "user", content: [{ type: "text", text: "Start" }], timestamp: 100 },
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call-1", name: "calculate", arguments: { expression: "1+1" } },
						{
							type: "toolCall",
							id: "call-2",
							name: "store_evidence",
							arguments: { summary: "Calculation is done" },
						},
					],
					api: "openai",
					provider: "openai",
					model: "gpt-4o",
					stopReason: "toolUse",
					timestamp: 101,
					usage: {
						input: 10,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 20,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "calculate",
					content: [{ type: "text", text: "1+1 = 2" }],
					isError: false,
					timestamp: 102,
				},
				{
					role: "toolResult",
					toolCallId: "call-2",
					toolName: "store_evidence",
					content: [{ type: "text", text: "Evidence stored." }],
					details: { summary: "Calculation is done", toolCallId: "call-2", timestamp: 102 },
					isError: false,
					timestamp: 103,
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "Turn 1 complete" }],
					api: "openai",
					provider: "openai",
					model: "gpt-4o",
					stopReason: "stop",
					timestamp: 104,
					usage: {
						input: 15,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 20,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			];

			const projected = projectContext(messages);

			// Should drop the raw calculate tool result (call-1), but keep store_evidence tool result (call-2)
			expect(projected.find((m) => m.role === "toolResult" && m.toolName === "calculate")).toBeUndefined();
			expect(projected.find((m) => m.role === "toolResult" && m.toolName === "store_evidence")).toBeDefined();
			expect(projected.length).toBe(4);
		});

		it("keeps all tool results if store_evidence is not called", () => {
			const messages: AgentMessage[] = [
				{ role: "user", content: [{ type: "text", text: "Start" }], timestamp: 100 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "calculate", arguments: { expression: "1+1" } }],
					api: "openai",
					provider: "openai",
					model: "gpt-4o",
					stopReason: "toolUse",
					timestamp: 101,
					usage: {
						input: 10,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 20,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "calculate",
					content: [{ type: "text", text: "1+1 = 2" }],
					isError: false,
					timestamp: 102,
				},
			];

			const projected = projectContext(messages);
			expect(projected.find((m) => m.role === "toolResult" && m.toolName === "calculate")).toBeDefined();
			expect(projected.length).toBe(3);
		});

		it("projects out prior raw tool results when store_evidence is called after reading them", () => {
			const messages: AgentMessage[] = [
				{ role: "user", content: [{ type: "text", text: "Start" }], timestamp: 100 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "calculate", arguments: { expression: "1+1" } }],
					api: "openai",
					provider: "openai",
					model: "gpt-4o",
					stopReason: "toolUse",
					timestamp: 101,
					usage: {
						input: 10,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 20,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "calculate",
					content: [{ type: "text", text: "1+1 = 2" }],
					isError: false,
					timestamp: 102,
				},
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-2",
							name: "store_evidence",
							arguments: { summary: "Calculation is done" },
						},
					],
					api: "openai",
					provider: "openai",
					model: "gpt-4o",
					stopReason: "toolUse",
					timestamp: 103,
					usage: {
						input: 10,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 20,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
				{
					role: "toolResult",
					toolCallId: "call-2",
					toolName: "store_evidence",
					content: [{ type: "text", text: "Evidence stored." }],
					details: { summary: "Calculation is done", toolCallId: "call-2", timestamp: 104 },
					isError: false,
					timestamp: 104,
				},
			];

			const projected = projectContext(messages);

			expect(projected.find((m) => m.role === "toolResult" && m.toolName === "calculate")).toBeUndefined();
			expect(projected.find((m) => m.role === "toolResult" && m.toolName === "store_evidence")).toBeDefined();
			expect(projected.length).toBe(4);
		});
	});

	describe("integration test: AgentHarness context hook", () => {
		it("runs the harness loop and projects out raw tool results on the next turn when store_evidence is called", async () => {
			const registration = newFaux();
			const capturedContexts: any[] = [];

			registration.setResponses([
				// Turn 1, Call 1: user prompts, model executes both calculate and store_evidence
				(context) => {
					capturedContexts.push(JSON.parse(JSON.stringify(context.messages)));
					return fauxAssistantMessage(
						[
							fauxToolCall("calculate", { expression: "10 * 10" }, { id: "call-1" }),
							fauxToolCall("store_evidence", { summary: "10 * 10 is 100" }, { id: "call-2" }),
						],
						{ stopReason: "toolUse" },
					);
				},
				// Turn 1, Call 2: after tool results are returned, model completes turn
				(context) => {
					capturedContexts.push(JSON.parse(JSON.stringify(context.messages)));
					return fauxAssistantMessage("Turn 1 final answer");
				},
				// Turn 2, Call 1: after user prompts again
				(context) => {
					capturedContexts.push(JSON.parse(JSON.stringify(context.messages)));
					return fauxAssistantMessage("Turn 2 final answer");
				},
			]);

			const session = new Session(new InMemorySessionStorage());
			const harness = new AgentHarness({
				models,
				env: new NodeExecutionEnv({ cwd: process.cwd() }),
				session,
				model: registration.getModel(),
				tools: [calculateTool, storeEvidenceTool],
			});

			// Wire context hook as the extension would do
			harness.on("context", (event) => {
				return { messages: projectContext(event.messages) };
			});

			// Turn 1
			await harness.prompt("First prompt");

			// Turn 2
			await harness.prompt("Second prompt");

			// Verify captured contexts
			expect(capturedContexts.length).toBe(3);

			// context 1 (Turn 1, Call 1): only the first user message
			expect(capturedContexts[0].length).toBe(1);

			// context 2 (Turn 1, Call 2): contains the raw calculate tool call and store_evidence tool call,
			// but raw calculate tool result has been projected out!
			const hasCalculateResultInTurn1 = capturedContexts[1].some(
				(m: any) => m.role === "toolResult" && m.toolName === "calculate",
			);
			expect(hasCalculateResultInTurn1).toBe(false);

			const hasStoreEvidenceResultInTurn1 = capturedContexts[1].some(
				(m: any) => m.role === "toolResult" && m.toolName === "store_evidence",
			);
			expect(hasStoreEvidenceResultInTurn1).toBe(true);

			// context 3 (Turn 2, Call 1): raw calculate tool result has been projected out!
			const hasCalculateResultInTurn2 = capturedContexts[2].some(
				(m: any) => m.role === "toolResult" && m.toolName === "calculate",
			);
			expect(hasCalculateResultInTurn2).toBe(false);

			// store_evidence result is kept
			const hasStoreEvidenceResultInTurn2 = capturedContexts[2].some(
				(m: any) => m.role === "toolResult" && m.toolName === "store_evidence",
			);
			expect(hasStoreEvidenceResultInTurn2).toBe(true);
		});
	});
});
