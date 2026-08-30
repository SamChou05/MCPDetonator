import { describe, expect, it } from "vitest";

import { sha256 } from "../../src/evidence-store.js";
import {
  analyzeNodeSemanticSources,
  type NodeSemanticEngineInput,
} from "../../src/static/node-semantic-engine.js";
import { NODE_SEMANTIC_SINKS } from "../../src/static/node-semantic-catalog.js";
import { defaultNodeSemanticLimits } from "../../src/static/node-semantic.js";
import { nodeSemanticStaticV1Schema } from "../../src/static/semantic-contracts.js";

function inputFor(
  files: Readonly<Record<string, string>>,
  overrides: Partial<NodeSemanticEngineInput> = {},
): NodeSemanticEngineInput {
  const sources = Object.entries(files).map(([targetPath, content]) => {
    const digest = sha256(content);
    return {
      targetPath,
      sizeBytes: Buffer.byteLength(content),
      sha256: digest,
      evidence: {
        artifactPath: `raw/static/${sha256(targetPath).slice(0, 12)}.json`,
        targetPath,
        sha256: digest,
      },
      content,
    };
  });
  return {
    runId: "run-semantic",
    targetId: "ordinary-package",
    generatedAt: "2026-08-30T12:00:00.000Z",
    lexicalInspectionArtifact: "static/inspection.json",
    lexicalInspectionSha256: "a".repeat(64),
    sourceSetSha256: "b".repeat(64),
    limits: defaultNodeSemanticLimits,
    sources,
    ...overrides,
  };
}

describe("bounded Node semantic engine", () => {
  it("finds invoked ESM aliases without treating unused imports or shadowed globals as callsites", () => {
    const analysis = analyzeNodeSemanticSources(
      inputFor({
        "src/index.ts": [
          'import { readFile as load, writeFile as unused } from "node:fs/promises";',
          'import * as child from "node:child_process";',
          "const fetch = (url: string) => url;",
          "function eval(value: string) { return value; }",
          'await load("/tmp/input");',
          'fetch("https://example.test");',
          'eval("safe local function");',
          "void unused;",
          'child.spawn("node", ["--version"]);',
        ].join("\n"),
      }),
    );

    expect(analysis.status).toBe("completed");
    expect(analysis.callsites.map((callsite) => callsite.sinkId)).toEqual([
      "node.fs.promises.readFile.call",
      "node.child_process.spawn.call",
    ]);
    expect(analysis.callsites[0]).toMatchObject({
      resolution: "symbol_resolved",
      aliasDepth: 0,
      handlerReachability: "not_assessed",
    });
    expect(JSON.stringify(analysis.callsites)).not.toContain("unused");
  });

  it("resolves bounded CommonJS destructuring, namespace members, and immutable aliases", () => {
    const analysis = analyzeNodeSemanticSources(
      inputFor({
        "index.cjs": [
          'const { spawn: run } = require("child_process");',
          "const first = run;",
          "const second = first;",
          'second("node", ["--version"]);',
          'const filesystem = require("node:fs");',
          "const save = filesystem[\"writeFileSync\"];",
          'save("/tmp/output", "ok");',
          "const method = \"readFileSync\";",
          'filesystem[method]("/tmp/input");',
        ].join("\n"),
      }),
    );

    expect(analysis.callsites.map((callsite) => callsite.sinkId)).toEqual([
      "node.child_process.spawn.call",
      "node.fs.writeFileSync.call",
    ]);
    expect(analysis.callsites.map((callsite) => callsite.aliasDepth)).toEqual([
      2, 1,
    ]);
  });

  it("normalizes named promise namespaces and discloses unsupported nested destructuring", () => {
    const direct = analyzeNodeSemanticSources(
      inputFor({
        "index.ts": [
          'import { promises as filesystem } from "node:fs";',
          'import { promises as resolver } from "node:dns";',
          'await filesystem.readFile("/tmp/input");',
          'await resolver.lookup("example.test");',
        ].join("\n"),
      }),
    );
    expect(direct.status).toBe("completed");
    expect(direct.callsites.map((callsite) => callsite.sinkId)).toEqual([
      "node.fs.promises.readFile.call",
      "node.dns.promises.lookup.call",
    ]);

    const nested = analyzeNodeSemanticSources(
      inputFor({
        "index.cjs": [
          'const { promises: { readFile } } = require("node:fs");',
          'readFile("/tmp/input");',
        ].join("\n"),
      }),
    );
    expect(nested.status).toBe("partial");
    expect(nested.callsites).toEqual([]);
    expect(nested.issues).toContainEqual(
      expect.objectContaining({ kind: "unsupported_binding_flow" }),
    );
  });

  it("does not claim mutable or monkey-patched bindings resolve to a built-in sink", () => {
    const analysis = analyzeNodeSemanticSources(
      inputFor({
        "index.cjs": [
          'const filesystem = require("node:fs");',
          "filesystem.readFileSync = () => \"local\";",
          'filesystem.readFileSync("/tmp/input");',
          'let run = require("node:child_process").spawn;',
          "run = () => undefined;",
          'run("node");',
        ].join("\n"),
      }),
    );

    expect(analysis.callsites).toEqual([]);
    expect(analysis.status).toBe("partial");
    expect(analysis.coverage.resolutionIncomplete).toBe(true);
    expect(analysis.issues).toContainEqual(
      expect.objectContaining({ kind: "unsupported_binding_flow" }),
    );
  });

  it("propagates namespace mutation through immutable aliases and discloses source-order withholding", () => {
    const analysis = analyzeNodeSemanticSources(
      inputFor({
        "index.cjs": [
          'const filesystem = require("node:fs");',
          'filesystem.readFileSync("/tmp/before");',
          "const promises = filesystem.promises;",
          "promises.readFile = () => undefined;",
          'filesystem.promises.readFile("/tmp/after");',
        ].join("\n"),
      }),
    );

    expect(analysis.status).toBe("partial");
    expect(analysis.callsites).toEqual([]);
    expect(analysis.issues).toContainEqual(
      expect.objectContaining({
        kind: "unsupported_binding_flow",
        summary: expect.stringContaining("mutation-affected"),
      }),
    );
  });

  it("models narrow global, environment, dynamic-load, and native-load sinks", () => {
    const analysis = analyzeNodeSemanticSources(
      inputFor({
        "src/runtime.mts": [
          'fetch("https://example.test");',
          'new WebSocket("wss://example.test");',
          'eval("globalThis.answer = 42");',
          'Function("return 42")();',
          "const selected = process.env.SELECTED_MODULE;",
          "await import(selected);",
          'require("./binding.node");',
          "process.dlopen(module, selected);",
        ].join("\n"),
      }),
    );

    expect(new Set(analysis.callsites.map((callsite) => callsite.sinkId))).toEqual(
      new Set([
        "node.global.fetch.call",
        "node.global.WebSocket.construct",
        "node.global.eval.call",
        "node.global.Function.call",
        "node.process.env.access",
        "node.global.import.dynamic",
        "node.global.require.native",
        "node.process.dlopen.call",
      ]),
    );
  });

  it("preserves valid callsites while disclosing syntax and module-resolution gaps", () => {
    const analysis = analyzeNodeSemanticSources(
      inputFor({
        "src/index.ts": [
          'import { readFile } from "node:fs";',
          'import { helper } from "./missing.js";',
          'readFile("/tmp/input", () => undefined);',
          "const broken = ;",
          "void helper;",
        ].join("\n"),
      }),
    );

    expect(analysis.status).toBe("partial");
    expect(analysis.callsites.map((callsite) => callsite.sinkId)).toContain(
      "node.fs.readFile.call",
    );
    expect(analysis.coverage.filesWithSyntaxErrors).toBe(1);
    expect(analysis.coverage.moduleResolutionsUnresolved).toBe(1);
    expect(analysis.coverage.resolutionIncomplete).toBe(true);
    expect(analysis.issues).toContainEqual(
      expect.objectContaining({ kind: "unresolved_relative_module" }),
    );
  });

  it("marks admitted cross-file binding flow as unsupported instead of silently claiming completeness", () => {
    const analysis = analyzeNodeSemanticSources(
      inputFor({
        "src/index.ts": [
          'import { load } from "./helper.js";',
          'load("/tmp/input");',
        ].join("\n"),
        "src/helper.ts": [
          'import { readFile as load } from "node:fs/promises";',
          "export { load };",
        ].join("\n"),
      }),
    );

    expect(analysis.status).toBe("partial");
    expect(analysis.callsites).toEqual([]);
    expect(analysis.issues).toContainEqual(
      expect.objectContaining({ kind: "unsupported_binding_flow" }),
    );
  });

  it("resolves literal built-in dynamic imports but marks relative dynamic binding flow partial", () => {
    const builtin = analyzeNodeSemanticSources(
      inputFor({
        "src/index.mts": [
          'const filesystem = await import("node:fs");',
          'filesystem.readFileSync("/tmp/input");',
        ].join("\n"),
      }),
    );
    expect(builtin.status).toBe("completed");
    expect(builtin.callsites).toEqual([
      expect.objectContaining({
        sinkId: "node.fs.readFileSync.call",
        aliasDepth: 0,
      }),
    ]);

    const relative = analyzeNodeSemanticSources(
      inputFor({
        "src/index.mts": [
          'const helper = await import("./helper.js");',
          "void helper;",
        ].join("\n"),
        "src/helper.ts": "export const value = 1;",
      }),
    );
    expect(relative.status).toBe("partial");
    expect(relative.issues).toContainEqual(
      expect.objectContaining({ kind: "unsupported_binding_flow" }),
    );

    const promised = analyzeNodeSemanticSources(
      inputFor({
        "src/index.mts": [
          'const filesystem = import("node:fs");',
          'filesystem.readFileSync("/tmp/input");',
          'import("node:fs").then((namespace) => namespace.readFileSync("/tmp/input"));',
        ].join("\n"),
      }),
    );
    expect(promised.status).toBe("partial");
    expect(promised.callsites).toEqual([]);
    expect(promised.issues).toContainEqual(
      expect.objectContaining({
        kind: "unsupported_binding_flow",
        summary: expect.stringContaining("Promise-based"),
      }),
    );
  });

  it("resolves wrapped require calls and immutable aliases of modeled globals", () => {
    const analysis = analyzeNodeSemanticSources(
      inputFor({
        "index.cjs": [
          'const filesystem = (require)("node:fs");',
          'filesystem.readFileSync("/tmp/input");',
          "const request = fetch;",
          'request("https://example.test");',
          "const Compile = Function;",
          'new Compile("return 42");',
        ].join("\n"),
      }),
    );

    expect(analysis.status).toBe("completed");
    expect(analysis.callsites.map((callsite) => callsite.sinkId)).toEqual([
      "node.fs.readFileSync.call",
      "node.global.fetch.call",
      "node.global.Function.construct",
    ]);
    expect(analysis.callsites.map((callsite) => callsite.aliasDepth)).toEqual([
      0, 1, 1,
    ]);
  });

  it("resolves immutable require aliases for built-in, dynamic, and native loads", () => {
    const analysis = analyzeNodeSemanticSources(
      inputFor({
        "index.cjs": [
          "const load = require;",
          'const filesystem = load("node:fs");',
          'filesystem.readFileSync("/tmp/input");',
          "const selected = process.env.SELECTED_MODULE;",
          "load(selected);",
          'load("./binding.node");',
        ].join("\n"),
      }),
    );

    expect(analysis.status).toBe("completed");
    expect(new Set(analysis.callsites.map((callsite) => callsite.sinkId))).toEqual(
      new Set([
        "node.fs.readFileSync.call",
        "node.process.env.access",
        "node.global.require.dynamic",
        "node.global.require.native",
      ]),
    );
    expect(
      analysis.callsites
        .filter((callsite) => callsite.sinkId.includes("global.require"))
        .every((callsite) => callsite.aliasDepth === 1),
    ).toBe(true);
  });

  it("withholds directly reassigned unresolved globals instead of publishing false sinks", () => {
    const analysis = analyzeNodeSemanticSources(
      inputFor({
        "index.cjs": [
          "require = () => ({ readFileSync: () => undefined });",
          'require("node:fs").readFileSync("/tmp/input");',
          "fetch = () => undefined;",
          'fetch("https://example.test");',
        ].join("\n"),
      }),
    );

    expect(analysis.status).toBe("partial");
    expect(analysis.callsites).toEqual([]);
    expect(analysis.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "unsupported_binding_flow",
          summary: expect.stringContaining("modeled global"),
        }),
      ]),
    );
  });

  it("enforces alias depth at the exact boundary without converting overflow into worker failure", () => {
    const limits = { ...defaultNodeSemanticLimits, maxAliasDepth: 2 };
    const exact = analyzeNodeSemanticSources(
      inputFor(
        {
          "index.ts": [
            'import { readFileSync as base } from "node:fs";',
            "const first = base;",
            "const second = first;",
            'second("/tmp/input");',
          ].join("\n"),
        },
        { limits },
      ),
    );
    expect(exact.status).toBe("completed");
    expect(exact.callsites[0]).toMatchObject({
      sinkId: "node.fs.readFileSync.call",
      aliasDepth: 2,
    });

    const overflow = analyzeNodeSemanticSources(
      inputFor(
        {
          "index.ts": [
            'import { readFileSync as base } from "node:fs";',
            "const first = base;",
            "const second = first;",
            "const third = second;",
            'third("/tmp/input");',
          ].join("\n"),
        },
        { limits },
      ),
    );
    expect(overflow.status).toBe("partial");
    expect(overflow.callsites).toEqual([]);
    expect(overflow.truncations).toContain("alias_depth");
  });

  it("recognizes wrapped globals, import-equals, globalThis.process, and static native imports", () => {
    const analysis = analyzeNodeSemanticSources(
      inputFor({
        "index.ts": [
          'import filesystem = require("node:fs");',
          'import addon from "./binding.node";',
          '(fetch)("https://example.test");',
          'new (Function)("return 42");',
          'filesystem.readFileSync("/tmp/input");',
          "const selected = globalThis.process.env.SELECTED;",
          "void addon;",
          "void selected;",
        ].join("\n"),
      }),
    );

    expect(new Set(analysis.callsites.map((callsite) => callsite.sinkId))).toEqual(
      new Set([
        "node.global.import.native",
        "node.global.fetch.call",
        "node.global.Function.construct",
        "node.fs.readFileSync.call",
        "node.process.env.access",
      ]),
    );
    expect(analysis.status).toBe("partial");
    expect(analysis.issues).toContainEqual(
      expect.objectContaining({ kind: "unresolved_relative_module" }),
    );
  });

  it("keeps file scopes separate and ignores ambient declarations, shadowed require, type-only imports, and lookalike modules", () => {
    const analysis = analyzeNodeSemanticSources(
      inputFor({
        "globals.d.ts": [
          "declare function fetch(url: string): unknown;",
          "declare function require(specifier: string): unknown;",
          "declare const process: { env: Record<string, string> };",
        ].join("\n"),
        "helper.js": "function fetch(value) { return value; }",
        "relative.js": [
          "function load(require) {",
          '  return require("./admitted.js");',
          "}",
          "void load;",
        ].join("\n"),
        "admitted.js": "export const value = 1;",
        "index.ts": [
          'import type { readFile } from "node:fs";',
          'import { type Binding } from "./binding.node";',
          'import { readFile as lookalike } from "fs-extra";',
          '(fetch)("https://example.test");',
          "const dynamicName = process.env.MODULE_NAME;",
          "require(dynamicName);",
          "void lookalike;",
        ].join("\n"),
      }),
    );

    expect(analysis.status).toBe("completed");
    expect(new Set(analysis.callsites.map((callsite) => callsite.sinkId))).toEqual(
      new Set([
        "node.global.fetch.call",
        "node.process.env.access",
        "node.global.require.dynamic",
      ]),
    );
    expect(analysis.issues).toEqual([]);
  });

  it("is deterministic under reversed Unicode source input order", () => {
    const firstInput = inputFor({
      "src/\u03b2.ts": 'fetch("https://beta.example.test");',
      "src/\u00e9.ts": 'fetch("https://accent.example.test");',
    });
    const first = analyzeNodeSemanticSources(firstInput);
    const reversed = analyzeNodeSemanticSources({
      ...firstInput,
      sources: [...firstInput.sources].reverse(),
    });

    expect(reversed.files).toEqual(first.files);
    expect(reversed.callsites).toEqual(first.callsites);
    expect(reversed.issues).toEqual(first.issues);
  });

  it("keeps catalog IDs and module/member/operation triples unique", () => {
    const ids = NODE_SEMANTIC_SINKS.map((sink) => sink.sinkId);
    const triples = NODE_SEMANTIC_SINKS.map((sink) =>
      [sink.module, sink.member, sink.operation].join("\0"),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(triples).size).toBe(triples.length);
  });

  it("makes callsite IDs content/path based rather than run or target based", () => {
    const files = { "src/index.ts": 'fetch("https://example.test");' };
    const first = analyzeNodeSemanticSources(inputFor(files));
    const second = analyzeNodeSemanticSources(
      inputFor(files, { runId: "another-run", targetId: "another-target" }),
    );
    const changed = analyzeNodeSemanticSources(
      inputFor({
        "src/index.ts": 'fetch("https://example.invalid");',
      }),
    );

    expect(first.callsites[0]?.callsiteId).toBe(second.callsites[0]?.callsiteId);
    expect(first.callsites[0]?.callsiteId).not.toBe(
      changed.callsites[0]?.callsiteId,
    );
  });

  it("rejects forged callsite identities and sink/catalog contradictions", () => {
    const source = analyzeNodeSemanticSources(
      inputFor({ "index.ts": 'fetch("https://example.test");' }),
    );
    const forgedId = structuredClone(source);
    const first = forgedId.callsites[0];
    if (first === undefined) throw new Error("missing semantic test callsite");
    first.callsiteId = "semantic-callsite-forged";
    expect(nodeSemanticStaticV1Schema.safeParse(forgedId).success).toBe(false);

    const forgedCatalog = structuredClone(source);
    const catalogCallsite = forgedCatalog.callsites[0];
    if (catalogCallsite === undefined) {
      throw new Error("missing semantic catalog test callsite");
    }
    catalogCallsite.api.member = "request";
    expect(nodeSemanticStaticV1Schema.safeParse(forgedCatalog).success).toBe(
      false,
    );
  });

  it("records deterministic truncation instead of interpreting exhausted work as absence", () => {
    const analysis = analyzeNodeSemanticSources(
      inputFor(
        {
          "src/index.ts": Array.from(
            { length: 30 },
            (_, index) => `fetch("https://example.test/${index}");`,
          ).join("\n"),
        },
        {
          limits: {
            ...defaultNodeSemanticLimits,
            maxAstNodes: 20,
            maxCallsites: 1,
          },
        },
      ),
    );

    expect(analysis.status).toBe("partial");
    expect(analysis.truncations).toContain("ast_nodes");
    expect(analysis.coverage.resolutionIncomplete).toBe(true);
  });
});
