import { TextDecoder } from "node:util";

import {
  AgentProviderError,
  type AgentProvider,
  type ProviderCompletion,
  type ProviderCompletionRequest,
  type ProviderJsonObject,
  type ProviderJsonValue,
  type ProviderMessage,
  type ProviderTokenUsage,
  type ProviderToolCall,
  type ProviderToolDefinition,
} from "./provider.js";
import {
  assertNoProviderCredentialInValue,
  ProviderCredentialIsolationError,
} from "../redaction.js";

export const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_CONFIGURED_RESPONSE_BYTES = 10_000_000;
const MAX_MODEL_IDENTIFIER_CHARACTERS = 512;
const MAX_TOOL_CALL_IDENTIFIER_CHARACTERS = 512;
const MAX_TOOL_NAME_CHARACTERS = 512;
const MAX_FINISH_REASON_CHARACTERS = 128;
const MAX_JSON_DEPTH = 64;

export type OpenRouterFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenRouterProviderOptions {
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Test seam; production callers should use the global fetch implementation. */
  readonly fetchImpl?: OpenRouterFetch;
}

interface OpenRouterFunctionTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: ProviderJsonObject;
  };
}

type OpenRouterMessage =
  | {
      readonly role: "system" | "user";
      readonly content: string;
    }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls?: readonly {
        readonly id: string;
        readonly type: "function";
        readonly function: {
          readonly name: string;
          readonly arguments: string;
        };
      }[];
    }
  | {
      readonly role: "tool";
      readonly tool_call_id: string;
      readonly content: string;
    };

interface OpenRouterRequestBody {
  readonly model: string;
  readonly messages: readonly OpenRouterMessage[];
  readonly tools: readonly OpenRouterFunctionTool[];
  readonly tool_choice: "auto" | "none";
  readonly parallel_tool_calls: false;
  readonly stream: false;
  readonly temperature?: number;
  readonly max_tokens?: number;
}

function invalidConfiguration(message: string): never {
  throw new AgentProviderError("INVALID_CONFIGURATION", message);
}

function invalidRequest(message: string): never {
  throw new AgentProviderError("INVALID_REQUEST", message);
}

function malformedResponse(message: string): never {
  throw new AgentProviderError(
    "MALFORMED_RESPONSE",
    `OpenRouter returned malformed response: ${message}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function assertJsonValue(
  value: unknown,
  location: string,
  depth = 0,
  fail: (message: string) => never = invalidRequest,
): asserts value is ProviderJsonValue {
  if (depth > MAX_JSON_DEPTH) {
    fail(`${location} exceeds the maximum JSON depth`);
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(`${location} contains a non-finite number`);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertJsonValue(entry, `${location}[${index}]`, depth + 1, fail),
    );
    return;
  }

  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertJsonValue(entry, `${location}.${key}`, depth + 1, fail);
    }
    return;
  }

  fail(`${location} must contain only JSON values`);
}

function assertJsonObject(
  value: unknown,
  location: string,
): asserts value is ProviderJsonObject {
  if (!isRecord(value)) {
    invalidRequest(`${location} must be a JSON object`);
  }
  assertJsonValue(value, location);
}

function assertBoundedString(
  value: unknown,
  location: string,
  maximumCharacters: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumCharacters
  ) {
    malformedResponse(
      `${location} must be a non-empty string of at most ${maximumCharacters} characters`,
    );
  }
}

function assertTokenCount(value: unknown, location: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    malformedResponse(`${location} must be a non-negative safe integer`);
  }
}

function validatePositiveInteger(
  value: number,
  location: string,
  maximum: number,
  configuration: boolean,
): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    const message = `${location} must be an integer between 1 and ${maximum}`;
    if (configuration) {
      invalidConfiguration(message);
    }
    invalidRequest(message);
  }
}

function serializeToolCall(toolCall: ProviderToolCall): {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
} {
  if (
    toolCall.id.length === 0 ||
    toolCall.id.length > MAX_TOOL_CALL_IDENTIFIER_CHARACTERS
  ) {
    invalidRequest(
      `assistant tool call id must be between 1 and ${MAX_TOOL_CALL_IDENTIFIER_CHARACTERS} characters`,
    );
  }
  if (
    toolCall.name.length === 0 ||
    toolCall.name.length > MAX_TOOL_NAME_CHARACTERS
  ) {
    invalidRequest(
      `assistant tool call name must be between 1 and ${MAX_TOOL_NAME_CHARACTERS} characters`,
    );
  }
  assertJsonObject(toolCall.arguments, "assistant tool call arguments");
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.arguments),
    },
  };
}

function serializeMessage(message: ProviderMessage): OpenRouterMessage {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant": {
      const toolCalls = message.toolCalls?.map(serializeToolCall);
      return {
        role: "assistant",
        content: message.content,
        ...(toolCalls === undefined || toolCalls.length === 0
          ? {}
          : { tool_calls: toolCalls }),
      };
    }
    case "tool":
      if (message.toolCallId.length === 0) {
        invalidRequest("tool message toolCallId must not be empty");
      }
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
  }
}

function serializeTool(tool: ProviderToolDefinition): OpenRouterFunctionTool {
  if (tool.name.length === 0) {
    invalidRequest("tool name must not be empty");
  }
  if (tool.name.length > MAX_TOOL_NAME_CHARACTERS) {
    invalidRequest(
      `tool name must be at most ${MAX_TOOL_NAME_CHARACTERS} characters`,
    );
  }
  if (tool.description !== undefined && typeof tool.description !== "string") {
    invalidRequest("tool description must be a string when present");
  }
  assertJsonObject(tool.inputSchema, `input schema for tool '${tool.name}'`);
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description === undefined
        ? {}
        : { description: tool.description }),
      parameters: tool.inputSchema,
    },
  };
}

function buildRequestBody(request: ProviderCompletionRequest): OpenRouterRequestBody {
  if (
    typeof request.model !== "string" ||
    request.model.length === 0 ||
    request.model.length > MAX_MODEL_IDENTIFIER_CHARACTERS
  ) {
    invalidRequest(
      `model must be a non-empty string of at most ${MAX_MODEL_IDENTIFIER_CHARACTERS} characters`,
    );
  }
  if (request.messages.length === 0) {
    invalidRequest("messages must contain at least one message");
  }
  if (
    request.temperature !== undefined &&
    (!Number.isFinite(request.temperature) ||
      request.temperature < 0 ||
      request.temperature > 2)
  ) {
    invalidRequest("temperature must be between 0 and 2");
  }
  if (request.maxTokens !== undefined) {
    validatePositiveInteger(
      request.maxTokens,
      "maxTokens",
      Number.MAX_SAFE_INTEGER,
      false,
    );
  }

  const toolNames = new Set<string>();
  for (const tool of request.tools) {
    if (toolNames.has(tool.name)) {
      invalidRequest(`tool name '${tool.name}' must be unique`);
    }
    toolNames.add(tool.name);
  }
  for (const message of request.messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const toolCall of message.toolCalls ?? []) {
      if (!toolNames.has(toolCall.name)) {
        invalidRequest(
          `assistant history references undefined tool '${toolCall.name}'`,
        );
      }
    }
  }

  const tools = request.tools.map(serializeTool);
  return {
    model: request.model,
    messages: request.messages.map(serializeMessage),
    tools,
    tool_choice: tools.length === 0 ? "none" : "auto",
    parallel_tool_calls: false,
    stream: false,
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    ...(request.maxTokens === undefined
      ? {}
      : { max_tokens: request.maxTokens }),
  };
}

async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
    const bytes = Number(declaredLength);
    if (Number.isSafeInteger(bytes) && bytes > maximumBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw new AgentProviderError(
        "RESPONSE_TOO_LARGE",
        `OpenRouter response exceeded ${maximumBytes} bytes`,
      );
    }
  }

  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      try {
        await reader.cancel();
      } catch {
        // The size violation is the stable error surfaced to the caller.
      }
      throw new AgentProviderError(
        "RESPONSE_TOO_LARGE",
        `OpenRouter response exceeded ${maximumBytes} bytes`,
      );
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    malformedResponse("response body is not valid UTF-8");
  }
}

function parseToolCalls(
  rawToolCalls: unknown,
  allowedToolNames: ReadonlySet<string>,
): readonly ProviderToolCall[] {
  if (rawToolCalls === undefined) {
    return [];
  }
  if (!Array.isArray(rawToolCalls)) {
    malformedResponse("choices[0].message.tool_calls must be an array");
  }
  if (rawToolCalls.length > 1) {
    malformedResponse(
      "choices[0].message.tool_calls must contain at most one call when parallel tool calls are disabled",
    );
  }

  return rawToolCalls.map((rawToolCall, index) => {
    const location = `choices[0].message.tool_calls[${index}]`;
    if (!isRecord(rawToolCall)) {
      malformedResponse(`${location} must be an object`);
    }
    assertBoundedString(
      rawToolCall.id,
      `${location}.id`,
      MAX_TOOL_CALL_IDENTIFIER_CHARACTERS,
    );
    if (rawToolCall.type !== "function") {
      malformedResponse(`${location}.type must be 'function'`);
    }
    if (!isRecord(rawToolCall.function)) {
      malformedResponse(`${location}.function must be an object`);
    }
    assertBoundedString(
      rawToolCall.function.name,
      `${location}.function.name`,
      MAX_TOOL_NAME_CHARACTERS,
    );
    if (!allowedToolNames.has(rawToolCall.function.name)) {
      malformedResponse(
        `${location}.function.name is not a caller-defined tool`,
      );
    }
    if (typeof rawToolCall.function.arguments !== "string") {
      malformedResponse(`${location}.function.arguments must be a JSON string`);
    }

    let parsedArguments: unknown;
    try {
      parsedArguments = JSON.parse(rawToolCall.function.arguments);
    } catch {
      malformedResponse(`${location}.function.arguments is not valid JSON`);
    }
    if (!isRecord(parsedArguments)) {
      malformedResponse(`${location}.function.arguments must decode to an object`);
    }
    assertJsonValue(
      parsedArguments,
      `${location}.function.arguments`,
      0,
      (message): never => malformedResponse(message),
    );

    return {
      id: rawToolCall.id,
      name: rawToolCall.function.name,
      arguments: parsedArguments,
    };
  });
}

function parseUsage(rawUsage: unknown): ProviderTokenUsage | undefined {
  if (rawUsage === undefined) {
    return undefined;
  }
  if (!isRecord(rawUsage)) {
    malformedResponse("usage must be an object when present");
  }
  assertTokenCount(rawUsage.prompt_tokens, "usage.prompt_tokens");
  assertTokenCount(rawUsage.completion_tokens, "usage.completion_tokens");
  assertTokenCount(rawUsage.total_tokens, "usage.total_tokens");
  return {
    promptTokens: rawUsage.prompt_tokens,
    completionTokens: rawUsage.completion_tokens,
    totalTokens: rawUsage.total_tokens,
  };
}

function parseCompletion(
  body: string,
  allowedToolNames: ReadonlySet<string>,
): ProviderCompletion {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    malformedResponse("response body is not valid JSON");
  }
  if (!isRecord(document)) {
    malformedResponse("response body must be an object");
  }
  assertBoundedString(
    document.model,
    "model",
    MAX_MODEL_IDENTIFIER_CHARACTERS,
  );
  if (!Array.isArray(document.choices) || document.choices.length !== 1) {
    malformedResponse("choices must contain exactly one completion");
  }

  const choice = document.choices[0];
  if (!isRecord(choice)) {
    malformedResponse("choices[0] must be an object");
  }
  if (!isRecord(choice.message)) {
    malformedResponse("choices[0].message must be an object");
  }
  if (choice.message.role !== "assistant") {
    malformedResponse("choices[0].message.role must be 'assistant'");
  }
  if ("function_call" in choice.message) {
    malformedResponse("legacy function_call responses are not supported");
  }
  if (
    choice.message.content !== null &&
    typeof choice.message.content !== "string"
  ) {
    malformedResponse("choices[0].message.content must be a string or null");
  }
  if (
    choice.finish_reason !== null &&
    (typeof choice.finish_reason !== "string" ||
      choice.finish_reason.length > MAX_FINISH_REASON_CHARACTERS)
  ) {
    malformedResponse(
      `choices[0].finish_reason must be null or a string of at most ${MAX_FINISH_REASON_CHARACTERS} characters`,
    );
  }

  const toolCalls = parseToolCalls(choice.message.tool_calls, allowedToolNames);
  if (toolCalls.length > 0 && choice.finish_reason !== "tool_calls") {
    malformedResponse(
      "choices[0].finish_reason must be 'tool_calls' when a tool call is present",
    );
  }
  if (toolCalls.length === 0 && choice.finish_reason === "tool_calls") {
    malformedResponse(
      "choices[0].message.tool_calls is required when finish_reason is 'tool_calls'",
    );
  }

  const usage = parseUsage(document.usage);
  return {
    returnedModel: document.model,
    content: choice.message.content,
    toolCalls,
    finishReason: choice.finish_reason,
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * Non-streaming OpenRouter chat-completions adapter for proposal-only rollouts.
 *
 * The public request type has no provider plugin, server-tool, routing, or
 * auto-execution fields. Every accepted tool call must name one of the
 * caller-supplied function definitions and contain a strict JSON object.
 */
export class OpenRouterAgentProvider implements AgentProvider {
  public readonly name = "openrouter";
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: OpenRouterFetch;

  public constructor(options: OpenRouterProviderOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.length === 0) {
      invalidConfiguration("OpenRouter API key must be a non-empty string");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    validatePositiveInteger(
      timeoutMs,
      "OpenRouter timeoutMs",
      MAX_TIMEOUT_MS,
      true,
    );
    const maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    validatePositiveInteger(
      maxResponseBytes,
      "OpenRouter maxResponseBytes",
      MAX_CONFIGURED_RESPONSE_BYTES,
      true,
    );

    this.apiKey = options.apiKey;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async complete(
    request: ProviderCompletionRequest,
  ): Promise<ProviderCompletion> {
    const requestBody = buildRequestBody(request);
    const requestJson = JSON.stringify(requestBody);
    if (requestJson.includes(this.apiKey)) {
      throw new AgentProviderError(
        "INVALID_REQUEST",
        "OpenRouter API key must not appear in the request payload",
      );
    }

    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    validatePositiveInteger(
      timeoutMs,
      "request timeoutMs",
      MAX_TIMEOUT_MS,
      false,
    );

    if (request.signal?.aborted === true) {
      throw new AgentProviderError("ABORTED", "OpenRouter request was aborted");
    }

    const controller = new AbortController();
    let timedOut = false;
    let abortedByCaller = false;
    const forwardAbort = () => {
      abortedByCaller = true;
      controller.abort();
    };
    request.signal?.addEventListener("abort", forwardAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await this.fetchImpl(OPENROUTER_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: requestJson,
        signal: controller.signal,
      });
      const responseBody = await readBoundedResponseBody(
        response,
        this.maxResponseBytes,
      );

      if (!response.ok) {
        throw new AgentProviderError(
          "HTTP_ERROR",
          `OpenRouter returned HTTP ${response.status}`,
        );
      }
      if (responseBody.includes(this.apiKey)) {
        throw new AgentProviderError(
          "MALFORMED_RESPONSE",
          "OpenRouter response contained the controller credential",
        );
      }

      const completion = parseCompletion(
        responseBody,
        new Set(request.tools.map((tool) => tool.name)),
      );
      assertNoProviderCredentialInValue(
        completion,
        [this.apiKey],
        "provider credential isolation check failed: OpenRouter parsed a response containing the controller credential",
      );
      return completion;
    } catch (error) {
      if (
        error instanceof AgentProviderError ||
        error instanceof ProviderCredentialIsolationError
      ) {
        throw error;
      }
      if (timedOut) {
        throw new AgentProviderError(
          "TIMEOUT",
          `OpenRouter request timed out after ${timeoutMs}ms`,
        );
      }
      if (abortedByCaller) {
        throw new AgentProviderError("ABORTED", "OpenRouter request was aborted");
      }
      throw new AgentProviderError(
        "NETWORK_ERROR",
        "OpenRouter request failed",
      );
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", forwardAbort);
    }
  }
}
