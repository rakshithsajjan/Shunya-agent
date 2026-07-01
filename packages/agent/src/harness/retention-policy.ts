import { type Static, Type } from "typebox";
import type { AgentMessage, AgentTool } from "../types.ts";

export interface StoreEvidenceDetails {
	summary: string;
	toolCallId: string;
	timestamp: number;
	retain_call_ids?: string[];
}

const storeEvidenceSchema = Type.Object({
	summary: Type.String({
		description: "Clear summary of findings, paths, schemas, or decisions that must be remembered.",
	}),
	retain_call_ids: Type.Optional(
		Type.Array(Type.String(), {
			description: "Tool call IDs whose raw outputs should be retained exactly in context, avoiding compression.",
		}),
	),
});

type StoreEvidenceParams = Static<typeof storeEvidenceSchema>;

/**
 * The store_evidence tool definition.
 * Used by the agent to summarize raw outputs at the end of a turn sequence.
 */
export const storeEvidenceTool: AgentTool<typeof storeEvidenceSchema, StoreEvidenceDetails> & {
	promptSnippet?: string;
	promptGuidelines?: string[];
} = {
	name: "store_evidence",
	label: "Store Evidence",
	description:
		"Call this to record a concise, hindsight-aware summary of key facts, file paths, and findings from raw tool outputs generated during this turn. The harness will drop the heavy raw outputs from your context on the next turn, retaining only this summary.",
	promptSnippet: "store_evidence: record a summary of findings to clear raw tool outputs",
	promptGuidelines: [
		"Call store_evidence at the end of your task/turn sequence to summarize findings.",
		"After storing evidence, the raw tool results from this turn will be cleared from context in subsequent turns.",
		"If a tool output contains a stack trace, failing test, or critical file snippet you need for the next step, include its call ID in retain_call_ids to prevent it from being compressed.",
	],
	parameters: storeEvidenceSchema,
	execute: async (toolCallId, params: StoreEvidenceParams) => {
		return {
			content: [
				{
					type: "text",
					text: "Evidence stored. Raw outputs from this turn will be projected out of context on the next turn.",
				},
			],
			details: {
				summary: params.summary,
				retain_call_ids: params.retain_call_ids,
				toolCallId,
				timestamp: Date.now(),
			} satisfies StoreEvidenceDetails,
		};
	},
};

/**
 * Scans context messages and projects out raw tool results from turns
 * where a store_evidence summary was successfully recorded.
 */
export function projectContext(messages: AgentMessage[]): AgentMessage[] {
	// First, identify all store_evidence tool call IDs and their associated summary text
	const summariesByCallId = new Map<string, string>();
	const retainedCallIds = new Set<string>();

	for (const msg of messages) {
		if (msg.role === "toolResult" && msg.toolName === "store_evidence" && msg.details) {
			const details = msg.details as Partial<StoreEvidenceDetails>;
			if (details.summary && msg.toolCallId) {
				summariesByCallId.set(msg.toolCallId, details.summary);
			}
			if (details.retain_call_ids && Array.isArray(details.retain_call_ids)) {
				for (const id of details.retain_call_ids) {
					retainedCallIds.add(id);
				}
			}
		}
	}

	if (summariesByCallId.size === 0) {
		return messages;
	}

	// We split messages into task batches bounded by user messages. The agent often calls tools,
	// reads their results, then calls store_evidence in a later assistant message. Once evidence is
	// stored, all prior raw tool results in that user batch can be projected out.
	const projected: AgentMessage[] = [];

	// A map to find which assistant message emitted which tool calls
	const callIdToAssistantIndex = new Map<string, number>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (block.type === "toolCall") {
					callIdToAssistantIndex.set(block.id, i);
				}
			}
		}
	}

	const compressedAssistantRanges: Array<{ start: number; end: number }> = [];
	for (const [callId] of summariesByCallId) {
		const idx = callIdToAssistantIndex.get(callId);
		if (idx !== undefined) {
			let start = 0;
			for (let i = idx; i >= 0; i--) {
				if (messages[i]?.role === "user") {
					start = i;
					break;
				}
			}
			compressedAssistantRanges.push({ start, end: idx });
		}
	}

	for (const msg of messages) {
		if (msg.role === "toolResult") {
			// If this is a tool result...
			if (msg.toolName === "store_evidence") {
				// Keep store_evidence itself so the agent knows it was successfully stored
				projected.push(msg);
				continue;
			}

			if (msg.toolCallId && retainedCallIds.has(msg.toolCallId)) {
				// Explicitly retained
				projected.push(msg);
				continue;
			}

			const parentAssistantIdx = callIdToAssistantIndex.get(msg.toolCallId);
			const isInCompressedBatch =
				parentAssistantIdx !== undefined &&
				compressedAssistantRanges.some(
					(range) => parentAssistantIdx >= range.start && parentAssistantIdx <= range.end,
				);
			if (isInCompressedBatch) {
				// Project out this raw tool result because the batch successfully called store_evidence.
				continue;
			}
		}

		projected.push(msg);
	}

	return projected;
}
