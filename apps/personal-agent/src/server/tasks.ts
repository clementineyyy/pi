// Task state, persistence injection, and the execution lifecycle for public research.

import { randomUUID } from "node:crypto";
import type { ResearchTask, TaskMode, TaskSource } from "../shared/contracts.ts";

export type ConversationTurn = {
	readonly request: string;
	readonly response: string;
};

export interface TaskRepository {
	create(task: ResearchTask): Promise<void>;
	get(id: string): Promise<ResearchTask | undefined>;
	list(): Promise<readonly ResearchTask[]>;
	update(task: ResearchTask): Promise<void>;
}

export interface ResearchRunner {
	run(
		request: string,
		mode: TaskMode,
		history: readonly ConversationTurn[],
		onSources: (sources: readonly TaskSource[]) => Promise<void>,
	): Promise<{ summary: string }>;
}

/** Non-durable task repository for local development only. */
export class InMemoryTaskRepository implements TaskRepository {
	private readonly tasks = new Map<string, ResearchTask>();

	async create(task: ResearchTask): Promise<void> {
		this.tasks.set(task.id, task);
	}

	async get(id: string): Promise<ResearchTask | undefined> {
		return this.tasks.get(id);
	}

	async list(): Promise<readonly ResearchTask[]> {
		return [...this.tasks.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	async update(task: ResearchTask): Promise<void> {
		this.tasks.set(task.id, task);
	}
}

type TaskListener = (task: ResearchTask) => void;

/** Accepts public research tasks and saves each state transition through the supplied repository. */
export class TaskService {
	private readonly listeners = new Map<string, Set<TaskListener>>();
	private readonly repository: TaskRepository;
	private readonly runner: ResearchRunner;
	private readonly onBackgroundError: (error: unknown) => void;

	constructor(
		repository: TaskRepository,
		runner: ResearchRunner,
		onBackgroundError: (error: unknown) => void = (error) => console.error("Personal agent task persistence failed:", error),
	) {
		this.repository = repository;
		this.runner = runner;
		this.onBackgroundError = onBackgroundError;
	}

	async create(request: string, mode: TaskMode, requestedConversationId?: string): Promise<ResearchTask> {
		const text = request.trim();
		if (text.length === 0) throw new Error("Enter a research question.");
		if (text.length > 5_000) throw new Error("Research questions must be 5,000 characters or fewer.");
		const conversationId = requestedConversationId ?? randomUUID();
		const existingTurns = (await this.repository.list())
			.filter((item) => item.conversationId === conversationId && item.state === "succeeded")
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
			.slice(-8)
			.map((item) => ({ request: item.request, response: item.summary ?? "" }));
		const now = new Date().toISOString();
		const task: ResearchTask = {
			id: randomUUID(),
			conversationId,
			mode,
			request: text,
			state: "queued",
			createdAt: now,
			updatedAt: now,
			sources: [],
		};
		await this.repository.create(task);
		queueMicrotask(() => void this.execute(task, existingTurns).catch(this.onBackgroundError));
		return task;
	}

	get(id: string): Promise<ResearchTask | undefined> {
		return this.repository.get(id);
	}

	list(): Promise<readonly ResearchTask[]> {
		return this.repository.list();
	}

	subscribe(id: string, listener: TaskListener): () => void {
		const taskListeners = this.listeners.get(id) ?? new Set<TaskListener>();
		this.listeners.set(id, taskListeners);
		taskListeners.add(listener);
		return () => {
			taskListeners.delete(listener);
			if (taskListeners.size === 0) this.listeners.delete(id);
		};
	}

	private async execute(accepted: ResearchTask, history: readonly ConversationTurn[]): Promise<void> {
		let task = await this.transition(accepted, { state: "running" });
		try {
			const result = await this.runner.run(accepted.request, accepted.mode, history, async (sources) => {
				task = { ...task, sources: uniqueSources([...task.sources, ...sources]), updatedAt: new Date().toISOString() };
				await this.save(task);
			});
			task = await this.transition(task, { state: "succeeded", summary: result.summary });
		} catch (error) {
			const failure = error instanceof Error ? error.message : String(error);
			task = await this.transition(task, { state: "failed", failure: failure.slice(0, 1_000) });
		}
	}

	private async transition(
		current: ResearchTask,
		change: Partial<Pick<ResearchTask, "state" | "summary" | "failure">>,
	): Promise<ResearchTask> {
		const task = { ...current, ...change, updatedAt: new Date().toISOString() };
		await this.save(task);
		return task;
	}

	private async save(task: ResearchTask): Promise<void> {
		await this.repository.update(task);
		for (const listener of this.listeners.get(task.id) ?? []) listener(task);
	}
}

function uniqueSources(sources: readonly TaskSource[]): readonly TaskSource[] {
	const byUrl = new Map<string, TaskSource>();
	for (const source of sources) if (!byUrl.has(source.url)) byUrl.set(source.url, source);
	return [...byUrl.values()].slice(0, 20);
}
