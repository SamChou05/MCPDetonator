import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const redactionMarker = "[REDACTED_PROVIDER_CREDENTIAL]";

export class ProviderCredentialIsolationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderCredentialIsolationError";
  }
}

export function usableProviderCredentials(
  secrets: readonly string[],
): readonly string[] {
  return [...new Set(secrets.filter((secret) => secret.length >= 8))].sort(
    (left, right) => right.length - left.length,
  );
}

export function assertNoProviderCredentialInValue(
  value: unknown,
  secrets: readonly string[],
  failureMessage =
    "provider credential isolation check failed before external-model access",
): void {
  const credentials = usableProviderCredentials(secrets);
  const visited = new WeakSet<object>();

  function containsCredential(candidate: unknown): boolean {
    if (typeof candidate === "string") {
      return credentials.some((credential) => candidate.includes(credential));
    }
    if (typeof candidate !== "object" || candidate === null) {
      return false;
    }
    if (visited.has(candidate)) {
      return false;
    }
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      return candidate.some(containsCredential);
    }
    return Object.entries(candidate).some(
      ([key, entry]) => containsCredential(key) || containsCredential(entry),
    );
  }

  if (credentials.length > 0 && containsCredential(value)) {
    throw new ProviderCredentialIsolationError(failureMessage);
  }
}

export function redactProviderCredentials(
  value: string,
  secrets: readonly string[],
): string {
  let result = value;
  for (const secret of usableProviderCredentials(secrets)) {
    result = result.split(secret).join(redactionMarker);
  }
  return result;
}

async function fileContainsNeedle(
  path: string,
  needles: readonly Buffer[],
): Promise<boolean> {
  const overlapBytes = Math.max(...needles.map((needle) => needle.length)) - 1;
  let overlap = Buffer.alloc(0);
  for await (const rawChunk of createReadStream(path)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    const searchable =
      overlap.length === 0 ? chunk : Buffer.concat([overlap, chunk]);
    if (needles.some((needle) => searchable.includes(needle))) {
      return true;
    }
    overlap =
      overlapBytes <= 0
        ? Buffer.alloc(0)
        : searchable.subarray(Math.max(0, searchable.length - overlapBytes));
  }
  return false;
}

async function assertNoProviderCredentialInTree(
  root: string,
  secrets: readonly string[],
  failureMessage: string,
): Promise<void> {
  const needles = usableProviderCredentials(secrets).map((secret) =>
    Buffer.from(secret, "utf8"),
  );
  if (needles.length === 0) {
    return;
  }

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (await fileContainsNeedle(path, needles)) {
        throw new ProviderCredentialIsolationError(failureMessage);
      }
    }
  }

  await visit(root);
}

export async function assertNoProviderCredentialInPreparedTarget(
  root: string,
  secrets: readonly string[],
): Promise<void> {
  await assertNoProviderCredentialInTree(
    root,
    secrets,
    "provider credential isolation check failed: the prepared target contains the provider credential",
  );
}

export async function assertNoProviderCredentialInEvidence(
  root: string,
  secrets: readonly string[],
): Promise<void> {
  await assertNoProviderCredentialInTree(
    root,
    secrets,
    "provider credential isolation check failed: a credential appeared in evidence",
  );
}
