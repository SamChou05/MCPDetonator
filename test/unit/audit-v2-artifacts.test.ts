import { describe, expect, it } from "vitest";

import {
  artifactReferenceFromBytes,
  materializeSyntheticResources,
  verifyArtifactReference,
  V2_RESOURCE_MATERIALIZATION_LIMITS,
} from "../../src/audit/v2/artifacts.js";
import { canonicalizeJson } from "../../src/audit/v2/canonical.js";
import { V2CompileError } from "../../src/audit/v2/errors.js";

describe("Evidence-First V2 artifact materialization", () => {
  it("materializes and hashes a concrete resource per case and repetition", () => {
    const materialized = materializeSyntheticResources({
      manifestId: "materialization-test",
      resources: [
        {
          alias: "profile.document",
          resourceClass: "ordinary_synthetic_file",
          mediaType: "text/plain; charset=utf-8",
          content: "synthetic content",
        },
      ],
      cases: [
        { caseId: "case-r1", repetition: 1, aliases: ["profile.document"] },
        { caseId: "case-r2", repetition: 2, aliases: ["profile.document"] },
      ],
      maxFileBytes: 1024,
      maxWritableBytes: 2048,
      maxWritableFiles: 2,
    });

    expect(materialized.manifest.instances).toHaveLength(2);
    expect(
      new Set(materialized.manifest.instances.map((item) => item.caseId)),
    ).toEqual(new Set(["case-r1", "case-r2"]));
    expect(
      new Set(materialized.manifest.instances.map((item) => item.resourceId)).size,
    ).toBe(2);
    for (const instance of materialized.manifest.instances) {
      const bytes = materialized.bytesByResourceId.get(instance.resourceId);
      expect(bytes).toBeDefined();
      expect(verifyArtifactReference(instance.artifact, bytes!)).toEqual(
        instance.artifact,
      );
    }
  });

  it("canonicalizes strict JSON resources before hashing", () => {
    const materialized = materializeSyntheticResources({
      manifestId: "json-materialization",
      resources: [
        {
          alias: "structured.input",
          resourceClass: "structured_data",
          mediaType: "application/json",
          content: '{"z":1,"a":{"second":2,"first":1}}',
        },
      ],
      cases: [
        { caseId: "json-case", repetition: 1, aliases: ["structured.input"] },
      ],
      maxFileBytes: 1024,
      maxWritableBytes: 1024,
      maxWritableFiles: 1,
    });
    const instance = materialized.manifest.instances[0]!;
    const bytes = materialized.bytesByResourceId.get(instance.resourceId)!;
    expect(Buffer.from(bytes).toString("utf8")).toBe(
      canonicalizeJson({ z: 1, a: { second: 2, first: 1 } }),
    );
  });

  it("hashes only exact detached byte arrays", () => {
    class MisreportedBytes extends Uint8Array {
      public override get byteLength(): number {
        return 0;
      }
    }
    const input = {
      artifactId: "exact-bytes",
      kind: "synthetic_resource" as const,
      mediaType: "text/plain; charset=utf-8" as const,
    };
    expect(() =>
      artifactReferenceFromBytes(
        input,
        new MisreportedBytes(Uint8Array.from([1, 2, 3])),
      ),
    ).toThrow("exact, unshared byte array");

    const exact = Uint8Array.from([1, 2, 3]);
    let getterCalls = 0;
    Object.defineProperty(exact, "byteLength", {
      get() {
        getterCalls += 1;
        return 0;
      },
    });
    expect(artifactReferenceFromBytes(input, exact).byteLength).toBe(3);
    expect(getterCalls).toBe(0);
  });

  it("exposes immutable resource maps and copy-on-read bytes", () => {
    const materialized = materializeSyntheticResources({
      manifestId: "immutable-resources",
      resources: [
        {
          alias: "profile.document",
          resourceClass: "ordinary_synthetic_file",
          mediaType: "text/plain; charset=utf-8",
          content: "immutable content",
        },
      ],
      cases: [
        { caseId: "immutable-case", repetition: 1, aliases: ["profile.document"] },
      ],
      maxFileBytes: 1024,
      maxWritableBytes: 1024,
      maxWritableFiles: 1,
    });
    const instance = materialized.manifest.instances[0]!;
    const writableBytes = materialized.bytesByResourceId as Map<
      string,
      Uint8Array
    >;
    expect(writableBytes.set).toBeUndefined();
    expect(() =>
      writableBytes.set("injected", new Uint8Array([1])),
    ).toThrow(TypeError);

    const firstRead = materialized.bytesByResourceId.get(instance.resourceId)!;
    const expectedBytes = new Uint8Array(firstRead);
    firstRead.fill(0);
    expect(materialized.bytesByResourceId.get(instance.resourceId)).toEqual(
      expectedBytes,
    );

    const iteratedBytes = [...materialized.bytesByResourceId.values()][0]!;
    iteratedBytes.fill(1);
    expect(materialized.bytesByResourceId.get(instance.resourceId)).toEqual(
      expectedBytes,
    );

    const caseResources = materialized.resourcesByCaseId.get("immutable-case")!;
    const writableCases = materialized.resourcesByCaseId as Map<
      string,
      ReadonlyMap<string, { alias: string; containerPath: string }>
    >;
    expect(writableCases.set).toBeUndefined();
    expect(() => writableCases.set("injected", caseResources)).toThrow(
      TypeError,
    );
    const writableResources = caseResources as Map<
      string,
      { alias: string; containerPath: string }
    >;
    expect(writableResources.set).toBeUndefined();
    expect(() =>
      writableResources.set("injected", {
        alias: "injected",
        containerPath: "/forge/synthetic/injected",
      }),
    ).toThrow(TypeError);
    expect(Object.isFrozen(caseResources.get("profile.document"))).toBe(true);
  });

  it("rejects duplicate-key JSON and unknown aliases", () => {
    expect(() =>
      materializeSyntheticResources({
        manifestId: "duplicate-json",
        resources: [
          {
            alias: "structured.input",
            resourceClass: "structured_data",
            mediaType: "application/json",
            content: '{"a":1,"\\u0061":2}',
          },
        ],
        cases: [
          {
            caseId: "duplicate-case",
            repetition: 1,
            aliases: ["structured.input"],
          },
        ],
        maxFileBytes: 1024,
        maxWritableBytes: 1024,
        maxWritableFiles: 1,
      }),
    ).toThrow("duplicate_key");

    expect(() =>
      materializeSyntheticResources({
        manifestId: "unknown-alias",
        resources: [],
        cases: [
          { caseId: "unknown-case", repetition: 1, aliases: ["missing"] },
        ],
        maxFileBytes: 1024,
        maxWritableBytes: 1024,
        maxWritableFiles: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "resource_unknown" }));
  });

  it("enforces file, cumulative byte, and file-count bounds", () => {
    const common = {
      manifestId: "bounded-resources",
      resources: [
        {
          alias: "profile.document",
          resourceClass: "ordinary_synthetic_file" as const,
          mediaType: "text/plain; charset=utf-8" as const,
          content: "0123456789",
        },
      ],
      cases: [
        { caseId: "case-1", repetition: 1, aliases: ["profile.document"] },
        { caseId: "case-2", repetition: 2, aliases: ["profile.document"] },
      ],
    };
    expect(() =>
      materializeSyntheticResources({
        ...common,
        maxFileBytes: 9,
        maxWritableBytes: 100,
        maxWritableFiles: 2,
      }),
    ).toThrowError(V2CompileError);
    expect(() =>
      materializeSyntheticResources({
        ...common,
        maxFileBytes: 10,
        maxWritableBytes: 19,
        maxWritableFiles: 2,
      }),
    ).toThrowError(V2CompileError);
    expect(() =>
      materializeSyntheticResources({
        ...common,
        maxFileBytes: 10,
        maxWritableBytes: 20,
        maxWritableFiles: 1,
      }),
    ).toThrowError(V2CompileError);
  });

  it("applies the controller resource-instance ceiling before expansion", () => {
    const requested = Array.from(
      { length: V2_RESOURCE_MATERIALIZATION_LIMITS.maxInstances + 1 },
      (_, index) => ({
        caseId: `case-${index}`,
        repetition: 1,
        aliases: ["profile.document"],
      }),
    );
    expect(() =>
      materializeSyntheticResources({
        manifestId: "controller-resource-cap",
        resources: [
          {
            alias: "profile.document",
            resourceClass: "ordinary_synthetic_file",
            mediaType: "text/plain; charset=utf-8",
            content: "x",
          },
        ],
        cases: requested,
        maxFileBytes: Number.MAX_SAFE_INTEGER,
        maxWritableBytes: Number.MAX_SAFE_INTEGER,
        maxWritableFiles: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "bounds_exceeded",
        message: expect.stringContaining("instance ceiling"),
      }),
    );
  });

  it("detects detached artifact mutation", () => {
    const original = Buffer.from("original", "utf8");
    const reference = artifactReferenceFromBytes(
      {
        artifactId: "detached-artifact",
        kind: "source_bundle",
        mediaType: "application/json",
      },
      original,
    );
    expect(() =>
      verifyArtifactReference(reference, Buffer.from("mutated!", "utf8")),
    ).toThrowError(expect.objectContaining({ code: "artifact_mismatch" }));
  });

  it("rejects an artifact reference with a mismatched byte length", () => {
    const bytes = Buffer.from("length-bound", "utf8");
    const reference = artifactReferenceFromBytes(
      {
        artifactId: "length-bound-artifact",
        kind: "source_bundle",
        mediaType: "application/json",
      },
      bytes,
    );

    expect(() =>
      verifyArtifactReference(
        { ...reference, byteLength: reference.byteLength + 1 },
        bytes,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "artifact_mismatch",
        message: expect.stringContaining("byte length"),
      }),
    );
  });
});
