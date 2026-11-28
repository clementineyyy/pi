// HTTP task API and server lifecycle for the personal agent.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { CreateTaskRequest, ResearchTask, RuntimeConfiguration } from "../shared/contracts.ts";
import { createModelRuntime, type ModelRuntime } from "./model.ts";
import { readMcpSearchConfiguration } from "./search.ts";
import { PiResearchRunner } from "./runner.ts";
import { InMemoryTaskRepository, type ResearchRunner, TaskService, type TaskRepository } from "./tasks.ts";

const MAX_REQUEST_BYTES = 64 * 1024;

export type PersonalAgentServerOptions = {
	readonly hostname?: string;
	readonly port?: number;
	readonly env?: NodeJS.ProcessEnv;
	readonly repository?: TaskRepository;
	readonly runner?: ResearchRunner;
	readonly modelRuntime?: ModelRuntime;
	readonly authorize?: (request: IncomingMessage) => boolean | Promise<boolean>;
	readonly staticAssets?: Readonly<Partial<Record<"index.html" | "app.js" | "style.css", string | Uint8Array>>>;
	readonly onBackgroundError?: (error: unknown) => void;
};

export type PersonalAgentServer = {
	readonly host: string;
	readonly port: number;
	readonly configuration: RuntimeConfiguration;
	close(): Promise<void>;
};

/** Starts the personal agent task API using injectable storage, execution, and authorization boundaries. */
export async function startPersonalAgentServer(
	options: PersonalAgentServerOptions = {},
): Promise<PersonalAgentServer> {
	const env = options.env ?? process.env;
	const hostname = options.hostname ?? "127.0.0.1";
	const modelRuntime = options.modelRuntime ?? createModelRuntime(env);
	const repository = options.repository ?? new InMemoryTaskRepository();
	const runner =
		options.runner ?? new PiResearchRunner(modelRuntime, readMcpSearchConfiguration(env));
	const tasks = new TaskService(repository, runner, options.onBackgroundError);
	const authorize = options.authorize ?? loopbackOnly;
	const server = createServer((request, response) => {
		void handleRequest(request, response, tasks, modelRuntime.configuration, authorize, options.staticAssets ?? {}).catch(
			(error: unknown) => {
				if (response.headersSent) {
					response.destroy(error instanceof Error ? error : undefined);
					return;
				}
				writeJson(response, 500, { error: "The server could not complete this request." });
			},
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, hostname, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address() as AddressInfo;
	return {
		host: hostname,
		port: address.port,
		configuration: modelRuntime.configuration,
		close: () => closeServer(server),
	};
}

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	tasks: TaskService,
	configuration: RuntimeConfiguration,
	authorize: (request: IncomingMessage) => boolean | Promise<boolean>,
	staticAssets: PersonalAgentServerOptions["staticAssets"],
): Promise<void> {
	const url = new URL(request.url ?? "/", "http://localhost");
	if (
		(request.method === "GET" || request.method === "HEAD") &&
		serveStatic(request.method, url.pathname, response, staticAssets ?? {})
	)
		return;
	if (!url.pathname.startsWith("/api/")) return writeJson(response, 404, { error: "Not found." });
	if (!(await authorize(request))) return writeJson(response, 401, { error: "Sign in to use this personal agent." });
	if (request.method === "GET" && url.pathname === "/api/config") return writeJson(response, 200, configuration);
	if (request.method === "GET" && url.pathname === "/api/tasks") return writeJson(response, 200, await tasks.list());
	if (request.method === "POST" && url.pathname === "/api/tasks") {
		let input: unknown;
		try {
			input = await readRequest(request);
		} catch (error) {
			return writeJson(response, 400, { error: errorText(error) });
		}
		if (!isCreateTaskRequest(input)) return writeJson(response, 400, { error: "Provide a valid chat message." });
		if (input.request.trim().length === 0) return writeJson(response, 400, { error: "Enter a research question." });
		if (input.request.trim().length > 5_000)
			return writeJson(response, 400, { error: "Messages must be 5,000 characters or fewer." });
		if (input.conversationId !== undefined && (input.conversationId.length === 0 || input.conversationId.length > 100))
			return writeJson(response, 400, { error: "The conversation id is invalid." });
		try {
			const task = await tasks.create(input.request, input.mode ?? "chat", input.conversationId);
			return writeJson(response, 202, task);
		} catch {
			return writeJson(response, 503, { error: "The task could not be saved. Please try again." });
		}
	}
	const taskPath = /^\/api\/tasks\/([^/]+)(?:\/(events))?$/u.exec(url.pathname);
	if (!taskPath) return writeJson(response, 404, { error: "Not found." });
	let id: string;
	try {
		id = decodeURIComponent(taskPath[1]!);
	} catch {
		return writeJson(response, 400, { error: "Invalid task id." });
	}
	const task = await tasks.get(id);
	if (!task) return writeJson(response, 404, { error: "Task not found." });
	if (request.method === "GET" && taskPath[2] === "events") return await streamTask(request, response, tasks, task);
	if (request.method === "GET" && taskPath[2] === undefined) return writeJson(response, 200, task);
	return writeJson(response, 405, { error: "Method not allowed." });
}

async function readRequest(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.byteLength;
		if (size > MAX_REQUEST_BYTES) throw new Error("Request body exceeds 64 KB.");
		chunks.push(buffer);
	}
	if (chunks.length === 0) return undefined;
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isCreateTaskRequest(value: unknown): value is CreateTaskRequest {
	return (
		value !== null &&
		typeof value === "object" &&
		"request" in value &&
		typeof value.request === "string" &&
		(!("mode" in value) || value.mode === "chat" || value.mode === "research") &&
		(!("conversationId" in value) || typeof value.conversationId === "string")
	);
}

async function streamTask(
	request: IncomingMessage,
	response: ServerResponse,
	tasks: TaskService,
	initial: ResearchTask,
): Promise<void> {
	response.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	let active = true;
	let unsubscribe = () => {};
	let lastSent: string | undefined;
	const cleanup = (): void => {
		if (!active) return;
		active = false;
		unsubscribe();
		response.off("close", cleanup);
		response.end();
	};
	const send = (task: ResearchTask): void => {
		if (!active) return;
		const serialized = JSON.stringify(task);
		if (serialized === lastSent) return;
		lastSent = serialized;
		response.write(`event: task\ndata: ${serialized}\n\n`);
		if (isTerminal(task)) cleanup();
	};
	unsubscribe = tasks.subscribe(initial.id, send);
	response.once("close", cleanup);
	const current = await tasks.get(initial.id);
	if (active) send(current ?? initial);
}

function loopbackOnly(request: IncomingMessage): boolean {
	const remoteAddress = request.socket.remoteAddress;
	return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

function serveStatic(
	method: "GET" | "HEAD",
	pathname: string,
	response: ServerResponse,
	assets: NonNullable<PersonalAgentServerOptions["staticAssets"]>,
): boolean {
	const file = pathname === "/" || pathname === "/index.html" ? "index.html" : pathname.slice(1);
	if (file !== "index.html" && file !== "app.js" && file !== "style.css") return false;
	const body = assets[file];
	if (body === undefined) {
		writeJson(response, 404, { error: "The browser UI assets have not been loaded by this host." });
		return true;
	}
	const contentType = file === "index.html" ? "text/html; charset=utf-8" : file === "app.js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
	response.writeHead(200, {
		"Content-Type": contentType,
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
	});
	response.end(method === "HEAD" ? undefined : body);
	return true;
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	response.end(JSON.stringify(payload));
}

function isTerminal(task: ResearchTask): boolean {
	return task.state === "succeeded" || task.state === "failed";
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}
