import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { removeManagedContainer } from "../sandbox/docker.js";

const execFileAsync = promisify(execFile);

function errorText(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }
  const candidate = error as { readonly message?: unknown; readonly stderr?: unknown };
  return [candidate.message, candidate.stderr]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function containerDoesNotExist(error: unknown): boolean {
  const text = errorText(error);
  return text.includes("No such object") || text.includes("No such container");
}

/**
 * Remove an Agent V1 container through the shared label-checked helper, then
 * independently verify absence. The shared helper intentionally treats an
 * inspect failure as an already-gone container; Agent V1 fails closed when
 * Docker itself could not confirm that state.
 */
export async function removeAndVerifyAgentContainer(
  containerName: string,
  expectedRunId: string,
): Promise<void> {
  await removeManagedContainer(containerName, expectedRunId);

  try {
    await execFileAsync("docker", ["container", "inspect", containerName], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64_000,
    });
  } catch (error) {
    if (containerDoesNotExist(error)) {
      return;
    }
    throw new Error(
      `could not verify cleanup of Agent V1 container '${containerName}'`,
      { cause: error },
    );
  }

  throw new Error(
    `Agent V1 container '${containerName}' still exists after cleanup`,
  );
}
