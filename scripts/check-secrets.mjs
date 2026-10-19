#!/usr/bin/env node
/**
 * Pre-publish guard: refuses to publish if a credential-looking string is in
 * any tracked file. The package must never carry API keys; keys are read at
 * runtime from DEEPSEEK_API_KEY or the user's own Pi auth.json.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
	[/\bsk-[A-Za-z0-9_-]{20,}\b/g, "API key (sk-…)"],
	[/\bnpm_[A-Za-z0-9]{20,}\b/g, "npm token"],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "GitHub token"],
	[/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "GitHub fine-grained token"],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "private key"],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "Slack token"],
];

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
	.split("\0")
	.filter(Boolean)
	.filter((file) => !file.endsWith("package-lock.json"));

let failures = 0;
for (const file of files) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		continue;
	}
	const lines = text.split("\n");
	for (let n = 0; n < lines.length; n++) {
		for (const [pattern, label] of PATTERNS) {
			pattern.lastIndex = 0;
			for (const match of lines[n].matchAll(pattern)) {
				failures++;
				const found = match[0];
				const redacted = `${found.slice(0, 4)}…(${found.length} chars)`;
				console.error(`${file}:${n + 1}  ${label}: ${redacted}`);
			}
		}
	}
}

if (failures > 0) {
	console.error(`\nRefusing to publish: ${failures} credential-like string(s) found.`);
	process.exit(1);
}
console.log(`check-secrets: ${files.length} tracked files clean`);
