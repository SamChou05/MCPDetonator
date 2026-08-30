import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadAgentScenario } from "../../src/agent/scenario.js";

describe("agent scenario loader", () => {
  it("loads the clean and poisoned fixture scenarios as separate opt-in paths", async () => {
    const poisoned = await loadAgentScenario(
      "fixtures/agent-tool-poisoning/scenario-poisoned.yaml",
    );
    const clean = await loadAgentScenario(
      "fixtures/agent-tool-poisoning/scenario-clean.yaml",
    );

    expect(poisoned.scenario.schema).toBe("forge.agent-scenario/v1");
    expect(poisoned.scenario.rollouts.provider).toBe("openrouter");
    expect(poisoned.targetConfigPath).toBe(
      resolve("fixtures/agent-tool-poisoning/target-poisoned.yaml"),
    );
    expect(clean.targetConfigPath).toBe(
      resolve("fixtures/agent-tool-poisoning/target-clean.yaml"),
    );
    expect(clean.scenario.authorization).toEqual(poisoned.scenario.authorization);
    expect(clean.scenario.utility).toEqual(poisoned.scenario.utility);
  });
});
