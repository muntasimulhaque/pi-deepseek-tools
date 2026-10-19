#!/usr/bin/env node
/**
 * Approve an npm staged publish with web 2FA (security key / Windows Hello),
 * without a TTY. Mirrors npm's own otplease + webAuthOpener flow:
 *   POST /-/stage/<id>/approve        -> 401 { authUrl, doneUrl }
 *   open authUrl, poll doneUrl         -> { token }
 *   POST /-/stage/<id>/approve + npm-otp: <token>
 */

const STAGE_ID = process.argv[2] || process.env.NPM_STAGE_ID;
const BASE = "https://registry.npmjs.org";
const TOKEN = process.env.NPM_PUBLISH_TOKEN;
const OTP_HEADER = "npm-otp";

if (!STAGE_ID || !TOKEN) {
	console.error("usage: NPM_PUBLISH_TOKEN=… node scripts/approve-stage.mjs <stage-id>");
	process.exit(2);
}

function log(...args) {
	console.log(new Date().toISOString().slice(11, 19), ...args);
}

async function approve(otp) {
	const headers = {
		Authorization: `Bearer ${TOKEN}`,
		"Content-Type": "application/json",
		Accept: "application/json",
		"npm-auth-type": "web",
		"npm-command": "stage",
	};
	if (otp) headers[OTP_HEADER] = otp;
	const res = await fetch(`${BASE}/-/stage/${STAGE_ID}/approve`, {
		method: "POST",
		headers,
		body: "{}",
	});
	const text = await res.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: res.status, body };
}

const first = await approve();
log("approve ->", first.status);

if (first.status === 200 || first.status === 201) {
	log("approved without 2FA:", JSON.stringify(first.body).slice(0, 200));
	process.exit(0);
}

if (first.status !== 401) {
	log("unexpected response:", JSON.stringify(first.body).slice(0, 500));
	process.exit(1);
}

const { authUrl, doneUrl } = first.body || {};
if (!authUrl || !doneUrl) {
	log("no authUrl/doneUrl in 401 body:", JSON.stringify(first.body).slice(0, 500));
	process.exit(1);
}

log("OPEN THIS URL AND APPROVE WITH WINDOWS HELLO / SECURITY KEY:");
log(authUrl);
log("waiting for approval...");

const deadline = Date.now() + 10 * 60 * 1000;
let otp;
while (Date.now() < deadline) {
	await new Promise((r) => setTimeout(r, 2000));
	const res = await fetch(doneUrl, {
		headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
	});
	if (res.status === 202) continue;
	const text = await res.text();
	if (!res.ok) {
		log("poll", res.status, text.slice(0, 200));
		continue;
	}
	try {
		const body = JSON.parse(text);
		otp = body.token;
	} catch {
		otp = text.trim();
	}
	if (otp) break;
}

if (!otp) {
	log("timed out waiting for browser approval");
	process.exit(1);
}

log("got one-time token, retrying approve...");
const second = await approve(otp);
log("final approve ->", second.status, JSON.stringify(second.body).slice(0, 300));
process.exit(second.status === 200 || second.status === 201 ? 0 : 1);
