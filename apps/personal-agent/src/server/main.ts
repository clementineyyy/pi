// Local executable host for the personal agent UI and task API.

import { readFile } from "node:fs/promises";
import { startPersonalAgentServer } from "./server.ts";

const port = readPort(process.env.PORT);
const staticAssets = {
	"index.html": await readFile(new URL("../../public/index.html", import.meta.url), "utf8"),
	"app.js": await readFile(new URL("../../public/app.js", import.meta.url), "utf8"),
	"style.css": await readFile(new URL("../../public/style.css", import.meta.url), "utf8"),
};
const server = await startPersonalAgentServer({ hostname: "127.0.0.1", port, staticAssets });
console.log(`pi Personal Agent: http://${server.host}:${server.port}`);

let closing = false;
const close = (): void => {
	if (closing) return;
	closing = true;
	void server.close().catch((error: unknown) => {
		console.error("Could not close personal agent server:", error);
		process.exitCode = 1;
	});
};
process.once("SIGINT", close);
process.once("SIGTERM", close);

function readPort(value: string | undefined): number {
	if (value === undefined || value.trim() === "") return 4317;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("PORT must be an integer from 0 to 65535.");
	return port;
}
