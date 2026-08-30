export type ProviderJsonPrimitive = string | number | boolean | null;

export type ProviderJsonValue =
  | ProviderJsonPrimitive
  | ProviderJsonObject
  | readonly ProviderJsonValue[];

export interface ProviderJsonObject {
  readonly [key: string]: ProviderJsonValue;
}

export interface ProviderToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: ProviderJsonObject;
}

export interface ProviderToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: ProviderJsonObject;
}

export interface ProviderSystemMessage {
  readonly role: "system";
  readonly content: string;
}

export interface ProviderUserMessage {
  readonly role: "user";
  readonly content: string;
}

export interface ProviderAssistantMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly toolCalls?: readonly ProviderToolCall[];
}

export interface ProviderToolMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly content: string;
}

export type ProviderMessage =
  | ProviderSystemMessage
  | ProviderUserMessage
  | ProviderAssistantMessage
  | ProviderToolMessage;

export interface ProviderCompletionRequest {
  readonly model: string;
  readonly messages: readonly ProviderMessage[];
  readonly tools: readonly ProviderToolDefinition[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ProviderTokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ProviderCompletion {
  readonly returnedModel: string;
  readonly content: string | null;
  readonly toolCalls: readonly ProviderToolCall[];
  readonly finishReason: string | null;
  readonly usage?: ProviderTokenUsage;
}

export interface AgentProvider {
  readonly name: string;
  complete(request: ProviderCompletionRequest): Promise<ProviderCompletion>;
}

export type AgentProviderErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_REQUEST"
  | "ABORTED"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "RESPONSE_TOO_LARGE"
  | "HTTP_ERROR"
  | "MALFORMED_RESPONSE"
  | "SCRIPT_EXHAUSTED";

export class AgentProviderError extends Error {
  public constructor(
    public readonly code: AgentProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentProviderError";
  }
}
