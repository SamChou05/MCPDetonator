import { describe, expect, it } from "vitest";

import type { ProviderCompletionRequest } from "../../src/agent/providers/provider.js";
import { ProviderCredentialIsolationError } from "../../src/agent/redaction.js";
import {
  providerReturnedMultipleModelIds,
  withholdControlledToolFailure,
  withholdTargetMcpResult,
  withProviderCredentialIsolation,
} from "../../src/agent/runner.js";

const request: ProviderCompletionRequest = {
  model: "test/model",
  messages: [{ role: "user", content: "Write the note." }],
  tools: [],
};

describe("Agent V1 target-result boundary", () => {
  it("records spec-compliant MCP error results as local failures behind the same provider marker", () => {
    const success = withholdTargetMcpResult({
      content: [{ type: "text", text: "success detail" }],
    });
    const failure = withholdTargetMcpResult({
      isError: true,
      content: [{ type: "text", text: "target-authored secret error" }],
    });

    expect(success.content).toBe(failure.content);
    expect("localFailure" in success).toBe(false);
    expect(failure).toMatchObject({
      localFailure:
        "Target MCP returned an error result; full error content remains in the local MCP transcript.",
    });
    expect(JSON.stringify(failure)).not.toContain("target-authored secret error");
  });
});

describe("Agent V1 controller-diagnostic boundary", () => {
  it("keeps host paths in local failure evidence and out of provider content", () => {
    const hostDiagnostic =
      "Command failed: docker run --mount src=/Users/example/private-project";
    const failure = withholdControlledToolFailure(new Error(hostDiagnostic));

    expect(failure.content).not.toContain("/Users/example");
    expect(failure).toMatchObject({ localFailure: hostDiagnostic });
  });

  it("reports model drift only for distinct returned identifiers", () => {
    expect(
      providerReturnedMultipleModelIds(["deepseek/model", "deepseek/model"]),
    ).toBe(false);
    expect(
      providerReturnedMultipleModelIds(["deepseek/model", "fallback/model"]),
    ).toBe(true);
  });
});

describe("Agent V1 provider-credential boundary", () => {
  it("rejects a parsed completion before returning credential-bearing tool arguments", async () => {
    const credential = "sk-provider-credential-must-not-dispatch";
    const provider = withProviderCredentialIsolation(
      {
        name: "test-provider",
        complete: async () => ({
          returnedModel: "test/model",
          content: null,
          toolCalls: [
            {
              id: "call-credential",
              name: "write_file",
              arguments: { content: credential },
            },
          ],
          finishReason: "tool_calls",
        }),
      },
      [credential],
    );

    await expect(provider.complete(request)).rejects.toThrow(
      ProviderCredentialIsolationError,
    );
  });

  it("rejects credential-bearing provider diagnostics before the loop can persist them", async () => {
    const credential = "sk-provider-error-must-not-persist";
    const provider = withProviderCredentialIsolation(
      {
        name: "test-provider",
        complete: async () => {
          throw new Error(`upstream echoed ${credential}`);
        },
      },
      [credential],
    );

    await expect(provider.complete(request)).rejects.toThrow(
      ProviderCredentialIsolationError,
    );
  });
});
