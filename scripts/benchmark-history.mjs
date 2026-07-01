#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const LEDGER_PATH = resolve("dev-notes/benchmark/benchmark-history.csv");

if (!existsSync(LEDGER_PATH)) {
	console.error(`Ledger not found at ${LEDGER_PATH}`);
	process.exit(1);
}

const lines = readFileSync(LEDGER_PATH, "utf8").split("\n").filter(Boolean);
if (lines.length < 2) {
	console.log("No data recorded in ledger yet.");
	process.exit(0);
}

const header = lines[0].split(",");
const rows = lines.slice(1).map(line => {
	const values = line.split(",");
	return {
		Date: values[0].split('_')[0],
		Suite: values[2],
		Variant: values[3],
		Tasks: values[4],
		Success: values[5],
		Rate: `${values[6]}%`,
		Cost: `$${Number(values[7]).toFixed(2)}`,
		"Cost/Success": `$${Number(values[8]).toFixed(2)}`
	};
});

console.table(rows);
