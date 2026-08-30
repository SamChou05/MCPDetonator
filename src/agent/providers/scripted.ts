import {
  AgentProviderError,
  type AgentProvider,
  type ProviderCompletion,
  type ProviderCompletionRequest,
  type ProviderJsonObject,
  type ProviderToolCall,
} from "./provider.js";

function cloneJsonObject(value: ProviderJsonObject): ProviderJsonObject {
  return structuredClone(value);
}

function cloneToolCall(toolCall: ProviderToolCall): ProviderToolCall {
  return {
    id: toolCall.id,
    name: toolCall.name,
    arguments: cloneJsonObject(toolCall.arguments),
  };
}

function cloneCompletion(completion: ProviderCompletion): ProviderCompletion {
  return {
    returnedModel: completion.returnedModel,
    content: completion.content,
    toolCalls: completion.toolCalls.map(cloneToolCall),
    finishReason: completion.finishReason,
    ...(completion.usage === undefined
      ? {}
      : {
          usage: {
            promptTokens: completion.usage.promptTokens,
            completionTokens: completion.usage.completionTokens,
            totalTokens: completion.usage.totalTokens,
          },
        }),
  };
}

/**
 * A deterministic provider for unit tests and offline rollouts.
 *
 * Each completion is consumed exactly once and returned as a defensive clone.
 * The provider never interprets the prompt or tool metadata.
 */
export class ScriptedAgentProvider implements AgentProvider {
  public readonly name = "scripted";
  private nextCompletion = 0;
  private readonly observedRequests: ProviderCompletionRequest[] = [];

  public constructor(private readonly completions: readonly ProviderCompletion[]) {}

  public get requests(): readonly ProviderCompletionRequest[] {
    return this.observedRequests;
  }

  public get remaining(): number {
    return this.completions.length - this.nextCompletion;
  }

  public async complete(
    request: ProviderCompletionRequest,
  ): Promise<ProviderCompletion> {
    if (request.signal?.aborted === true) {
      throw new AgentProviderError(
        "ABORTED",
        "Scripted provider request was aborted",
      );
    }

    this.observedRequests.push(request);
    const completion = this.completions[this.nextCompletion];
    if (completion === undefined) {
      throw new AgentProviderError(
        "SCRIPT_EXHAUSTED",
        `Scripted provider exhausted after ${this.nextCompletion} responses`,
      );
    }

    this.nextCompletion += 1;
    return cloneCompletion(completion);
  }
}
