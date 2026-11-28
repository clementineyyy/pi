# pi Personal Agent

The PC workbench centers on conversations. Ordinary turns use pi Agent with the configured model; a turn can explicitly
enable the public web search plugin to gather current sources. The service saves each turn and streams status and the
assistant response back to the browser. The browser does not receive provider credentials.

## Runtime configuration

Set these values in the service's runtime secret/configuration mechanism before starting it:

- `AGENT_MODEL_ENDPOINT`: model API base URL.
- `AGENT_MODEL_ID`: model identity supported by pi-ai.
- `AGENT_MODEL_API_KEY`: provider credential.
- `AGENT_SEARCH_MCP_URL`: optional MCP server endpoint that exposes a public web search tool. Set it to enable the research plugin; the tool is connected only for turns where the user enables it.
- `AGENT_SEARCH_MCP_TOKEN`: optional MCP authorization token for the research plugin.
- `AGENT_SEARCH_MCP_TOOL`: optional exact MCP tool name; otherwise the server selects the available search tool.

Do not put credentials in source control or browser-visible settings. The first implementation uses an in-memory task
repository for local development. It keeps results available across browser reconnects while the process stays up;
it does not restore work after a service restart. A durable repository adapter is deferred to the shared persistence
decision.

## Run

Copy or edit `apps/personal-agent/.env` and fill in the model and MCP values above. The start command loads this file
automatically; values already set in the process environment take precedence. Then build the workspace packages once
with `npm run build` and run `npm run start --workspace=pi-personal-agent`. The local executable binds to `127.0.0.1`
by default. Cloud hosts should import `startPersonalAgentServer()` and provide their identity
middleware and durable `TaskRepository`; the shared hosting and persistence choices remain open in issues #3 and #9.

The live acceptance path requires a working OpenAI-compatible model endpoint and an MCP endpoint with a real
public-information search tool configured above. Run it with `npm run test:live --workspace=pi-personal-agent` after
setting the runtime configuration. The test uses those real services and does not replace them with fakes.
