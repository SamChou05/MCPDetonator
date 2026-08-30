import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const redactionMarker = "[REDACTED_PROVIDER_CREDENTIAL]";

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
): void {
  const serialized = JSON.stringify(value);
  if (
    serialized !== undefined &&
    usableProviderCredentials(secrets).some((secret) => serialized.includes(secret))
  ) {
    throw new Error(
      "provider credential isolation check failed before external-model access",
    );
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

export async function assertNoProviderCredentialInEvidence(
  root: string,
  secrets: readonly string[],
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
      const contents = await readFile(path);
      if (needles.some((needle) => contents.includes(needle))) {
        throw new Error(
          "provider credential isolation check failed: a credential appeared in evidence",
        );
      }
    }
  }

  await visit(root);
}
