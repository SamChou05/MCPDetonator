import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mountPathMappings } from "../../src/observe/path-mappings.js";

describe("host bind path mappings", () => {
  it("deduplicates direct paths and includes lexical and resolved symlink aliases", async () => {
    const temporaryRoot = await realpath(
      await mkdtemp(join(tmpdir(), "forge-path-mappings-")),
    );
    const realDirectory = join(temporaryRoot, "real-directory");
    const linkedDirectory = join(temporaryRoot, "linked-directory");

    try {
      await mkdir(realDirectory);
      await symlink(
        realDirectory,
        linkedDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );

      await expect(
        mountPathMappings(realDirectory, "/sandbox/workspace"),
      ).resolves.toEqual([
        {
          observedPrefix: realDirectory,
          containerPrefix: "/sandbox/workspace",
        },
        {
          observedPrefix: `/run/host_virtiofs${realDirectory}`,
          containerPrefix: "/sandbox/workspace",
        },
      ]);

      await expect(
        mountPathMappings(linkedDirectory, "/sandbox/workspace"),
      ).resolves.toEqual([
        {
          observedPrefix: linkedDirectory,
          containerPrefix: "/sandbox/workspace",
        },
        {
          observedPrefix: realDirectory,
          containerPrefix: "/sandbox/workspace",
        },
        {
          observedPrefix: `/run/host_virtiofs${linkedDirectory}`,
          containerPrefix: "/sandbox/workspace",
        },
        {
          observedPrefix: `/run/host_virtiofs${realDirectory}`,
          containerPrefix: "/sandbox/workspace",
        },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
