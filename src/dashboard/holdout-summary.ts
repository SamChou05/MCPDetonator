import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { UnseenHoldoutSummary } from "./render.js";

export async function loadUnseenHoldoutSummary(
  repositoryRoot: string,
): Promise<UnseenHoldoutSummary | undefined> {
  const path = join(
    repositoryRoot,
    "experiments",
    "security",
    "unseen-mcp-holdout-2026-08-30",
    "results.json",
  );
  const document = JSON.parse(await readFile(path, "utf8")) as {
    readonly schema?: unknown;
    readonly runDate?: unknown;
    readonly cases?: readonly {
      readonly caseId?: unknown;
      readonly package?: unknown;
      readonly version?: unknown;
      readonly probe?: {
        readonly outcome?: unknown;
        readonly failureClass?: unknown;
      };
      readonly invocation?: {
        readonly status?: unknown;
        readonly tool?: unknown;
        readonly failureClass?: unknown;
      };
      readonly findings?: readonly {
        readonly ruleId?: unknown;
        readonly count?: unknown;
      }[];
    }[];
  };
  if (document.schema !== "forge.unseen-mcp-holdout-study/v1") {
    throw new Error("unseen MCP holdout study has an unexpected schema");
  }
  if (typeof document.runDate !== "string" || !Array.isArray(document.cases)) {
    throw new Error("unseen MCP holdout study summary is incomplete");
  }
  return {
    runDate: document.runDate,
    caseCount: document.cases.length,
    cases: document.cases.map((studyCase) => {
      if (
        typeof studyCase.caseId !== "string" ||
        typeof studyCase.package !== "string" ||
        typeof studyCase.version !== "string" ||
        typeof studyCase.probe?.outcome !== "string" ||
        typeof studyCase.invocation?.status !== "string" ||
        !Array.isArray(studyCase.findings)
      ) {
        throw new Error("unseen MCP holdout case summary is invalid");
      }
      return {
        caseId: studyCase.caseId,
        packageName: studyCase.package,
        packageVersion: studyCase.version,
        probeOutcome: studyCase.probe.outcome as never,
        probeFailureClass: studyCase.probe.failureClass,
        invocationStatus: studyCase.invocation.status as never,
        selectedTool: studyCase.invocation.tool,
        invocationFailureClass: studyCase.invocation.failureClass,
        findings: studyCase.findings.map((finding: {
          readonly ruleId?: unknown;
          readonly count?: unknown;
        }) => {
          if (typeof finding?.ruleId !== "string" || typeof finding.count !== "number") {
            throw new Error("unseen MCP holdout finding is invalid");
          }
          return { ruleId: finding.ruleId, count: finding.count };
        }),
      };
    }),
  };
}
