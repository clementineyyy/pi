// Adapts one configured MCP public search tool to pi's agent tool interface.

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { unsafe } from "@earendil-works/pi-schema";
import {
	McpClient,
	normalizeMcpInputSchema,
	StreamableHttpTransport,
	type CallToolResult,
	type Tool,
} from "@earendil-works/pi-mcp";
import type { TaskSource } from "../shared/contracts.ts";

export type McpSearchConfiguration = {
	readonly url: string;
	readonly token?: string;
	readonly keyless?: boolean;
	readonly toolName?: string;
};

/** Reads the selected public-search MCP endpoint and optional bearer credential from runtime secrets. */
export function readMcpSearchConfiguration(env: NodeJS.ProcessEnv = process.env): McpSearchConfiguration | undefined {
	const url = env.AGENT_SEARCH_MCP_URL?.trim();
	if (!url) return undefined;
	const token = env.AGENT_SEARCH_MCP_TOKEN?.trim();
	const keyless = env.AGENT_SEARCH_MCP_KEYLESS?.trim().toLowerCase() === "true";
	const toolName = env.AGENT_SEARCH_MCP_TOOL?.trim();
	return {
		url,
		...(token ? { token } : {}),
		...(keyless ? { keyless } : {}),
		...(toolName ? { toolName } : {}),
	};
}

/** Creates an agent tool backed by a real configured MCP search server. */
export async function createMcpPublicSearchTool(
	configuration: McpSearchConfiguration,
	onSources: (sources: readonly TaskSource[]) => Promise<void>,
	onInvoked: () => void,
	onFailure: (error: unknown) => void,
): Promise<AgentTool<Record<string, unknown>, { sources: readonly TaskSource[] }>> {
	const endpoint = new URL(configuration.url);
	if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:")
		throw new Error("AGENT_SEARCH_MCP_URL must use HTTP or HTTPS.");
	const search = await withClient(configuration, async (client) =>
		selectTool(await client.listTools(), configuration.toolName),
	);
	return {
		name: "public_web_search",
		label: "Search public web",
		description:
			"Search current public web information relevant to the user's request. Use this for factual research. Do not use it to access private accounts.",
		parameters: unsafe<Record<string, unknown>>(normalizeMcpInputSchema(search.inputSchema)),
		executionMode: "sequential",
		execute: async (_toolCallId, args, signal): Promise<AgentToolResult<{ sources: readonly TaskSource[] }>> => {
			if (signal?.aborted) throw signal.reason;
			onInvoked();
			try {
				return await withClient(configuration, async (client) => {
					const result = await client.callTool(search.name, searchArguments(args), { signal });
					if (result.isError) throw new Error(readMcpText(result) || "The configured public search tool failed.");
					const sources = extractTaskSources(result);
					await onSources(sources);
					const text = readMcpText(result);
					return {
						content: [{ type: "text", text: text || JSON.stringify(result.structuredContent ?? result).slice(0, 24_000) }],
						details: { sources },
					};
				});
			} catch (error) {
				onFailure(error);
				throw error;
			}
		},
	};
}

async function withClient<T>(configuration: McpSearchConfiguration, run: (client: McpClient) => Promise<T>): Promise<T> {
	const client = new McpClient({ name: "pi-personal-agent", version: "0.1.0" });
	const headers = {
		...(configuration.token ? { Authorization: `Bearer ${configuration.token}` } : {}),
		...(configuration.keyless ? { "X-Tavily-Access-Mode": "keyless" } : {}),
	};
	const transport = new StreamableHttpTransport({
		url: configuration.url,
		...(Object.keys(headers).length > 0 ? { headers } : {}),
	});
	await client.connect(transport);
	try {
		return await run(client);
	} finally {
		await client.close();
	}
}

function selectTool(tools: readonly Tool[], configuredName: string | undefined): Tool {
	if (configuredName) {
		const selected = tools.find((tool) => tool.name === configuredName);
		if (selected) return selected;
		throw new Error(`AGENT_SEARCH_MCP_TOOL "${configuredName}" is not available on the configured MCP server.`);
	}
	const namedSearchTools = tools.filter((tool) => /(?:^|[-_])search(?:$|[-_])/iu.test(tool.name));
	if (namedSearchTools.length === 1) return namedSearchTools[0]!;
	if (namedSearchTools.length > 1)
		throw new Error(
			`The configured MCP server exposes multiple search tools (${namedSearchTools.map((tool) => tool.name).join(", ")}). Set AGENT_SEARCH_MCP_TOOL to choose one.`,
		);
	const candidates = tools.filter((tool) => /\b(search|web|internet)\b/iu.test(`${tool.title ?? ""} ${tool.description ?? ""}`));
	if (candidates.length === 1) return candidates[0]!;
	if (candidates.length === 0) throw new Error("The configured MCP server exposes no search tool. Set AGENT_SEARCH_MCP_TOOL.");
	throw new Error(
		`The configured MCP server exposes multiple likely search tools (${candidates.map((tool) => tool.name).join(", " )}). Set AGENT_SEARCH_MCP_TOOL to choose one.`,
	);
}

function readMcpText(result: CallToolResult): string {
	return result.content
		.flatMap((item) => {
			if (item.type === "text") return [item.text];
			if (item.type === "resource" && "text" in item.resource) return [item.resource.text];
			return [];
		})
		.join("\n")
		.slice(0, 24_000);
}

function extractTaskSources(result: CallToolResult): readonly TaskSource[] {
	const textBlocks = result.content.flatMap((item) => {
		if (item.type === "text") return [item.text];
		if (item.type === "resource" && "text" in item.resource) return [item.resource.text];
		return [];
	});
	const roots: unknown[] = [result.structuredContent, ...result.content];
	for (const text of textBlocks) {
		try {
			roots.push(JSON.parse(text));
		} catch {
			// Plain text and markdown are handled as URL evidence below.
		}
	}
	const sources = new Map<string, TaskSource>();
	const pending = roots;
	let visited = 0;
	while (pending.length > 0 && visited < 1_000 && sources.size < 20) {
		const value = pending.pop();
		visited++;
		if (Array.isArray(value)) {
			pending.push(...value);
			continue;
		}
		if (!isRecord(value)) continue;
		const url = stringField(value, ["url", "uri", "link"]);
		if (url && isHttpUrl(url)) {
			const title = stringField(value, ["title", "name"]) ?? url;
			const snippet = stringField(value, ["snippet", "description", "content", "text"]) ?? "";
			sources.set(url, { title: title.slice(0, 300), url, snippet: snippet.slice(0, 1_000) });
		}
		pending.push(...Object.values(value));
	}
	if (sources.size === 0) {
		for (const text of textBlocks) {
			for (const source of extractTextSources(text)) {
				if (sources.size >= 20) break;
				sources.set(source.url, source);
			}
			if (sources.size >= 20) break;
		}
	}
	return [...sources.values()];
}

function extractTextSources(text: string): readonly TaskSource[] {
	const sources = new Map<string, TaskSource>();
	const markdownLinks = /\[([^\]]{1,300})\]\((https?:\/\/[^\s)]+)\)/giu;
	for (const match of text.matchAll(markdownLinks)) {
		const title = match[1]?.trim();
		const url = cleanUrl(match[2] ?? "");
		if (title && isHttpUrl(url)) sources.set(url, { title, url, snippet: "" });
	}
	const bareUrls = /https?:\/\/[^\s<>"')\]]+/giu;
	for (const match of text.matchAll(bareUrls)) {
		const url = cleanUrl(match[0]);
		if (isHttpUrl(url) && !sources.has(url)) sources.set(url, { title: url, url, snippet: "" });
	}
	return [...sources.values()];
}

function cleanUrl(value: string): string {
	return value.replace(/[.,;:!?]+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function searchArguments(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error("The configured public search tool requires object arguments.");
	return value;
}

function stringField(value: Record<string, unknown>, names: readonly string[]): string | undefined {
	for (const name of names) {
		const field = value[name];
		if (typeof field === "string" && field.trim()) return field.trim();
	}
	return undefined;
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
	}
}
