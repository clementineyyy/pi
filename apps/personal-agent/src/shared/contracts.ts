// The browser and server contract for public web research tasks.

export type TaskState = "queued" | "running" | "succeeded" | "failed";
export type TaskMode = "chat" | "research";

export type TaskSource = {
	readonly title: string;
	readonly url: string;
	readonly snippet: string;
};

export type ResearchTask = {
	readonly id: string;
	readonly conversationId: string;
	readonly mode: TaskMode;
	readonly request: string;
	readonly state: TaskState;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly summary?: string;
	readonly sources: readonly TaskSource[];
	readonly failure?: string;
};

export type RuntimeConfiguration = {
	readonly modelEndpoint: string;
	readonly modelId: string;
	readonly modelCredentialConfigured: boolean;
	readonly searchEndpoint: string;
	readonly searchCredentialConfigured: boolean;
};

export type CreateTaskRequest = {
	readonly request: string;
	readonly mode?: TaskMode;
	readonly conversationId?: string;
};

export type ApiError = {
	readonly error: string;
};
