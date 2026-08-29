import type { ExpectedScopeV1 } from "./config.js";

export function pathMatchesExpectedScope(
  path: string,
  exact: readonly string[],
  prefixes: readonly string[],
): boolean {
  return (
    exact.includes(path) ||
    prefixes.some(
      (prefix) => path === prefix || path.startsWith(`${prefix.replace(/\/$/, "")}/`),
    )
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
