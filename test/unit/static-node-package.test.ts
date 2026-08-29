import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { EvidenceStore } from "../../src/evidence-store.js";
import {
  nodePackageStaticInspectionV1Schema,
  staticFileEvidenceV1Schema,
} from "../../src/static/contracts.js";
import { inspectNodePackage } from "../../src/static/node-package.js";

async function createPackage(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forge-static-package-"));
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
  return root;
}

async function createStore(runId: string): Promise<EvidenceStore> {
  const output = await mkdtemp(join(tmpdir(), "forge-static-evidence-"));
  return EvidenceStore.create(output, runId);
}

describe("generic Node package static inspection", () => {
  it("extracts package claims, lock metadata, and evidence-linked capabilities", async () => {
    const packageRoot = await createPackage({
      "package.json": JSON.stringify(
        {
          name: "@random-labs/quokka-runner",
          version: "4.7.2",
          private: false,
          type: "module",
          packageManager: "npm@11.5.1",
          repository: { type: "git", url: "https://example.test/random/quokka.git" },
          main: "dist/index.js",
          types: "dist/index.d.ts",
          bin: { quokka: "dist/cli.js" },
          scripts: {
            test: "vitest run",
            postinstall: "node scripts/prepare.js",
          },
          dependencies: { alpha: "1.2.3" },
          optionalDependencies: { "native-helper": "2.0.0" },
          peerDependencies: { host: ">=3" },
          devDependencies: { compiler: "5.0.0" },
          engines: { node: ">=22" },
        },
        null,
        2,
      ),
      "package-lock.json": JSON.stringify({
        name: "@random-labs/quokka-runner",
        lockfileVersion: 3,
        packages: {
          "": {},
          "node_modules/alpha": {
            resolved: "https://registry.example.test/alpha.tgz",
            integrity: "sha512-test",
          },
        },
      }),
      "src/worker.ts": [
        'import { readFile } from "node:fs/promises";',
        'import { spawn } from "node:child_process";',
        'import * as https from "node:https";',
        "const selected = process.env.SELECTED_MODULE;",
        "await fetch(endpoint);",
        "await import(selected);",
        'eval("void 0");',
        'require("./binding.node");',
      ].join("\n"),
    });
    const store = await createStore("run-static-1");

    const inspection = await inspectNodePackage({
      store,
      runId: "run-static-1",
      targetId: "quokka",
      packageRoot,
    });

    expect(() => nodePackageStaticInspectionV1Schema.parse(inspection)).not.toThrow();
    expect(inspection.manifest.status).toBe("parsed");
    if (inspection.manifest.status !== "parsed") {
      throw new Error("expected a parsed manifest");
    }
    expect(inspection.manifest.claims).toMatchObject({
      name: "@random-labs/quokka-runner",
      version: "4.7.2",
      packageManager: "npm@11.5.1",
      repository: "https://example.test/random/quokka.git",
    });
    expect(inspection.manifest.claims.scripts).toContainEqual({
      name: "postinstall",
      command: "node scripts/prepare.js",
      installLifecycle: true,
    });
    expect(inspection.manifest.claims.dependencies).toEqual(
      expect.arrayContaining([
        { name: "alpha", specifier: "1.2.3", kind: "runtime" },
        { name: "compiler", specifier: "5.0.0", kind: "development" },
        { name: "native-helper", specifier: "2.0.0", kind: "optional" },
        { name: "host", specifier: ">=3", kind: "peer" },
      ]),
    );
    expect(inspection.lockfiles).toHaveLength(1);
    expect(inspection.lockfiles[0]).toMatchObject({
      path: "package-lock.json",
      format: "npm-package-lock",
      metadata: {
        parseStatus: "parsed",
        lockfileVersion: 3,
        packageEntries: 2,
        resolvedEntries: 1,
        integrityEntries: 1,
      },
    });
    expect(inspection.provenanceHints.map((hint) => hint.kind)).toEqual([
      "lockfile",
      "package_manager",
      "repository",
    ]);

    const capabilities = new Set(
      inspection.source.signals.map((signal) => signal.capability),
    );
    expect(capabilities).toEqual(
      new Set([
        "filesystem_access",
        "process_execution",
        "network_access",
        "environment_access",
        "dynamic_code_execution",
        "dynamic_module_loading",
        "native_code_loading",
      ]),
    );
    for (const signal of inspection.source.signals) {
      expect(signal.evidence.targetPath).toBe("src/worker.ts");
      expect(signal.evidence.line).toBeGreaterThan(0);
      expect(signal.evidence.artifactPath).toMatch(/^raw\/static\//);
      const raw = JSON.parse(
        await readFile(store.pathFor(signal.evidence.artifactPath), "utf8"),
      );
      expect(() => staticFileEvidenceV1Schema.parse(raw)).not.toThrow();
      expect(raw.sha256).toBe(signal.evidence.sha256);
    }
  });

  it("does not turn comments or string documentation into source signals", async () => {
    const packageRoot = await createPackage({
      "package.json": JSON.stringify({ name: "ordinary-library", version: "1.0.0" }),
      "src/safe.js": [
        '// import { spawn } from "node:child_process";',
        'const documentation = "process.env, fetch(url), eval(code), and require(unknown)";',
        '/* require("node:fs") */',
        "export const value = 7;",
      ].join("\n"),
    });
    const store = await createStore("run-static-2");

    const inspection = await inspectNodePackage({
      store,
      runId: "run-static-2",
      targetId: "ordinary-library",
      packageRoot,
    });

    expect(inspection.source.signals).toEqual([]);
  });

  it("keeps target names out of capability logic and safely skips source symlinks", async () => {
    const source = [
      'const fs = require("node:fs");',
      "const secret = process.env.TOKEN;",
      "export { fs, secret };",
    ].join("\n");
    const firstRoot = await createPackage({
      "package.json": JSON.stringify({ name: "weather-station", version: "1.0.0" }),
      "src/index.js": source,
    });
    const secondRoot = await createPackage({
      "package.json": JSON.stringify({ name: "invoice-printer", version: "9.8.7" }),
      "src/index.js": source,
    });
    await symlink(join(firstRoot, "src/index.js"), join(firstRoot, "src/linked.js"));
    const firstStore = await createStore("run-static-3a");
    const secondStore = await createStore("run-static-3b");

    const first = await inspectNodePackage({
      store: firstStore,
      runId: "run-static-3a",
      targetId: "weather-station",
      packageRoot: firstRoot,
    });
    const second = await inspectNodePackage({
      store: secondStore,
      runId: "run-static-3b",
      targetId: "invoice-printer",
      packageRoot: secondRoot,
    });

    const semantics = (inspection: typeof first) =>
      inspection.source.signals.map((signal) => ({
        capability: signal.capability,
        patternId: signal.patternId,
        line: signal.evidence.line,
      }));
    expect(semantics(first)).toEqual(semantics(second));
    expect(first.source.skippedFiles).toContainEqual({
      path: "src/linked.js",
      reason: "symlink",
    });
    expect(JSON.stringify(first.source.signals)).not.toContain("weather-station");
    expect(JSON.stringify(second.source.signals)).not.toContain("invoice-printer");
  });

  it("returns evidence for malformed manifests instead of executing or trusting them", async () => {
    const packageRoot = await createPackage({
      "package.json": '{"name":"broken", this is not JSON}',
      "index.js": "export const value = process.env.VALUE;",
    });
    const store = await createStore("run-static-4");

    const inspection = await inspectNodePackage({
      store,
      runId: "run-static-4",
      targetId: "broken-package",
      packageRoot,
    });

    expect(inspection.manifest.status).toBe("invalid");
    expect(inspection.source.signals).toHaveLength(1);
    expect(inspection.source.signals[0]?.capability).toBe("environment_access");
    expect(
      JSON.parse(await readFile(store.pathFor("static/inspection.json"), "utf8")),
    ).toEqual(inspection);
  });

  it("preserves a named inspection artifact for a distinct snapshot stage", async () => {
    const packageRoot = await createPackage({
      "package.json": JSON.stringify({ name: "staged-package", version: "1.0.0" }),
      "index.js": "export const value = 1;",
    });
    const store = await createStore("run-static-stage");
    const artifactPath = "static/pre-install-inspection.json";

    const inspection = await inspectNodePackage({
      store,
      runId: "run-static-stage",
      targetId: "staged-package",
      packageRoot,
      artifactPath,
    });

    expect(
      JSON.parse(await readFile(store.pathFor(artifactPath), "utf8")),
    ).toEqual(inspection);
  });
});
