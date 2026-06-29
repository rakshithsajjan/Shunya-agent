import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import {
	calculateOpenAiCost,
	createApiPayloadCapture,
	createApiUsageCapture,
	type PendingApiCall,
	TokenAccounting,
} from "../../src/harness/token-accounting.ts";

describe("TokenAccounting", () => {
	it("calculates OpenAI cost from explicit pricing", () => {
		const cost = calculateOpenAiCost(
			{
				input: 1_000_000,
				output: 500_000,
				cacheRead: 250_000,
				cacheWrite: 100_000,
				totalTokens: 1_850_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			{
				inputPerMillion: 2,
				cachedInputPerMillion: 0.5,
				outputPerMillion: 8,
				effectiveDate: "2026-06-30",
				source: "test",
			},
		);

		expect(cost).toMatchObject({
			input: 2,
			cacheRead: 0.125,
			cacheWrite: 0.2,
			output: 4,
			total: 6.325,
			pricing: "openai",
		});
	});

	it("groups OpenAI API usages by turn", () => {
		const accounting = new TokenAccounting();
		const call: PendingApiCall = {
			callId: "session-1:1",
			provider: "openai",
			model: "gpt-test",
			turnIndex: 0,
		};
		const capture = createApiUsageCapture(
			call,
			{
				...fauxAssistantMessage("hello", { responseId: "resp-1" }),
				provider: "openai",
				model: "gpt-test",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 20,
					cacheWrite: 0,
					totalTokens: 35,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
			{
				inputPerMillion: 1,
				cachedInputPerMillion: 0.1,
				outputPerMillion: 2,
				effectiveDate: "2026-06-30",
				source: "test",
			},
		);

		accounting.recordUsage(capture);
		const turn = accounting.finishTurn(0);

		expect(turn).toMatchObject({
			provider: "openai",
			turnIndex: 0,
			models: ["gpt-test"],
			callIds: ["session-1:1"],
			input: 10,
			output: 5,
			cacheRead: 20,
			cacheWrite: 0,
			total: 35,
		});
		expect(accounting.getSnapshot().sessionTotal.total).toBe(35);
	});

	it("keeps payload capture JSON serializable", () => {
		const call: PendingApiCall = {
			callId: "session-1:1",
			provider: "openai",
			model: "gpt-test",
			turnIndex: 0,
		};

		const capture = createApiPayloadCapture(call, { ok: true, skip: () => "ignored", big: 1n });

		expect(capture.payload).toEqual({ ok: true, big: "1" });
	});
});

describe("AgentHarness OpenAI capture", () => {
	it("persists request, usage, and turn usage entries without changing the provider flow", async () => {
		const models = createModels();
		const openAiFaux = fauxProvider({
			provider: "openai",
			api: "openai-responses",
			models: [{ id: "gpt-test", name: "GPT Test" }],
		});
		models.setProvider(openAiFaux.provider);
		openAiFaux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		const session = new Session(new InMemorySessionStorage({ metadata: { id: "session-1", createdAt: "now" } }));
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: openAiFaux.getModel(),
			streamOptions: { cacheRetention: "short" },
			openAiPricing: {
				inputPerMillion: 1,
				cachedInputPerMillion: 0.1,
				outputPerMillion: 2,
				effectiveDate: "2026-06-30",
				source: "test",
			},
		});

		await harness.prompt("hello");
		await harness.prompt("hello again");

		const requestCaptures = await session.getApiCallCaptures();
		const usageCaptures = await session.getApiCallUsages();
		const turnUsages = await session.getTurnUsages();

		expect(requestCaptures).toHaveLength(2);
		expect(requestCaptures[0]!.capture).toMatchObject({
			callId: "session-1:1",
			provider: "openai",
			model: "gpt-test",
			turnIndex: 0,
		});
		expect(usageCaptures).toHaveLength(2);
		expect(usageCaptures[0]!.capture.cost.pricing).toBe("openai");
		expect(turnUsages).toHaveLength(2);
		expect(turnUsages[0]!.usage.callIds).toEqual(["session-1:1"]);
		expect(turnUsages[1]!.usage.callIds).toEqual(["session-1:2"]);
		expect(harness.getTokenAccountingSnapshot().turns).toHaveLength(2);
	});
});
