import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadTargetConfig } from "../../src/config.js";

const studyRoot = "experiments/security/unseen-mcp-holdout-2026-08-30";

describe("unseen MCP holdout study", () => {
  it("retains the frozen bounded outcomes without safety overclaims", async () => {
    const record = JSON.parse(
      await readFile(join(studyRoot, "results.json"), "utf8"),
    ) as Record<string, any>;

    expect(record.safety).toMatchObject({
      disposableDockerProfiles: true,
      runtimeNetwork: "blocked",
      syntheticHomeAndWorkspaceOnly: true,
      hostMcpConfigurationsModified: false,
      hostCredentialsMounted: false,
      realServiceCredentialsUsed: false,
      acquisitionLifecycleScripts: "disabled",
      publicPackageCodeExecuted: true,
      declaredMaliciousTestPackageExecuted: true,
    });
    expect(record.selection).toMatchObject({
      selectedPackageCount: 10,
      declaredPositiveControls: 1,
      unlabelledCases: 9,
    });
    expect(record.aggregate).toEqual({
      acquisitionCompleted: 10,
      scriptsDisabledAndEnabledInstallArmsCompleted: 10,
      catalogsDiscovered: 9,
      startupFailuresBeforeCatalog: 1,
      selectedToolInvocationsAttempted: 9,
      completedReports: 8,
      toolLevelFailuresBeforeReport: 1,
      packagesWithDeterministicFindings: 2,
      deterministicFindingCount: 5,
      findingRules: {
        "runtime.unexpected_network_attempt": 4,
        "runtime.file_scope_exceeded": 1,
      },
      blockedOrFailedNetworkAttempts: 4,
      syntheticFilesystemEntriesCreated: 1,
      declaredPositiveControlDeterministicFindings: 0,
    });

    const cases = record.cases as Array<Record<string, any>>;
    expect(cases).toHaveLength(10);
    expect(new Set(cases.map((entry) => entry.caseId)).size).toBe(10);
    expect(cases.find((entry) => entry.caseId === "panda")?.probe.outcome).toBe(
      "startup_failed_before_catalog",
    );
    expect(
      cases.find((entry) => entry.caseId === "excel")?.invocation.status,
    ).toBe("tool_error_before_report");
    expect(
      cases.find((entry) => entry.caseId === "declared-malicious")?.findings,
    ).toEqual([]);

    const sweep = record.exploratoryPositiveControlSweep;
    expect(sweep).toMatchObject({
      toolsCompleted: 7,
      runtimeEffectCount: 0,
      filesystemChangeCount: 0,
      deterministicFindingCount: 0,
    });
    expect(sweep.toolResults).toHaveLength(7);
    expect(
      sweep.toolResults.map(
        (entry: Record<string, any>) => entry.classification,
      ),
    ).toContain("direct_prompt_injection_requesting_system_prompt_and_secrets");
    expect(
      sweep.toolResults.some(
        (entry: Record<string, any>) => entry.hasControlCharacters === true,
      ),
    ).toBe(true);
  });

  it("keeps every frozen probe and invocation inside the blocked profile", async () => {
    const probeDirectory = join(studyRoot, "probes");
    const targetDirectory = join(studyRoot, "targets");
    const probeFiles = (await readdir(probeDirectory))
      .filter((name) => name.endsWith(".yaml"))
      .sort();
    const targetFiles = (await readdir(targetDirectory))
      .filter((name) => name.endsWith(".yaml"))
      .sort();

    expect(probeFiles).toHaveLength(10);
    expect(targetFiles).toHaveLength(10);

    for (const path of [
      ...probeFiles.map((name) => join(probeDirectory, name)),
      ...targetFiles.map((name) => join(targetDirectory, name)),
    ]) {
      const loaded = await loadTargetConfig(path);
      expect(loaded.config.target.source.type).toBe("npm");
      expect(loaded.config.sandbox).toMatchObject({
        profile: "developer-v1",
        network: "blocked",
      });
      expect(loaded.config.target.runtime.env).toEqual({});
    }
  });
});
