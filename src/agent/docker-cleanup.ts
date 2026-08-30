import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultCleanupChecks = 4;
const cleanupSettlementMs = 100;
const inspectTimeoutMs = 5_000;
const removeTimeoutMs = 10_000;

interface DockerCommandResult {
  readonly stdout: string;
}

type DockerCommandRunner = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<DockerCommandResult>;

interface AgentCleanupOptions {
  /** Test seam; production callers use the bounded Docker CLI runner. */
  readonly runDocker?: DockerCommandRunner;
  readonly checks?: number;
  readonly inspectTimeoutMs?: number;
  readonly removeTimeoutMs?: number;
  readonly settle?: () => Promise<void>;
}

export class AgentCleanupVerificationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentCleanupVerificationError";
  }
}

function textField(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return undefined;
}

function errorText(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }
  const candidate = error as {
    readonly message?: unknown;
    readonly stderr?: unknown;
    readonly stdout?: unknown;
  };
  return [candidate.message, candidate.stderr, candidate.stdout]
    .map(textField)
    .filter((value): value is string => value !== undefined)
    .join("\n");
}

function containerDoesNotExist(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as {
    readonly code?: unknown;
    readonly exitCode?: unknown;
    readonly status?: unknown;
  };
  const structuredExits = [candidate.code, candidate.exitCode, candidate.status];
  if (structuredExits.some((value) => value === 0 || value === "0")) {
    return false;
  }

  const diagnostic = errorText(error).replace(/\r\n?/gu, "\n");
  return diagnostic.split("\n").some((line) =>
    /^\s*(?:docker:\s*)?error(?:\s+response\s+from\s+daemon)?\s*:\s*no\s+such\s+(?:object|container)(?::|\s|$)/iu.test(
      line,
    ),
  );
}

async function defaultDockerRunner(
  args: readonly string[],
  timeoutMs: number,
): Promise<DockerCommandResult> {
  const { stdout } = await execFileAsync("docker", [...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64_000,
  });
  return { stdout };
}

async function withinDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  try {
    return await Promise.race([
      operation,
      delay(timeoutMs, undefined, { signal: controller.signal }).then(() => {
        throw new Error(`${label} timed out after ${timeoutMs} ms`);
      }),
    ]);
  } finally {
    controller.abort();
  }
}

/**
 * Remove one exact run-labeled Agent V1 container and independently verify its
 * absence. Every Docker operation is bounded. Ambiguous daemon responses,
 * label drift, and a persistent container all fail closed.
 */
export async function removeAndVerifyAgentContainer(
  containerName: string,
  expectedRunId: string,
  options: AgentCleanupOptions = {},
): Promise<void> {
  const runDocker = options.runDocker ?? defaultDockerRunner;
  const checks = options.checks ?? defaultCleanupChecks;
  const inspectTimeout = options.inspectTimeoutMs ?? inspectTimeoutMs;
  const removeTimeout = options.removeTimeoutMs ?? removeTimeoutMs;
  const settle = options.settle ?? (() => delay(cleanupSettlementMs));

  if (!Number.isSafeInteger(checks) || checks <= 0) {
    throw new AgentCleanupVerificationError("cleanup checks must be positive");
  }

  const inspect = async (): Promise<
    | { readonly state: "absent" }
    | { readonly state: "present"; readonly runId: string }
  > => {
    try {
      const result = await withinDeadline(
        runDocker(
          [
            "container",
            "inspect",
            "--format",
            '{{ index .Config.Labels "forge.run_id" }}',
            containerName,
          ],
          inspectTimeout,
        ),
        inspectTimeout,
        "Agent V1 Docker inspect",
      );
      return { state: "present", runId: result.stdout.trim() };
    } catch (error) {
      if (containerDoesNotExist(error)) {
        return { state: "absent" };
      }
      throw new AgentCleanupVerificationError(
        `could not verify cleanup of Agent V1 container '${containerName}'`,
        { cause: error },
      );
    }
  };

  let consecutiveAbsenceChecks = 0;
  let removalAttempts = 0;
  while (consecutiveAbsenceChecks < checks) {
    const observed = await inspect();
    if (observed.state === "absent") {
      consecutiveAbsenceChecks += 1;
    } else {
      consecutiveAbsenceChecks = 0;
      if (observed.runId !== expectedRunId) {
        throw new AgentCleanupVerificationError(
          `refusing to remove Agent V1 container '${containerName}' because its run label does not match`,
        );
      }
      if (removalAttempts >= checks) {
        throw new AgentCleanupVerificationError(
          `Agent V1 container '${containerName}' still exists after cleanup`,
        );
      }
      removalAttempts += 1;

      try {
        await withinDeadline(
          runDocker(
            ["container", "rm", "--force", "--volumes", containerName],
            removeTimeout,
          ),
          removeTimeout,
          "Agent V1 Docker removal",
        );
      } catch (error) {
        if (!containerDoesNotExist(error)) {
          throw new AgentCleanupVerificationError(
            `could not remove Agent V1 container '${containerName}'`,
            { cause: error },
          );
        }
      }
    }

    if (consecutiveAbsenceChecks < checks) {
      await settle();
    }
  }
}
