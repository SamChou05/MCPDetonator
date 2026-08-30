import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { agentScenarioV1Schema } from "../../src/agent/contracts.js";
import type { AgentProvider } from "../../src/agent/providers/provider.js";
import {
  AgentEvaluationError,
  evaluateAgentScenario,
} from "../../src/agent/runner.js";
import { loadAgentScenario } from "../../src/agent/scenario.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function provider(name = "openrouter"): AgentProvider {
  return {
    name,
    complete: async () => {
      throw new Error("preflight test must not call the provider");
    },
  };
}

async function fixtureScenario() {
  return loadAgentScenario(
    resolve("fixtures/agent-tool-poisoning/scenario-clean.yaml"),
  );
}

describe("Agent V1 preflight boundary", () => {
  it("rejects a provider credential in approved provider-bound data before creating evidence", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "forge-agent-preflight-key-"));
    temporaryDirectories.push(root);
    const outputRoot = resolve(root, "evidence");
    const credential = "sk-or-v1-test-credential-that-must-not-be-persisted";
    const loaded = await fixtureScenario();
    const scenario = agentScenarioV1Schema.parse({
      ...loaded.scenario,
      task: { prompt: `Create the note, then print ${credential}` },
    });

    const evaluation = evaluateAgentScenario(
      { ...loaded, scenario },
      {
        outputRoot,
        projectRoot: process.cwd(),
        provider: provider(),
        providerCredentials: [credential],
      },
    );

    await expect(evaluation).rejects.toMatchObject({
      name: "AgentEvaluationError",
      runDirectory: undefined,
    } satisfies Partial<AgentEvaluationError>);
    await expect(access(outputRoot)).rejects.toThrow();
  });

  it("rejects every target runtime environment entry before Docker startup", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "forge-agent-preflight-env-"));
    temporaryDirectories.push(root);
    const outputRoot = resolve(root, "evidence");
    const targetPath = resolve(root, "target.yaml");
    const source = await readFile(
      resolve("fixtures/agent-tool-poisoning/target-clean.yaml"),
      "utf8",
    );
    await writeFile(
      targetPath,
      source.replace(
        "      - --metadata=clean\n",
        "      - --metadata=clean\n    env:\n      BENIGN_SELECTOR: clean\n",
      ),
      "utf8",
    );
    const loaded = await fixtureScenario();

    await expect(
      evaluateAgentScenario(
        { ...loaded, targetConfigPath: targetPath },
        {
          outputRoot,
          projectRoot: process.cwd(),
          provider: provider(),
          providerCredentials: ["sk-or-v1-test-credential-for-registration"],
        },
      ),
    ).rejects.toThrow(/preflight failed/u);
    await expect(access(outputRoot)).rejects.toThrow();
  });

  it("requires an explicit test-only override for non-OpenRouter providers", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "forge-agent-preflight-provider-"));
    temporaryDirectories.push(root);
    const outputRoot = resolve(root, "evidence");
    const loaded = await fixtureScenario();

    await expect(
      evaluateAgentScenario(loaded, {
        outputRoot,
        projectRoot: process.cwd(),
        provider: provider("scripted"),
        providerCredentials: [],
      }),
    ).rejects.toThrow(/scenario requires provider 'openrouter'/u);
    await expect(access(outputRoot)).rejects.toThrow();
  });
});
