import { lstat, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir) };
});

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

  it("rejects unsafe run IDs before creating an output or escaped directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-evidence-run-id-"));
    const absoluteEscape = join(root, "absolute-escape");
    const parentEscape = join(root, "parent-escape");
    const invalidRunIds = [
      "",
      ".",
      "..",
      "../parent-escape",
      "nested/run",
      "nested\\run",
      "control\nrun",
      "x".repeat(256),
      absoluteEscape,
    ];

    for (const [index, runId] of invalidRunIds.entries()) {
      const outputRoot = join(root, `output-${index}`);
      await expect(EvidenceStore.create(outputRoot, runId)).rejects.toThrow(
        "evidence run ID",
      );
      await expect(lstat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
    }

    await expect(lstat(absoluteEscape)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(parentEscape)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves safe existing run ID punctuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-evidence-run-id-"));
    const runId = "run_2026.08.30:alpha-1";
    const store = await EvidenceStore.create(root, runId);

    expect(store.runDirectory).toBe(resolve(root, runId));
  });

  it.runIf(process.platform !== "win32")(
    "creates new output, run, and raw directories with private modes",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "forge-evidence-modes-"));
      const outputRoot = join(root, "output");
      const store = await EvidenceStore.create(outputRoot, "private-run");

      expect((await stat(outputRoot)).mode & 0o777).toBe(0o700);
      expect((await stat(store.runDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(store.runDirectory, "raw"))).mode & 0o777).toBe(
        0o700,
      );
    },
  );

  it("removes an incomplete run directory after raw-directory setup fails", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "forge-evidence-setup-"));
    const runDirectory = join(outputRoot, "failed-run");
    const rawDirectory = join(runDirectory, "raw");
    const sentinel = join(outputRoot, "pre-existing.txt");
    await writeFile(sentinel, "preserve me", "utf8");

    const actual = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    const setupFailure = Object.assign(new Error("injected raw setup failure"), {
      code: "EACCES",
    });
    const failRawSetup = (async (
      path: Parameters<typeof mkdir>[0],
      options?: Parameters<typeof mkdir>[1],
    ) => {
      if (String(path) === rawDirectory) {
        throw setupFailure;
      }
      return await actual.mkdir(path, options);
    }) as typeof mkdir;

    await vi.mocked(mkdir).withImplementation(failRawSetup, async () => {
      await expect(EvidenceStore.create(outputRoot, "failed-run")).rejects.toBe(
        setupFailure,
      );
    });

    await expect(lstat(runDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(sentinel, "utf8")).toBe("preserve me");
    expect((await stat(outputRoot)).isDirectory()).toBe(true);
  });

  it("calculates stable SHA-256 identifiers", () => {
    expect(sha256("forge")).toBe(
      "71b41d6dd48dc58eba8f5cf9edf30fef6597fdf285a521bb8fcbad4b3d50887d",
    );
  });
});
