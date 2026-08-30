import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { DashboardBuildManifestV1 } from "./render.js";

export interface DashboardDocumentFiles {
  readonly html: string;
  readonly stylesheet: string;
  readonly manifest: DashboardBuildManifestV1;
}

function manifestJson(manifest: DashboardBuildManifestV1): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function assertExistingSite(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("dashboard output must be a real directory");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    names.join("\n") !== "index.html\nstyles.css" ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) {
    throw new Error("dashboard output must contain exactly two regular files");
  }
}

export async function writeCompleteDashboardSite(input: {
  readonly outputDirectory: string;
  readonly manifestPath: string;
  readonly document: DashboardDocumentFiles;
}): Promise<void> {
  const outputDirectory = resolve(input.outputDirectory);
  const manifestPath = resolve(input.manifestPath);
  const parent = dirname(outputDirectory);
  const temporaryDirectory = join(
    parent,
    `.${basename(outputDirectory)}-${process.pid}-${Date.now()}`,
  );
  const temporaryManifestPath = join(
    dirname(manifestPath),
    `.${basename(manifestPath)}-${process.pid}-${Date.now()}`,
  );
  await mkdir(parent, { recursive: true });
  await Promise.all([
    rm(temporaryDirectory, { recursive: true, force: true }),
    rm(temporaryManifestPath, { force: true }),
  ]);
  await mkdir(temporaryDirectory, { recursive: false });
  try {
    await Promise.all([
      writeFile(join(temporaryDirectory, "index.html"), input.document.html, {
        encoding: "utf8",
        flag: "wx",
      }),
      writeFile(
        join(temporaryDirectory, "styles.css"),
        input.document.stylesheet,
        { encoding: "utf8", flag: "wx" },
      ),
      writeFile(temporaryManifestPath, manifestJson(input.document.manifest), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      }),
    ]);
    await assertExistingSite(temporaryDirectory);
    await rm(outputDirectory, { recursive: true, force: true });
    await rename(temporaryDirectory, outputDirectory);
    await rename(temporaryManifestPath, manifestPath);
  } catch (error) {
    await Promise.all([
      rm(temporaryDirectory, { recursive: true, force: true }),
      rm(temporaryManifestPath, { force: true }),
    ]);
    throw error;
  }
}

export async function replaceDashboardIndex(input: {
  readonly outputDirectory: string;
  readonly manifestPath: string;
  readonly document: DashboardDocumentFiles;
}): Promise<"changed" | "unchanged"> {
  const outputDirectory = resolve(input.outputDirectory);
  const manifestPath = resolve(input.manifestPath);
  await assertExistingSite(outputDirectory);
  const indexPath = join(outputDirectory, "index.html");
  const stylesheetPath = join(outputDirectory, "styles.css");
  const [previousHtml, currentStylesheet] = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(stylesheetPath, "utf8"),
  ]);
  if (currentStylesheet !== input.document.stylesheet) {
    throw new Error(
      "dashboard stylesheet differs from the reviewed source; rebuild before refresh",
    );
  }
  if (previousHtml === input.document.html) {
    const receiptSuffix = `${process.pid}-${Date.now()}`;
    const nextManifestPath = join(
      dirname(manifestPath),
      `.${basename(manifestPath)}-${receiptSuffix}`,
    );
    try {
      await writeFile(
        nextManifestPath,
        manifestJson(input.document.manifest),
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await rename(nextManifestPath, manifestPath);
    } finally {
      await rm(nextManifestPath, { force: true });
    }
    return "unchanged";
  }

  const suffix = `${process.pid}-${Date.now()}`;
  const outputParent = dirname(outputDirectory);
  const outputName = basename(outputDirectory);
  const nextIndexPath = join(
    outputParent,
    `.${outputName}-index-${suffix}`,
  );
  const rollbackIndexPath = join(
    outputParent,
    `.${outputName}-rollback-${suffix}`,
  );
  const nextManifestPath = join(
    dirname(manifestPath),
    `.${basename(manifestPath)}-${suffix}`,
  );
  try {
    await Promise.all([
      writeFile(nextIndexPath, input.document.html, {
        encoding: "utf8",
        flag: "wx",
      }),
      writeFile(nextManifestPath, manifestJson(input.document.manifest), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      }),
    ]);
    await rename(nextIndexPath, indexPath);
    try {
      await rename(nextManifestPath, manifestPath);
    } catch (manifestError) {
      try {
        await writeFile(rollbackIndexPath, previousHtml, {
          encoding: "utf8",
          flag: "wx",
        });
        await rename(rollbackIndexPath, indexPath);
      } catch (rollbackError) {
        throw new AggregateError(
          [manifestError, rollbackError],
          "dashboard receipt update failed and the page rollback also failed",
        );
      }
      throw manifestError;
    }
    return "changed";
  } finally {
    await Promise.all([
      rm(nextIndexPath, { force: true }),
      rm(rollbackIndexPath, { force: true }),
      rm(nextManifestPath, { force: true }),
    ]);
  }
}
