import { describe, expect, it, vi } from "vitest";

import {
  AgentCleanupVerificationError,
  removeAndVerifyAgentContainer,
} from "../../src/agent/docker-cleanup.js";

function missingContainer(): Error {
  return Object.assign(new Error("Docker container inspect failed"), {
    code: 1,
    stderr: "error: no such object: forge-agent-test",
  });
}

describe("Agent V1 Docker cleanup", () => {
  it("verifies the run label before removal and confirms absence", async () => {
    const calls: string[][] = [];
    const runDocker = vi.fn(async (args: readonly string[]) => {
      calls.push([...args]);
      if (calls.length === 1) return { stdout: "run-expected\n" };
      if (calls.length === 2) return { stdout: "forge-agent-test\n" };
      throw missingContainer();
    });

    await expect(
      removeAndVerifyAgentContainer("forge-agent-test", "run-expected", {
        runDocker,
        settle: async () => undefined,
      }),
    ).resolves.toBeUndefined();

    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ["container", "inspect"],
      ["container", "rm"],
      ["container", "inspect"],
      ["container", "inspect"],
      ["container", "inspect"],
      ["container", "inspect"],
    ]);
    expect(calls[0]).toEqual([
      "container",
      "inspect",
      "--format",
      '{{ index .Config.Labels "forge.run_id" }}',
      "forge-agent-test",
    ]);
    expect(calls[1]).toEqual([
      "container",
      "rm",
      "--force",
      "--volumes",
      "forge-agent-test",
    ]);
  });

  it("fails closed when Docker cannot establish whether the container exists", async () => {
    const runDocker = vi.fn(async () => {
      throw new Error("Cannot connect to the Docker daemon");
    });

    await expect(
      removeAndVerifyAgentContainer("forge-agent-test", "run-expected", {
        runDocker,
        inspectTimeoutMs: 20,
      }),
    ).rejects.toBeInstanceOf(AgentCleanupVerificationError);
  });

  it.each([
    {
      label: "lowercase object diagnostic",
      error: Object.assign(new Error("inspect failed"), {
        code: 1,
        stderr: "error: no such object: forge-agent-test",
      }),
    },
    {
      label: "lowercase container diagnostic",
      error: Object.assign(new Error("remove failed"), {
        code: 1,
        stderr:
          "error response from daemon: no such container: forge-agent-test",
      }),
    },
    {
      label: "uppercase buffered diagnostic",
      error: Object.assign(new Error("inspect failed"), {
        code: 1,
        stderr: Buffer.from("Error: No such object: forge-agent-test\n"),
      }),
    },
  ])("accepts Docker's $label as verified absence", async ({ error }) => {
    const runDocker = vi.fn(async () => {
      throw error;
    });

    await expect(
      removeAndVerifyAgentContainer("forge-agent-test", "run-expected", {
        runDocker,
        settle: async () => undefined,
      }),
    ).resolves.toBeUndefined();
    expect(runDocker).toHaveBeenCalledWith(
      [
        "container",
        "inspect",
        "--format",
        '{{ index .Config.Labels "forge.run_id" }}',
        "forge-agent-test",
      ],
      5_000,
    );
    expect(runDocker).toHaveBeenCalledTimes(4);
  });

  it("resets absence confirmation when the container appears late and removes it only after checking the label", async () => {
    const calls: string[][] = [];
    const settle = vi.fn(async () => undefined);
    let inspectCount = 0;
    const runDocker = vi.fn(async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "container" && args[1] === "inspect") {
        inspectCount += 1;
        if (inspectCount === 2) {
          return { stdout: "run-expected\n" };
        }
        throw missingContainer();
      }
      return { stdout: "forge-agent-test\n" };
    });

    await expect(
      removeAndVerifyAgentContainer("forge-agent-test", "run-expected", {
        runDocker,
        settle,
      }),
    ).resolves.toBeUndefined();

    expect(inspectCount).toBe(6);
    expect(settle).toHaveBeenCalledTimes(5);
    expect(
      calls.filter(
        (args) => args[0] === "container" && args[1] === "rm",
      ),
    ).toEqual([
      [
        "container",
        "rm",
        "--force",
        "--volumes",
        "forge-agent-test",
      ],
    ]);
  });

  it.each([
    new Error("no such container: forge-agent-test"),
    new Error("Error: permission denied"),
    Object.assign(new Error("Error: No such object: forge-agent-test"), {
      code: 0,
    }),
  ])("fails closed for non-authoritative inspect errors", async (error) => {
    const runDocker = vi.fn(async () => {
      throw error;
    });

    await expect(
      removeAndVerifyAgentContainer("forge-agent-test", "run-expected", {
        runDocker,
      }),
    ).rejects.toBeInstanceOf(AgentCleanupVerificationError);
  });

  it("refuses to remove a container whose run label changed", async () => {
    const runDocker = vi.fn(async () => ({ stdout: "different-run\n" }));

    await expect(
      removeAndVerifyAgentContainer("forge-agent-test", "run-expected", {
        runDocker,
      }),
    ).rejects.toThrow("run label does not match");
    expect(runDocker).toHaveBeenCalledTimes(1);
  });

  it("fails when the labeled container persists after bounded retries", async () => {
    const settle = vi.fn(async () => undefined);
    const runDocker = vi.fn(async (args: readonly string[]) => ({
      stdout:
        args[0] === "container" && args[1] === "inspect"
          ? "run-expected\n"
          : "forge-agent-test\n",
    }));

    await expect(
      removeAndVerifyAgentContainer("forge-agent-test", "run-expected", {
        runDocker,
        checks: 2,
        settle,
      }),
    ).rejects.toThrow("still exists after cleanup");
    expect(settle).toHaveBeenCalledTimes(2);
    expect(
      runDocker.mock.calls.filter(
        ([args]) => args[0] === "container" && args[1] === "rm",
      ),
    ).toHaveLength(2);
  });

  it("bounds a Docker command even when its runner never settles", async () => {
    const runDocker = vi.fn(
      async () => new Promise<{ stdout: string }>(() => undefined),
    );

    await expect(
      removeAndVerifyAgentContainer("forge-agent-test", "run-expected", {
        runDocker,
        inspectTimeoutMs: 5,
      }),
    ).rejects.toBeInstanceOf(AgentCleanupVerificationError);
  });
});
