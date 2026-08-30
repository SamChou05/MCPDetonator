import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { z } from "zod";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function safeArtifactPath(root: string, artifactPath: string): string {
  if (isAbsolute(artifactPath)) {
    throw new Error("evidence artifact path must be relative");
  }

  const absoluteRoot = resolve(root);
  const absoluteArtifact = resolve(absoluteRoot, artifactPath);
  const relation = relative(absoluteRoot, absoluteArtifact);

  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error("evidence artifact path escapes the run directory");
  }

  return absoluteArtifact;
}

function validateRunId(runId: string): void {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("evidence run ID must be a non-empty path component");
  }

  if (
    runId === "." ||
    runId === ".." ||
    Buffer.byteLength(runId, "utf8") > 255 ||
    /[\u0000-\u001f\u007f]/u.test(runId) ||
    isAbsolute(runId) ||
    runId.includes("/") ||
    runId.includes("\\")
  ) {
    throw new Error("evidence run ID must be one relative path component");
  }
}

export class EvidenceStore {
  public readonly runDirectory: string;

  private constructor(runDirectory: string) {
    this.runDirectory = runDirectory;
  }

  public static async create(outputRoot: string, runId: string): Promise<EvidenceStore> {
    validateRunId(runId);

    const absoluteOutputRoot = resolve(outputRoot);
    const runDirectory = safeArtifactPath(absoluteOutputRoot, runId);
    await mkdir(absoluteOutputRoot, { recursive: true, mode: 0o700 });
    await mkdir(runDirectory, { recursive: false, mode: 0o700 });

    try {
      await mkdir(resolve(runDirectory, "raw"), { mode: 0o700 });
    } catch (setupError) {
      try {
        await rmdir(runDirectory);
      } catch (cleanupError) {
        throw new AggregateError(
          [setupError, cleanupError],
          "failed to create the raw evidence directory and remove the incomplete run directory",
        );
      }
      throw setupError;
    }

    return new EvidenceStore(runDirectory);
  }

  public pathFor(artifactPath: string): string {
    return safeArtifactPath(this.runDirectory, artifactPath);
  }

  public async writeJson<T>(
    artifactPath: string,
    schema: z.ZodType<T>,
    value: T,
  ): Promise<string> {
    const validated = schema.parse(value);
    const destination = safeArtifactPath(this.runDirectory, artifactPath);
    await mkdir(dirname(destination), { recursive: true });

    const temporary = `${destination}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);

    try {
      await file.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }

    await rename(temporary, destination);
    return destination;
  }

  public async appendJsonl<T>(
    artifactPath: string,
    schema: z.ZodType<T>,
    value: T,
  ): Promise<string> {
    const validated = schema.parse(value);
    const destination = safeArtifactPath(this.runDirectory, artifactPath);
    await mkdir(dirname(destination), { recursive: true });

    const file = await open(destination, "a", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }

    return destination;
  }

  public async writeJsonl<T>(
    artifactPath: string,
    schema: z.ZodType<T>,
    values: readonly T[],
  ): Promise<string> {
    const validated = values.map((value) => schema.parse(value));
    const destination = safeArtifactPath(this.runDirectory, artifactPath);
    await mkdir(dirname(destination), { recursive: true });

    const temporary = `${destination}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      const contents = validated.map((value) => JSON.stringify(value)).join("\n");
      await file.writeFile(contents.length === 0 ? "" : `${contents}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }

    await rename(temporary, destination);
    return destination;
  }
}
