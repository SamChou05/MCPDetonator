import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentTrialResourceQuotaError,
  startAgentTrialResourceQuotaMonitor,
} from "../../src/agent/resource-quota.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function root(name: string): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), `forge-agent-quota-${name}-`));
  temporaryDirectories.push(path);
  return path;
}

describe("Agent V1 writable-state quota", () => {
  it("returns a violated monitor for initial overage so callers can persist evidence", async () => {
    const directory = await root("initial-overage");
    await writeFile(resolve(directory, "already-large.bin"), Buffer.alloc(2_048));
    const terminate = vi.fn(async () => undefined);
    const monitor = await startAgentTrialResourceQuotaMonitor({
      roots: [directory],
      maxBytes: 1_024,
      maxEntries: 8,
      pollMs: 5,
      onViolation: terminate,
    });

    expect(() => monitor.assertWithinQuota()).toThrow(
      AgentTrialResourceQuotaError,
    );
    expect(monitor.snapshot()).toMatchObject({
      status: "violated",
      termination: "succeeded",
      latest: { bytes: 2_048 },
    });
    await expect(monitor.stop()).rejects.toThrow(AgentTrialResourceQuotaError);
  });

  it("terminates and fails when the current writable tree exceeds the limit", async () => {
    const directory = await root("bytes");
    const terminate = vi.fn(async () => undefined);
    const monitor = await startAgentTrialResourceQuotaMonitor({
      roots: [directory],
      maxBytes: 1_024,
      maxEntries: 32,
      pollMs: 5,
      onViolation: terminate,
    });

    await writeFile(resolve(directory, "flood.bin"), Buffer.alloc(2_048));
    const error = await monitor.violation;

    expect(error).toBeInstanceOf(AgentTrialResourceQuotaError);
    expect(error.message).toContain("1024-byte limit");
    await expect(monitor.stop()).rejects.toThrow(
      AgentTrialResourceQuotaError,
    );
    expect(monitor.snapshot()).toMatchObject({
      status: "violated",
      termination: "succeeded",
      latest: { bytes: 2_048 },
    });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("counts entries and never follows target-authored symbolic links", async () => {
    const directory = await root("entries");
    const outside = await root("outside");
    const outsideFile = resolve(outside, "large.bin");
    await writeFile(outsideFile, Buffer.alloc(200_000));
    await mkdir(resolve(directory, "nested"));
    await symlink(outsideFile, resolve(directory, "nested", "outside-link"));
    const terminate = vi.fn(async () => undefined);
    const monitor = await startAgentTrialResourceQuotaMonitor({
      roots: [directory],
      maxBytes: 100_000,
      maxEntries: 3,
      pollMs: 5,
      onViolation: terminate,
    });

    await Promise.all(
      ["one", "two", "three"].map((name) =>
        writeFile(resolve(directory, "nested", name), "x"),
      ),
    );
    await expect(monitor.violation).resolves.toMatchObject({
      name: "AgentTrialResourceQuotaError",
    });
    await expect(monitor.stop()).rejects.toThrow("3-entry limit");
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("stops cleanly while usage remains below both budgets", async () => {
    const directory = await root("clean");
    await writeFile(resolve(directory, "small.txt"), "small");
    const terminate = vi.fn(async () => undefined);
    const monitor = await startAgentTrialResourceQuotaMonitor({
      roots: [directory],
      maxBytes: 100_000,
      maxEntries: 8,
      pollMs: 5,
      onViolation: terminate,
    });

    await monitor.stop();
    expect(() => monitor.assertWithinQuota()).not.toThrow();
    expect(monitor.snapshot()).toMatchObject({
      status: "within_quota",
      termination: "not_requested",
      latest: { entries: 1 },
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("treats a file reaching the process file limit as a typed violation", async () => {
    const directory = await root("file-limit");
    const terminate = vi.fn(async () => undefined);
    const monitor = await startAgentTrialResourceQuotaMonitor({
      roots: [directory],
      maxBytes: 100_000,
      maxEntries: 8,
      maxFileBytes: 1_024,
      pollMs: 5,
      onViolation: terminate,
    });

    await writeFile(resolve(directory, "trace.log"), Buffer.alloc(1_024));
    await expect(monitor.violation).resolves.toMatchObject({
      message: expect.stringContaining("process file limit"),
    });
    await expect(monitor.stop()).rejects.toThrow(AgentTrialResourceQuotaError);
    expect(monitor.snapshot().peak.bytes).toBeGreaterThanOrEqual(1_024);
  });
});
