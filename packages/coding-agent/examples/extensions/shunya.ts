import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { projectContext, storeEvidenceTool } from "../../../agent/src/harness/retention-policy.ts";

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

	async function saveCompressedSession(ctx: ExtensionContext) {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;

		const compressedFile = sessionFile.endsWith(".jsonl")
			? sessionFile.replace(/\.jsonl$/, ".compressed.jsonl")
			: `${sessionFile}.compressed.jsonl`;

		try {
			const allEntries = ctx.sessionManager.getEntries();
			const messages = allEntries.flatMap((e) => (e.type === "message" ? [e.message] : []));
			const projectedMessages = projectContext(messages);
			const projectedMessageSet = new Set(projectedMessages);

			const compressedEntries = allEntries.filter((entry) => {
				if (entry.type === "message") {
					return projectedMessageSet.has(entry.message);
				}
				return true;
			});

			const lines = `${compressedEntries.map((e) => JSON.stringify(e)).join("\n")}\n`;
			await fs.promises.writeFile(compressedFile, lines, "utf8");
		} catch (err) {
			ctx.ui.notify(
				`Failed to save compressed session: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
	}

	pi.on("session_start", (_event, ctx) => {
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

	// Save compressed session data on agent end
	pi.on("agent_end", async (_event, ctx) => {
		if (shunyaEnabled) {
			await saveCompressedSession(ctx);
		}
	});
}
