import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertNoProviderCredentialInEvidence,
  assertNoProviderCredentialInValue,
  redactProviderCredentials,
} from "../../src/agent/redaction.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("agent provider credential isolation", () => {
  it("redacts every occurrence without exposing the credential in its marker", () => {
    const key = "openrouter-secret-key";
    expect(
      redactProviderCredentials(`Bearer ${key}; repeated=${key}`, [key]),
    ).toBe(
      "Bearer [REDACTED_PROVIDER_CREDENTIAL]; repeated=[REDACTED_PROVIDER_CREDENTIAL]",
    );
  });

  it("rejects a credential in structured provider-bound input", () => {
    expect(() =>
      assertNoProviderCredentialInValue(
        { task: "use openrouter-secret-key", nested: ["safe"] },
        ["openrouter-secret-key"],
      ),
    ).toThrow("before external-model access");
    expect(() =>
      assertNoProviderCredentialInValue(
        { task: "synthetic only" },
        ["openrouter-secret-key"],
      ),
    ).not.toThrow();
  });

  it("recursively rejects evidence containing a provider credential", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "forge-agent-redaction-"));
    temporaryDirectories.push(root);
    await mkdir(resolve(root, "nested"));
    await writeFile(resolve(root, "nested", "transcript.jsonl"), "safe\n");

    await expect(
      assertNoProviderCredentialInEvidence(root, ["openrouter-secret-key"]),
    ).resolves.toBeUndefined();

    await writeFile(
      resolve(root, "nested", "provider-error.txt"),
      "openrouter-secret-key",
    );
    await expect(
      assertNoProviderCredentialInEvidence(root, ["openrouter-secret-key"]),
    ).rejects.toThrow("credential appeared in evidence");
  });

  it("ignores empty and dangerously short redaction tokens", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "forge-agent-redaction-short-"));
    temporaryDirectories.push(root);
    await writeFile(resolve(root, "evidence.txt"), "normal text containing abc");

    expect(redactProviderCredentials("normal text", ["", "abc"])).toBe(
      "normal text",
    );
    await expect(
      assertNoProviderCredentialInEvidence(root, ["", "abc"]),
    ).resolves.toBeUndefined();
  });
});
