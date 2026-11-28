const taskList = document.querySelector("#task-list");
const conversationContent = document.querySelector("#conversation-content");
const conversationScroll = document.querySelector("#conversation-scroll");
const taskForm = document.querySelector("#task-form");
const requestInput = document.querySelector("#task-request");
const formMessage = document.querySelector("#form-message");
const submitButton = document.querySelector("#submit-task");
const charCount = document.querySelector("#char-count");
const connectionStatus = document.querySelector("#connection-status");
const views = {
	chat: document.querySelector("#chat-view"),
	plugins: document.querySelector("#plugins-view"),
	settings: document.querySelector("#settings-view"),
};

let tasks = [];
const initialQuery = new URLSearchParams(location.search);
let activeView = initialQuery.get("view") === "settings" || initialQuery.get("view") === "plugins" ? initialQuery.get("view") : "chat";
let selectedConversationId = initialQuery.get("conversation");
const legacyTaskId = initialQuery.get("task");
let eventStream;
let pollTimer;
let listRefreshing = false;
let searchEnabled = localStorage.getItem("pi.public-search-enabled") === "true";

const stateLabels = { queued: "已接收", running: "处理中", succeeded: "已完成", failed: "未完成" };

function setConnection(connected, message) {
	connectionStatus.classList.toggle("is-offline", !connected);
	connectionStatus.querySelector("span:last-child").textContent = message;
}

function updateUrlState(mode) {
	const url = new URL(location.href);
	if (activeView === "chat") url.searchParams.delete("view");
	else url.searchParams.set("view", activeView);
	url.searchParams.delete("task");
	if (selectedConversationId) url.searchParams.set("conversation", selectedConversationId);
	else url.searchParams.delete("conversation");
	if (url.href === location.href) return;
	if (mode === "push") history.pushState(null, "", url);
	else history.replaceState(null, "", url);
}

function showView(name, historyMode = "push") {
	activeView = name;
	for (const [key, view] of Object.entries(views)) view.hidden = key !== name;
	for (const button of document.querySelectorAll("[data-view]")) {
		const active = button.dataset.view === name;
		button.classList.toggle("is-active", active);
		if (active) button.setAttribute("aria-current", "page");
		else button.removeAttribute("aria-current");
	}
	document.querySelector("#main-content").focus({ preventScroll: true });
	document.querySelector("#sidebar-scrim").hidden = true;
	document.querySelector(".sidebar").classList.remove("is-open");
	if (historyMode !== "restore") updateUrlState(historyMode);
}

function dateLabel(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "刚刚";
	return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function conversations() {
	const grouped = new Map();
	for (const task of [...tasks].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
		const id = task.conversationId || task.id;
		const conversation = grouped.get(id) ?? { id, turns: [] };
		conversation.turns.push(task);
		grouped.set(id, conversation);
	}
	return [...grouped.values()].sort((left, right) => right.turns.at(-1).createdAt.localeCompare(left.turns.at(-1).createdAt));
}

function renderHistory() {
	taskList.replaceChildren();
	const items = conversations();
	if (!items.length) {
		const empty = document.createElement("p");
		empty.className = "history-empty";
		empty.textContent = "对话会显示在这里";
		taskList.append(empty);
		return;
	}
	for (const conversation of items) {
		const first = conversation.turns[0];
		const latest = conversation.turns.at(-1);
		const button = document.createElement("button");
		button.type = "button";
		button.className = `history-item${conversation.id === selectedConversationId ? " is-active" : ""}`;
		button.setAttribute("aria-current", conversation.id === selectedConversationId ? "page" : "false");
		button.textContent = first.request;
		button.title = first.request;
		const meta = document.createElement("span");
		meta.className = "history-item-meta";
		meta.textContent = latest.state === "queued" || latest.state === "running" ? "处理中" : dateLabel(latest.updatedAt);
		button.append(meta);
		button.addEventListener("click", () => openConversation(conversation.id));
		taskList.append(button);
	}
}

function createMessage(role, content, className = "") {
	const row = document.createElement("article");
	row.className = `message-row message-${role}${className ? ` ${className}` : ""}`;
	if (role === "assistant") {
		const avatar = document.createElement("span");
		avatar.className = "assistant-avatar";
		avatar.setAttribute("aria-hidden", "true");
		avatar.innerHTML = '<svg viewBox="0 0 24 24"><path d="m4 18 5-13 3 7 7-7"/><circle cx="19" cy="18" r="2"/></svg>';
		row.append(avatar);
	}
	const body = document.createElement("div");
	body.className = "message-body";
	const text = document.createElement("div");
	text.className = "message-text";
	text.textContent = content;
	body.append(text);
	row.append(body);
	return { row, body };
}

function renderConversation() {
	conversationContent.replaceChildren();
	const conversation = conversations().find((item) => item.id === selectedConversationId);
	if (!conversation) {
		conversationContent.append(createWelcome());
		return;
	}
	for (const task of conversation.turns) {
		const userMessage = createMessage("user", task.request);
		conversationContent.append(userMessage.row);
		const assistantMessage = createMessage("assistant", "");
		if (task.mode === "research") {
			const toolUse = document.createElement("div");
			toolUse.className = "tool-use";
			toolUse.innerHTML = '<span class="tool-use-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m12.5 12.5 4 4"/></svg></span><span><strong>公开网页搜索</strong><small>已作为插件调用</small></span>';
			assistantMessage.body.append(toolUse);
		}
		if (task.state === "queued" || task.state === "running") {
			const progress = document.createElement("div");
			progress.className = "assistant-progress";
			progress.setAttribute("role", "status");
			progress.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${task.mode === "research" ? "正在搜索并整理结果…" : "pi 正在思考…"}</span>`;
			assistantMessage.body.append(progress);
		} else if (task.state === "failed") {
			const error = document.createElement("div");
			error.className = "message-error";
			error.setAttribute("role", "alert");
			const errorTitle = document.createElement("strong");
			errorTitle.textContent = "这条消息没有完成";
			const errorText = document.createElement("p");
			errorText.textContent = task.failure || "服务暂时不可用，请检查设置后重试。";
			error.append(errorTitle, errorText);
			assistantMessage.body.append(error);
		} else {
			const answer = document.createElement("div");
			answer.className = "message-text assistant-answer";
			answer.textContent = task.summary || "pi 没有返回内容。";
			assistantMessage.body.append(answer);
			if (task.mode === "research") renderSources(assistantMessage.body, task.sources);
		}
		conversationContent.append(assistantMessage.row);
	}
	requestAnimationFrame(() => {
		conversationScroll.scrollTop = conversationScroll.scrollHeight;
	});
}

function createWelcome() {
	const welcome = document.createElement("div");
	welcome.className = "welcome-state";
	welcome.id = "welcome-state";
	welcome.innerHTML = '<div class="welcome-symbol" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none"><path d="M8 28 16 8l5 12 10-10" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="31" cy="28" r="4" fill="currentColor"/></svg></div><h1>今天有什么想做的？</h1><p>和 pi 对话，必要时再调用插件完成任务。</p><div class="suggestion-grid"><button type="button" class="suggestion-card" data-prompt="帮我梳理一下这周最重要的三件事，并给出一个安排建议。"><span class="suggestion-icon icon-plan" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M4 15h12M5 12l3-3 2 2 5-6M12 5h3v3"/></svg></span><span><strong>安排计划</strong><small>梳理优先级，明确下一步</small></span></button><button type="button" class="suggestion-card" data-prompt="解释一下 agent loop 是什么，并用一个简短例子说明。"><span class="suggestion-icon icon-think" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M10 3a6 6 0 0 0-3.7 10.7V17h7.4v-3.3A6 6 0 0 0 10 3Zm-2 16h4M8 8a2 2 0 1 1 3.7 1c-.8.6-1.7 1-1.7 2"/></svg></span><span><strong>解释概念</strong><small>把复杂问题讲清楚</small></span></button><button type="button" class="suggestion-card" data-prompt="搜索近期关于个人 AI agent 的重要进展，并列出来源。" data-plugin="research"><span class="suggestion-icon icon-search" aria-hidden="true"><svg viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m12.5 12.5 4 4"/></svg></span><span><strong>搜索最新信息</strong><small>按需启用公开网页搜索插件</small></span></button><button type="button" class="suggestion-card" data-prompt="帮我把下面这段话改写得更清晰、简洁一些："><span class="suggestion-icon icon-write" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="m4 14.5 9.7-9.7 2.5 2.5L6.5 17H4v-2.5ZM12.5 6l2.5 2.5M4 4h5"/></svg></span><span><strong>整理文字</strong><small>起草、改写或提炼重点</small></span></button></div>';
	return welcome;
}

function renderSources(parent, sources = []) {
	if (!sources.length) return;
	const section = document.createElement("section");
	section.className = "message-sources";
	const heading = document.createElement("h3");
	heading.textContent = `来源 · ${sources.length}`;
	const list = document.createElement("ul");
	for (const source of sources) {
		const item = document.createElement("li");
		const link = document.createElement("a");
		const safeUrl = sourceUrl(source.url);
		link.textContent = source.title || source.url;
		if (safeUrl) {
			link.href = safeUrl;
			link.target = "_blank";
			link.rel = "noopener noreferrer";
		} else {
			link.className = "source-link-invalid";
		}
		item.append(link);
		if (source.snippet) {
			const snippet = document.createElement("p");
			snippet.textContent = source.snippet;
			item.append(snippet);
		}
		list.append(item);
	}
	section.append(heading, list);
	parent.append(section);
}

function sourceUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

function setSearchEnabled(enabled) {
	searchEnabled = enabled;
	localStorage.setItem("pi.public-search-enabled", String(enabled));
	const toggle = document.querySelector("#research-toggle");
	toggle.setAttribute("aria-pressed", String(enabled));
	toggle.classList.toggle("is-enabled", enabled);
	toggle.querySelector(".plugin-chip-state").textContent = enabled ? "已启用" : "关闭";
	document.querySelector("#plugin-enable").setAttribute("aria-pressed", String(enabled));
	document.querySelector("#plugin-enable").textContent = enabled ? "已在对话中启用" : "在对话中启用";
	document.querySelector("#composer-hint").textContent = enabled ? "将使用公开网页搜索插件" : "普通对话 · 不调用搜索插件";
}

function updateCharacterCount() {
	charCount.textContent = `${requestInput.value.length} / 4000`;
	requestInput.style.height = "auto";
	requestInput.style.height = `${Math.min(requestInput.scrollHeight, 220)}px`;
	const conversationBusy = conversationsForId(selectedConversationId ?? "").some(
		(task) => task.state === "queued" || task.state === "running",
	);
	submitButton.disabled = requestInput.value.trim().length === 0 || conversationBusy;
}

function openConversation(conversationId, historyMode = "push") {
	selectedConversationId = conversationId;
	showView("chat", "restore");
	updateUrlState(historyMode);
	renderConversation();
	renderHistory();
	updateCharacterCount();
	connectConversationStream(conversationId);
}

function newConversation(historyMode = "push") {
	selectedConversationId = null;
	eventStream?.close();
	clearInterval(pollTimer);
	showView("chat", "restore");
	updateUrlState(historyMode);
	renderConversation();
	requestInput.value = "";
	updateCharacterCount();
	requestInput.focus();
}

function conversationsForId(conversationId) {
	return tasks.filter((task) => (task.conversationId || task.id) === conversationId);
}

function updateTask(updated) {
	const index = tasks.findIndex((task) => task.id === updated.id);
	if (index < 0) tasks.push(updated);
	else tasks[index] = updated;
	renderHistory();
	if ((updated.conversationId || updated.id) === selectedConversationId) {
		renderConversation();
		updateCharacterCount();
	}
}

async function readJson(response) {
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `请求失败 (${response.status})`);
	return body;
}

async function loadTasks() {
	if (listRefreshing) return;
	listRefreshing = true;
	try {
		const body = await readJson(await fetch("/api/tasks", { headers: { Accept: "application/json" } }));
		tasks = Array.isArray(body) ? body : Array.isArray(body.tasks) ? body.tasks : [];
		setConnection(true, "服务已连接");
		if (!selectedConversationId && legacyTaskId) {
			const legacyTask = tasks.find((task) => task.id === legacyTaskId);
			if (legacyTask) selectedConversationId = legacyTask.conversationId || legacyTask.id;
		}
		if (!selectedConversationId && activeView === "chat") selectedConversationId = conversations()[0]?.id ?? null;
		renderHistory();
		renderConversation();
		updateCharacterCount();
		const selected = conversationsForId(selectedConversationId ?? "").at(-1);
		if (selected && (selected.state === "queued" || selected.state === "running")) connectConversationStream(selectedConversationId);
	} catch (error) {
		setConnection(false, "服务未连接");
		taskList.replaceChildren();
		const retry = document.createElement("button");
		retry.type = "button";
		retry.className = "history-error";
		retry.textContent = error instanceof Error ? `${error.message} · 重试` : "无法加载对话 · 重试";
		retry.addEventListener("click", loadTasks);
		taskList.append(retry);
	} finally {
		listRefreshing = false;
	}
}

function connectConversationStream(conversationId) {
	eventStream?.close();
	clearInterval(pollTimer);
	const pending = conversationsForId(conversationId).filter((task) => task.state === "queued" || task.state === "running");
	if (!pending.length) return;
	if (!("EventSource" in window)) {
		pollTimer = setInterval(() => void loadTasks(), 5000);
		return;
	}
	const latest = pending.at(-1);
	eventStream = new EventSource(`/api/tasks/${encodeURIComponent(latest.id)}/events`);
	const receive = (event) => {
		try {
			const task = JSON.parse(event.data);
			if (!task?.id) return;
			updateTask(task);
			setConnection(true, "服务已连接");
			if (task.state === "succeeded" || task.state === "failed") {
				eventStream?.close();
				clearInterval(pollTimer);
				void loadTasks();
			}
		} catch {
			void loadTasks();
		}
	};
	eventStream.addEventListener("task", receive);
	eventStream.onmessage = receive;
	eventStream.onerror = () => {
		setConnection(false, "正在重新连接");
		if (!pollTimer) pollTimer = setInterval(() => void loadTasks(), 5000);
	};
	eventStream.onopen = () => {
		setConnection(true, "服务已连接");
		clearInterval(pollTimer);
		pollTimer = undefined;
	};
}

async function loadConfiguration() {
	const fields = { modelId: "#config-model-id", modelEndpoint: "#config-model-endpoint", searchEndpoint: "#config-search-endpoint" };
	try {
		const config = await readJson(await fetch("/api/config", { headers: { Accept: "application/json" } }));
		for (const [key, selector] of Object.entries(fields)) document.querySelector(selector).textContent = config[key] || "未配置";
		setCredentialStatus("#config-model-credential", config.modelCredentialConfigured);
		setCredentialStatus("#config-search-credential", config.searchCredentialConfigured);
		const ready = Boolean(config.searchEndpoint);
		document.querySelector("#plugin-ready").textContent = ready ? "服务已配置" : "等待服务配置";
		document.querySelector("#plugin-ready").classList.toggle("is-ready", ready);
	} catch (error) {
		for (const selector of Object.values(fields)) document.querySelector(selector).textContent = "暂不可用";
		for (const selector of ["#config-model-credential", "#config-search-credential"]) document.querySelector(selector).textContent = "无法读取状态";
		document.querySelector("#settings-error").textContent = error instanceof Error ? error.message : "无法读取运行配置。";
		document.querySelector("#plugin-ready").textContent = "无法检查配置";
	}
}

function setCredentialStatus(selector, configured) {
	const element = document.querySelector(selector);
	element.textContent = configured ? "已配置" : "尚未配置";
	element.classList.toggle("is-ready", configured);
	element.classList.toggle("is-missing", !configured);
}

taskForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	const request = requestInput.value.trim();
	if (!request) return requestInput.focus();
	submitButton.disabled = true;
	submitButton.classList.add("is-loading");
	submitButton.setAttribute("aria-label", "正在发送");
	formMessage.textContent = "";
	const conversationId = selectedConversationId;
	try {
		const task = await readJson(await fetch("/api/tasks", {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ request, mode: searchEnabled ? "research" : "chat", ...(conversationId ? { conversationId } : {}) }),
		}));
		if (!task?.id || !task?.conversationId) throw new Error("服务未返回有效的对话编号，请刷新对话历史后重试。");
		selectedConversationId = task.conversationId;
		updateUrlState("push");
		updateTask(task);
		requestInput.value = "";
		updateCharacterCount();
		connectConversationStream(selectedConversationId);
		formMessage.textContent = searchEnabled ? "已发送，pi 将调用公开网页搜索插件。" : "已发送给 pi。";
	} catch (error) {
		formMessage.textContent = error instanceof Error ? error.message : "发送失败，请检查服务连接后重试。";
	} finally {
		submitButton.classList.remove("is-loading");
		submitButton.setAttribute("aria-label", "发送消息");
		updateCharacterCount();
	}
});

requestInput.addEventListener("input", updateCharacterCount);
requestInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		if (requestInput.value.trim()) taskForm.requestSubmit();
	}
});
document.querySelector("#new-chat").addEventListener("click", () => newConversation());
document.querySelector("#refresh-tasks").addEventListener("click", loadTasks);
document.querySelector("#open-settings").addEventListener("click", () => {
	showView("settings");
	void loadConfiguration();
});
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
	showView(button.dataset.view);
	if (button.dataset.view === "settings" || button.dataset.view === "plugins") void loadConfiguration();
}));
conversationContent.addEventListener("click", (event) => {
	const button = event.target.closest("[data-prompt]");
	if (!button) return;
	if (button.dataset.plugin === "research") setSearchEnabled(true);
	requestInput.value = button.dataset.prompt;
	updateCharacterCount();
	requestInput.focus();
});
document.querySelector("#research-toggle").addEventListener("click", () => setSearchEnabled(!searchEnabled));
document.querySelector("#plugin-enable").addEventListener("click", () => setSearchEnabled(!searchEnabled));
document.querySelector("#plugin-picker").addEventListener("click", () => {
	const menu = document.querySelector("#plugin-menu");
	menu.hidden = !menu.hidden;
	document.querySelector("#plugin-picker").setAttribute("aria-expanded", String(!menu.hidden));
});
document.querySelector("#plugin-menu-search").addEventListener("click", () => {
	setSearchEnabled(!searchEnabled);
	document.querySelector("#plugin-menu").hidden = true;
	document.querySelector("#plugin-picker").setAttribute("aria-expanded", "false");
});
document.querySelector("#mobile-menu").addEventListener("click", () => {
	document.querySelector(".sidebar").classList.add("is-open");
	document.querySelector("#sidebar-scrim").hidden = false;
});
document.querySelector("#sidebar-scrim").addEventListener("click", () => {
	document.querySelector(".sidebar").classList.remove("is-open");
	document.querySelector("#sidebar-scrim").hidden = true;
});
document.addEventListener("click", (event) => {
	if (!event.target.closest(".composer-tools") && !document.querySelector("#plugin-menu").hidden) {
		document.querySelector("#plugin-menu").hidden = true;
		document.querySelector("#plugin-picker").setAttribute("aria-expanded", "false");
	}
});
window.addEventListener("popstate", () => {
	const query = new URLSearchParams(location.search);
	activeView = query.get("view") === "settings" || query.get("view") === "plugins" ? query.get("view") : "chat";
	selectedConversationId = query.get("conversation");
	showView(activeView, "restore");
	if (activeView === "settings" || activeView === "plugins") void loadConfiguration();
	if (selectedConversationId) {
		renderConversation();
		renderHistory();
		connectConversationStream(selectedConversationId);
	} else {
		eventStream?.close();
		clearInterval(pollTimer);
		renderConversation();
	}
});
window.addEventListener("beforeunload", () => eventStream?.close());
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") void loadTasks();
});
window.addEventListener("keydown", (event) => {
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
		event.preventDefault();
		newConversation();
	}
	if (event.key === "Escape" && !document.querySelector("#plugin-menu").hidden) {
		document.querySelector("#plugin-menu").hidden = true;
		document.querySelector("#plugin-picker").setAttribute("aria-expanded", "false");
	}
});

setSearchEnabled(searchEnabled);
updateCharacterCount();
updateUrlState("replace");
showView(activeView, "restore");
void loadTasks();
if (activeView === "settings" || activeView === "plugins") void loadConfiguration();
