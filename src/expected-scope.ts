import { posix } from "node:path";

import type { ExpectedScopeV1 } from "./config.js";

function canonicalLinuxAbsolutePath(path: string): string | undefined {
  if (!posix.isAbsolute(path)) {
    return undefined;
  }
  const normalized = posix.normalize(path);
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

export function pathMatchesExpectedScope(
  path: string,
  exact: readonly string[],
  prefixes: readonly string[],
): boolean {
  const canonicalPath = canonicalLinuxAbsolutePath(path);
  if (canonicalPath === undefined) {
    return false;
  }

  return (
    exact.some(
      (candidate) => canonicalLinuxAbsolutePath(candidate) === canonicalPath,
    ) ||
    prefixes.some((candidate) => {
      const prefix = canonicalLinuxAbsolutePath(candidate);
      return (
        prefix !== undefined &&
        (canonicalPath === prefix ||
          canonicalPath.startsWith(prefix === "/" ? "/" : `${prefix}/`))
      );
    })
  );
}

export function destinationMatchesExpectedScope(
  address: string,
  port: number | undefined,
  allowed: ExpectedScopeV1["networkConnections"],
): boolean {
  return allowed.some(
    (destination) =>
      destination.address === address &&
      (destination.port === undefined || destination.port === port),
  );
}
