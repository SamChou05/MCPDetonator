import { realpath } from "node:fs/promises";

import type { ObservedPathMapping } from "./strace-normalizer.js";

const dockerDesktopHostPrefix = "/run/host_virtiofs";

/**
 * Build trace-only aliases for a host bind mount without changing the path
 * passed to Docker. Docker Desktop may expose either the lexical source path
 * or its filesystem-resolved path in strace's descriptor annotations.
 */
export async function mountPathMappings(
  hostPath: string,
  containerPath: string,
): Promise<ObservedPathMapping[]> {
  const canonicalHostPath = await realpath(hostPath);
  const observedPrefixes = new Set([
    hostPath,
    canonicalHostPath,
    `${dockerDesktopHostPrefix}${hostPath}`,
    `${dockerDesktopHostPrefix}${canonicalHostPath}`,
  ]);

  return [...observedPrefixes].map((observedPrefix) => ({
    observedPrefix,
    containerPrefix: containerPath,
  }));
}
