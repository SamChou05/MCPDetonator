import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  observedEventV1Schema,
  type ObservedEventV1,
} from "../../src/contracts/v1.js";
import { EvidenceStore } from "../../src/evidence-store.js";
import { compareInstallLifecycle } from "../../src/install/delta.js";

function event(
  experimentId: string,
  eventId: string,
  effect: ObservedEventV1["effect"],
): ObservedEventV1 {
  return observedEventV1Schema.parse({
    schema: "forge.event/v1",
    runId: "run-install-delta",
    experimentId,
    eventId,
    sequence: 0,
    timestamp: "2026-08-29T12:00:00.000Z",
    processRef: `run-install-delta:${experimentId}:pid-10`,
    effect,
    source: { collector: "strace", rawRef: `raw/${experimentId}/strace.10:1` },
  });
}

describe("install lifecycle delta", () => {
  it("removes shared activity and retains treatment-only semantic effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-install-delta-"));
    const store = await EvidenceStore.create(root, "run-install-delta");
    const controlId = "install-scripts-disabled";
    const treatmentId = "install-scripts-enabled";
    const sharedControl = event(controlId, "evt-control-npm", {
      kind: "process.exec",
      executable: "/usr/bin/npm",
      args: ["npm", "ci", "--ignore-scripts=true"],
      outcome: { status: "succeeded" },
    });
    const sharedTreatment = event(treatmentId, "evt-treatment-npm", {
      kind: "process.exec",
      executable: "/usr/bin/npm",
      args: ["npm", "ci", "--ignore-scripts=false"],
      outcome: { status: "succeeded" },
    });
    const marker = event(treatmentId, "evt-treatment-marker", {
      kind: "file.write",
      path: "/opt/target/install-marker.json",
      bytes: 30,
      outcome: { status: "succeeded" },
    });
    const ignoredCacheWrite = event(treatmentId, "evt-treatment-cache", {
      kind: "file.write",
      path: "/npm-cache/_logs/random.log",
      bytes: 30,
      outcome: { status: "succeeded" },
    });
    const controlContentWrite = event(controlId, "evt-control-content-write", {
      kind: "file.write",
      path: "/opt/target/shared-output.txt",
      bytes: 4,
      outcome: { status: "succeeded" },
    });
    const treatmentTruncate = event(
      treatmentId,
      "evt-treatment-truncate",
      {
        kind: "file.write",
        path: "/opt/target/shared-output.txt",
        operation: "truncate",
        outcome: { status: "succeeded" },
      },
    );
    const directoryEnumeration = event(
      treatmentId,
      "evt-treatment-directory-enumeration",
      {
        kind: "file.read",
        path: "/opt/target",
        operation: "directory_entries",
        outcome: { status: "succeeded" },
      },
    );

    const delta = await compareInstallLifecycle({
      store,
      runId: "run-install-delta",
      events: [
        sharedControl,
        sharedTreatment,
        controlContentWrite,
        marker,
        ignoredCacheWrite,
        treatmentTruncate,
        directoryEnumeration,
      ],
      controlExperimentId: controlId,
      treatmentExperimentId: treatmentId,
      includedFileRoots: ["/opt/target", "/sandbox/home/forge"],
    });

    expect(delta.treatmentOnly.processExec).toEqual([]);
    expect(delta.treatmentOnly.fileRead).toEqual([]);
    expect(delta.treatmentOnly.fileWrite).toEqual([
      marker.eventId,
      treatmentTruncate.eventId,
    ]);
    expect(delta.controlOnly.fileWrite).toEqual([controlContentWrite.eventId]);
    expect(JSON.stringify(delta)).not.toContain(ignoredCacheWrite.eventId);
    expect(JSON.stringify(delta)).not.toContain(directoryEnumeration.eventId);
  });
});
