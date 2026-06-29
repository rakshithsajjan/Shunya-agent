import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { projectContext, storeEvidenceTool } from "../../../agent/src/harness/retention-policy.ts";

/**
 * Shunya Extension: Implement task-level tool output batch compression
 * via agent self-summary at the end of a tool-calling sequence.
 */
export default function shunyaExtension(pi: ExtensionAPI) {
	// Register the store_evidence tool dynamically
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
			return storeEvidenceTool.execute(toolCallId, params, signal, onUpdate);
		},
	});

	// Register context projection to replace raw outputs with the stored evidence
	pi.on("context", async (event) => {
		const projected = projectContext(event.messages);
		return { messages: projected };
	});
}
