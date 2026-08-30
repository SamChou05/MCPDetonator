import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { loadTargetConfig } from "../../src/config.js";
import { EvidenceStore } from "../../src/evidence-store.js";
import {
  acquisitionContainerDoesNotExist,
  prepareTarget,
  runNpmInstall,
  type NpmAcquisitionChildProcess,
} from "../../src/target/prepare.js";

function controlledAcquisitionProcess(
  options: { readonly ignoreTermination?: boolean } = {},
): {
  readonly child: NpmAcquisitionChildProcess;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly terminated: () => boolean;
  readonly terminationSignals: () => readonly ("SIGTERM" | "SIGKILL")[];
  close(code: number | null, signal?: NodeJS.Signals | null): void;
  fail(error: Error): void;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let errorListener: ((error: Error) => void) | undefined;
  let closeListener:
    | ((code: number | null, signal: NodeJS.Signals | null) => void)
    | undefined;
  let wasTerminated = false;
  const terminationSignals: Array<"SIGTERM" | "SIGKILL"> = [];
  let closed = false;

  const close = (code: number | null, signal: NodeJS.Signals | null = null) => {
    if (closed) {
      return;
    }
    closed = true;
    stdout.end();
    stderr.end();
    queueMicrotask(() => closeListener?.(code, signal));
  };

  return {
    stdout,
    stderr,
    child: {
      stdout,
      stderr,
      onError: (listener) => {
        errorListener = listener;
      },
      onClose: (listener) => {
        closeListener = listener;
      },
      terminate: (signal) => {
        wasTerminated = true;
        terminationSignals.push(signal);
        if (!options.ignoreTermination) {
          close(null, signal);
        }
      },
    },
    terminated: () => wasTerminated,
    terminationSignals: () => terminationSignals,
    close,
    fail: (error) => {
      errorListener?.(error);
      close(null);
    },
  };
}

describe("sandboxed npm acquisition", () => {
  it("treats only an explicit Docker no-such-object diagnostic as absence", () => {
    expect(
      acquisitionContainerDoesNotExist({
        code: 1,
        stderr: "Error response from daemon: No such container: gone",
      }),
    ).toBe(true);
    expect(
      acquisitionContainerDoesNotExist({
        code: 1,
        stderr: "permission denied while connecting to the Docker daemon",
      }),
    ).toBe(false);
    expect(
      acquisitionContainerDoesNotExist({
        code: "ETIMEDOUT",
        message: "Docker inspect timed out",
      }),
    ).toBe(false);
  });

  it("uses label-checked cleanup and preserves a bounded success log", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-acquisition-success-"));
    const store = await EvidenceStore.create(join(root, "runs"), "run-acquire-ok");
    const process = controlledAcquisitionProcess();
    const cleanupCalls: Array<[string, string]> = [];
    let dockerArgs: readonly string[] = [];

    await runNpmInstall(
      {
        image: "observer:test",
        runId: "run-acquire-ok",
        hostRoot: join(root, "target"),
        hostNpmCache: join(root, "cache"),
        command: "install",
        store,
        timeoutMs: 1_000,
      },
      {
        spawnDocker: (args) => {
          dockerArgs = args;
          queueMicrotask(() => {
            process.stdout.write(Buffer.alloc(2_000_100, "a"));
            process.close(0);
          });
          return process.child;
        },
        removeContainer: async (containerName, runId) => {
          cleanupCalls.push([containerName, runId]);
        },
      },
    );

    expect(cleanupCalls).toEqual([
      ["forge-run-acquire-ok-acquisition", "run-acquire-ok"],
    ]);
    expect(dockerArgs).toEqual(
      expect.arrayContaining([
        "--name",
        "forge-run-acquire-ok-acquisition",
        "forge.run_id=run-acquire-ok",
      ]),
    );
    const log = await readFile(store.pathFor("raw/acquisition/npm-install.log"));
    expect(log.byteLength).toBeLessThan(2_000_200);
    expect(log.toString("utf8")).toContain(
      "[forge: output truncated at 2000000 bytes]",
    );
  });

  it("cleans up and preserves output when npm exits unsuccessfully", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-acquisition-failure-"));
    const store = await EvidenceStore.create(join(root, "runs"), "run-acquire-fail");
    const process = controlledAcquisitionProcess();
    const cleanupCalls: Array<[string, string]> = [];

    const acquisition = runNpmInstall(
      {
        image: "observer:test",
        runId: "run-acquire-fail",
        hostRoot: join(root, "target"),
        hostNpmCache: join(root, "cache"),
        command: "ci",
        store,
        timeoutMs: 1_000,
      },
      {
        spawnDocker: () => {
          queueMicrotask(() => {
            process.stdout.write("partial stdout\n");
            process.stderr.write("npm failure detail\n");
            process.close(42);
          });
          return process.child;
        },
        removeContainer: async (containerName, runId) => {
          cleanupCalls.push([containerName, runId]);
        },
      },
    );

    await expect(acquisition).rejects.toMatchObject({
      cleanupVerified: true,
      message: expect.stringContaining("sandboxed npm ci exited with 42"),
    });
    expect(cleanupCalls).toEqual([
      ["forge-run-acquire-fail-acquisition", "run-acquire-fail"],
    ]);
    const log = await readFile(
      store.pathFor("raw/acquisition/npm-install.log"),
      "utf8",
    );
    expect(log).toContain("partial stdout");
    expect(log).toContain("npm failure detail");
    expect(log).toContain("[forge: exited with 42]");
  });

  it("cleans up and preserves output when the Docker process fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-acquisition-process-error-"));
    const store = await EvidenceStore.create(join(root, "runs"), "run-acquire-error");
    const process = controlledAcquisitionProcess();
    const cleanupCalls: Array<[string, string]> = [];

    const acquisition = runNpmInstall(
      {
        image: "observer:test",
        runId: "run-acquire-error",
        hostRoot: join(root, "target"),
        hostNpmCache: join(root, "cache"),
        command: "install",
        store,
        timeoutMs: 1_000,
      },
      {
        spawnDocker: () => {
          queueMicrotask(() => {
            process.stderr.write("docker process output\n");
            process.fail(new Error("synthetic spawn failure"));
          });
          return process.child;
        },
        removeContainer: async (containerName, runId) => {
          cleanupCalls.push([containerName, runId]);
        },
      },
    );

    await expect(acquisition).rejects.toThrow(
      "sandboxed npm install failed to run: synthetic spawn failure",
    );
    expect(cleanupCalls).toEqual([
      ["forge-run-acquire-error-acquisition", "run-acquire-error"],
    ]);
    const log = await readFile(
      store.pathFor("raw/acquisition/npm-install.log"),
      "utf8",
    );
    expect(log).toContain("docker process output");
    expect(log).toContain("[forge: Docker process failed: synthetic spawn failure]");
  });

  it("removes the managed container, terminates the CLI, and logs a timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-acquisition-timeout-"));
    const store = await EvidenceStore.create(join(root, "runs"), "run-acquire-timeout");
    const process = controlledAcquisitionProcess();
    const cleanupCalls: Array<[string, string]> = [];

    const acquisition = runNpmInstall(
      {
        image: "observer:test",
        runId: "run-acquire-timeout",
        hostRoot: join(root, "target"),
        hostNpmCache: join(root, "cache"),
        command: "install",
        store,
        timeoutMs: 10,
      },
      {
        spawnDocker: () => {
          process.stdout.write("output before timeout\n");
          return process.child;
        },
        removeContainer: async (containerName, runId) => {
          cleanupCalls.push([containerName, runId]);
        },
      },
    );

    await expect(acquisition).rejects.toThrow(
      "sandboxed npm install timed out after 10 ms",
    );
    expect(process.terminated()).toBe(true);
    expect(process.stdout.writableEnded).toBe(true);
    expect(process.stderr.writableEnded).toBe(true);
    expect(cleanupCalls).toEqual([
      ["forge-run-acquire-timeout-acquisition", "run-acquire-timeout"],
      ["forge-run-acquire-timeout-acquisition", "run-acquire-timeout"],
    ]);
    const log = await readFile(
      store.pathFor("raw/acquisition/npm-install.log"),
      "utf8",
    );
    expect(log).toContain("output before timeout");
    expect(log).toContain("[forge: timed out after 10 ms]");
  });

  it("force-settles when the child ignores signals and cleanup never resolves", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-acquisition-wedged-"));
    const store = await EvidenceStore.create(join(root, "runs"), "run-acquire-wedged");
    const process = controlledAcquisitionProcess({ ignoreTermination: true });
    const cleanupCalls: Array<[string, string, number]> = [];
    const startedAt = Date.now();

    const acquisition = runNpmInstall(
      {
        image: "observer:test",
        runId: "run-acquire-wedged",
        hostRoot: join(root, "target"),
        hostNpmCache: join(root, "cache"),
        command: "install",
        store,
        timeoutMs: 5,
      },
      {
        spawnDocker: () => {
          process.stdout.write("output from wedged acquisition\n");
          return process.child;
        },
        removeContainer: (containerName, runId, timeoutMs) => {
          cleanupCalls.push([containerName, runId, timeoutMs]);
          return new Promise<void>(() => undefined);
        },
        timing: {
          sigkillAfterMs: 5,
          forceSettlementAfterMs: 10,
          cleanupAttemptTimeoutMs: 10,
        },
      },
    );

    await expect(acquisition).rejects.toMatchObject({
      cleanupVerified: false,
      message: expect.stringContaining(
        "sandboxed npm install timed out after 5 ms",
      ),
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(process.terminationSignals()).toEqual(["SIGTERM", "SIGKILL"]);
    expect(process.stdout.destroyed).toBe(true);
    expect(process.stderr.destroyed).toBe(true);
    expect(cleanupCalls).toEqual([
      ["forge-run-acquire-wedged-acquisition", "run-acquire-wedged", 10],
      ["forge-run-acquire-wedged-acquisition", "run-acquire-wedged", 10],
    ]);
    const log = await readFile(
      store.pathFor("raw/acquisition/npm-install.log"),
      "utf8",
    );
    expect(log).toContain("output from wedged acquisition");
    expect(log).toContain("[forge: timed out after 5 ms]");
    expect(log).toContain(
      "[forge: container cleanup failed: container cleanup timed out after 10 ms]",
    );
  });
});

describe("generic prepared target handoff", () => {
  it("snapshots an unrelated local package before it can execute", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-prepared-target-test-"));
    const sourceRoot = join(root, "independent-server");
    const outputRoot = join(root, "evidence");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(
      join(sourceRoot, "package.json"),
      `${JSON.stringify({
        name: "independent-stdio-server",
        version: "7.3.1",
        type: "module",
      })}\n`,
      "utf8",
    );
    await writeFile(join(sourceRoot, "server.js"), "process.exit(0);\n", "utf8");
    const configPath = join(root, "target.yaml");
    await writeFile(
      configPath,
      `schema: forge.target/v1
target:
  id: independent-server
  source:
    type: local
    path: ./independent-server
    install: none
  runtime:
    transport: stdio
    command: node
    args: [/opt/target/server.js]
sandbox:
  profile: developer-v1
  network: blocked
  limits:
    timeoutMs: 1000
    cooldownMs: 0
    memoryMb: 128
    cpus: 1
    pids: 32
experiments:
  initialization: false
  tools:
    - id: placeholder
      tool: placeholder
      input: {}
      expected:
        fileReads: []
        fileWrites: []
        networkConnections: []
        childExecutables: []
  workflows: []
`,
      "utf8",
    );

    const loaded = await loadTargetConfig(configPath);
    const store = await EvidenceStore.create(outputRoot, "run-independent");
    const prepared = await prepareTarget({
      loaded,
      runId: "run-independent",
      store,
      image: "not-used-for-install-none",
    });

    expect(prepared.containerRoot).toBe("/opt/target");
    expect(prepared.hostRoot).not.toBe(sourceRoot);
    expect(prepared.provenance.source).toMatchObject({
      type: "local",
      sourceFileCount: 2,
    });
    expect(prepared.provenance.install).toEqual({
      strategy: "none",
      lifecycleScripts: "disabled",
    });

    await writeFile(join(sourceRoot, "server.js"), "throw new Error('changed');\n");
    expect(await readFile(join(prepared.hostRoot, "server.js"), "utf8")).toBe(
      "process.exit(0);\n",
    );
    expect(
      JSON.parse(
        await readFile(store.pathFor("target/provenance.json"), "utf8"),
      ),
    ).toMatchObject({
      schema: "forge.target-provenance/v1",
      targetId: "independent-server",
    });

    const preparedRoot = prepared.hostRoot;
    await prepared.dispose();
    await expect(access(preparedRoot)).rejects.toThrow();
  });

  it("reuses installTimeoutMs for dependency acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-prepared-timeout-test-"));
    const sourceRoot = join(root, "independent-server");
    const outputRoot = join(root, "evidence");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(
      join(sourceRoot, "package.json"),
      '{"name":"independent-stdio-server","version":"1.0.0"}\n',
      "utf8",
    );
    const configPath = join(root, "target.yaml");
    await writeFile(
      configPath,
      `schema: forge.target/v1
target:
  id: independent-server
  source:
    type: local
    path: ./independent-server
    install: npm-ignore-scripts
  runtime:
    transport: stdio
    command: node
    args: [/opt/target/server.js]
sandbox:
  profile: developer-v1
  network: blocked
  limits:
    timeoutMs: 1000
    installTimeoutMs: 4321
    cooldownMs: 0
    memoryMb: 128
    cpus: 1
    pids: 32
experiments:
  initialization: false
  tools:
    - id: placeholder
      tool: placeholder
      input: {}
      expected:
        fileReads: []
        fileWrites: []
        networkConnections: []
        childExecutables: []
  workflows: []
`,
      "utf8",
    );

    const loaded = await loadTargetConfig(configPath);
    const store = await EvidenceStore.create(outputRoot, "run-timeout-config");
    let observedTimeout: number | undefined;
    const prepared = await prepareTarget({
      loaded,
      runId: "run-timeout-config",
      store,
      image: "not-used-by-injected-runner",
      dependencies: {
        runNpmInstall: async (options) => {
          observedTimeout = options.timeoutMs;
        },
      },
    });

    expect(observedTimeout).toBe(4_321);
    expect(prepared.provenance.install.strategy).toBe("npm-install");
    await prepared.dispose();
  });
});
