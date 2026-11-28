// Live acceptance path through the PC page, task API, pi Agent, MCP search, and saved result.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { startPersonalAgentServer } from "../src/server/server.ts";
import type { ResearchTask } from "../src/shared/contracts.ts";

const requiredConfiguration = [
	"AGENT_MODEL_ENDPOINT",
	"AGENT_MODEL_ID",
	"AGENT_MODEL_API_KEY",
	"AGENT_SEARCH_MCP_URL",
] as const;
const missingConfiguration = requiredConfiguration.filter((name) => !process.env[name]?.trim());

test(
	"PC public research task completes through real configured model and MCP search",
	{ skip: missingConfiguration.length ? `Configure ${missingConfiguration.join(", ")} to run the live acceptance path.` : false, timeout: 300_000 },
	async () => {
		const staticAssets = {
			"index.html": await readFile(new URL("../public/index.html", import.meta.url), "utf8"),
			"app.js": await readFile(new URL("../public/app.js", import.meta.url), "utf8"),
			"style.css": await readFile(new URL("../public/style.css", import.meta.url), "utf8"),
		};
		const server = await startPersonalAgentServer({ port: 0, staticAssets });
		const origin = `http://${server.host}:${server.port}`;
		try {
			const page = await fetch(origin);
			assert.equal(page.status, 200);
			assert.match(await page.text(), /今天有什么想做的/u);

			const configurationResponse = await fetch(`${origin}/api/config`);
			assert.equal(configurationResponse.status, 200);
			const configuration = await configurationResponse.text();
			assert.equal(configuration.includes(process.env.AGENT_MODEL_API_KEY ?? ""), false);
			const searchToken = process.env.AGENT_SEARCH_MCP_TOKEN?.trim();
			if (searchToken) assert.equal(configuration.includes(searchToken), false);

			const submission = await fetch(`${origin}/api/tasks`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ request: "Research pi agent core and summarize its main capabilities with source links.", mode: "research" }),
			});
			assert.equal(submission.status, 202);
			const accepted = (await submission.json()) as ResearchTask;
			assert.ok(accepted.id);

			const events = await fetch(`${origin}/api/tasks/${encodeURIComponent(accepted.id)}/events`, {
				signal: AbortSignal.timeout(240_000),
			});
			assert.equal(events.status, 200);
			const completed = await readCompletion(events);
			assert.equal(completed.state, "succeeded", completed.failure);
			assert.ok(completed.summary?.trim());
			assert.ok(completed.sources.length > 0, "The real search provider returned no source URLs.");
			assert.ok(completed.sources.every((source) => /^https?:\/\//u.test(source.url)));

			const reconnected = await fetch(`${origin}/api/tasks/${encodeURIComponent(accepted.id)}`);
			assert.equal(reconnected.status, 200);
			const saved = (await reconnected.json()) as ResearchTask;
			assert.equal(saved.state, "succeeded");
			assert.equal(saved.summary, completed.summary);
			assert.deepEqual(saved.sources, completed.sources);
		} finally {
			await server.close();
		}
	},
);

async function readCompletion(response: Response): Promise<ResearchTask> {
	const reader = response.body?.getReader();
	assert.ok(reader, "The task event stream has no response body.");
	const decoder = new TextDecoder();
	let buffered = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) throw new Error("Task event stream ended before completion.");
		buffered += decoder.decode(value, { stream: true });
		const blocks = buffered.split("\n\n");
		buffered = blocks.pop() ?? "";
		for (const block of blocks) {
			const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice("data: ".length);
			if (!data) continue;
			const task = JSON.parse(data) as ResearchTask;
			if (task.state === "succeeded" || task.state === "failed") {
				await reader.cancel();
				return task;
			}
		}
	}
}
