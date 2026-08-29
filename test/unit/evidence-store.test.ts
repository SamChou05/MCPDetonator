import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { observedEventV1Schema } from "../../src/contracts/v1.js";
import { EvidenceStore, sha256 } from "../../src/evidence-store.js";

const event = {
  schema: "forge.event/v1" as const,
  eventId: "evt-1",
  runId: "run-1",
  experimentId: "initialization",
  sequence: 1,
  timestamp: "2026-08-29T18:20:00.123Z",
  processRef: "run-1:pid-10",
  effect: {
    kind: "file.open" as const,
    path: "/sandbox/workspace/report.txt",
    outcome: { status: "succeeded" as const },
  },
  source: {
    collector: "strace" as const,
    rawRef: "raw/strace.10:1",
  },
};

describe("EvidenceStore", () => {
  it("writes validated JSONL records", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-evidence-"));
    const store = await EvidenceStore.create(root, "run-1");

    await store.appendJsonl("events.jsonl", observedEventV1Schema, event);
    const contents = await readFile(join(store.runDirectory, "events.jsonl"), "utf8");

    expect(JSON.parse(contents)).toEqual(event);
  });

  it("rejects artifact paths outside the run directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-evidence-"));
    const store = await EvidenceStore.create(root, "run-2");

    await expect(
      store.appendJsonl("../events.jsonl", observedEventV1Schema, event),
    ).rejects.toThrow("escapes the run directory");
  });

  it("calculates stable SHA-256 identifiers", () => {
    expect(sha256("forge")).toBe(
      "71b41d6dd48dc58eba8f5cf9edf30fef6597fdf285a521bb8fcbad4b3d50887d",
    );
  });
});
