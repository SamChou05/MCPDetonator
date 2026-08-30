import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import {
  agentScenarioV1Schema,
  type AgentScenarioV1,
} from "./contracts.js";

export interface LoadedAgentScenario {
  readonly scenario: AgentScenarioV1;
  readonly scenarioPath: string;
  readonly scenarioDirectory: string;
  readonly targetConfigPath: string;
}

export class AgentScenarioError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentScenarioError";
  }
}

function formatValidationError(error: import("zod").ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "scenario";
      return `${location}: ${issue.message}`;
    })
    .join("\n");
}

export async function loadAgentScenario(
  scenarioPath: string,
): Promise<LoadedAgentScenario> {
  const absoluteScenarioPath = resolve(scenarioPath);
  let source: string;
  try {
    source = await readFile(absoluteScenarioPath, "utf8");
  } catch (error) {
    throw new AgentScenarioError(
      `cannot read agent scenario: ${absoluteScenarioPath}`,
      { cause: error },
    );
  }

  let document: unknown;
  try {
    document = parseYaml(source, { maxAliasCount: 20, uniqueKeys: true });
  } catch (error) {
    throw new AgentScenarioError(
      `agent scenario is not valid YAML: ${absoluteScenarioPath}`,
      { cause: error },
    );
  }

  const result = agentScenarioV1Schema.safeParse(document);
  if (!result.success) {
    throw new AgentScenarioError(
      `agent scenario failed validation:\n${formatValidationError(result.error)}`,
    );
  }

  const scenarioDirectory = resolve(absoluteScenarioPath, "..");
  const targetConfigPath = isAbsolute(result.data.targetConfig)
    ? resolve(result.data.targetConfig)
    : resolve(scenarioDirectory, result.data.targetConfig);

  return {
    scenario: result.data,
    scenarioPath: absoluteScenarioPath,
    scenarioDirectory,
    targetConfigPath,
  };
}
