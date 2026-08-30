import { describe, expect, it } from "vitest";

import {
  PHASE1_TARGET_VERIFICATION_LIMITS,
  verifyTargetIdentity,
} from "../../src/audit/v2/target.js";
import { loadManualFixtureInputs } from "../helpers/evidence-first-v2.js";

describe("Evidence-First V2 target verification", () => {
  it("requires the runtime working directory to be the exact target root", async () => {
    const fixture = await loadManualFixtureInputs();
    expect(
      verifyTargetIdentity(fixture.compileInput.target).runtimeDescriptor.cwd,
    ).toBe("/opt/target");

    for (const cwd of ["/opt/target/", "/opt/target/subdirectory", "."]) {
      expect(() =>
        verifyTargetIdentity({
          ...fixture.compileInput.target,
          runtimeDescriptor: { ...fixture.runtimeDescriptor, cwd },
        }),
      ).toThrow();
    }
  });

  it("rejects target identity accessors without invoking them", async () => {
    const fixture = await loadManualFixtureInputs();
    const accessorIdentity = { ...fixture.target };
    let getterCalls = 0;
    Object.defineProperty(accessorIdentity, "targetId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return fixture.target.targetId;
      },
    });

    expect(() =>
      verifyTargetIdentity({
        ...fixture.compileInput.target,
        identity: accessorIdentity,
      }),
    ).toThrow();
    expect(getterCalls).toBe(0);
  });

  it("checks controller per-artifact and aggregate byte ceilings before copying", async () => {
    const fixture = await loadManualFixtureInputs();
    const sourceBytes = fixture.compileInput.target.sourceArtifactBytes;
    const runtimeBytes = fixture.compileInput.target.runtimeSnapshotBytes;
    const aggregateBytes = sourceBytes.byteLength + runtimeBytes.byteLength;

    expect(() =>
      verifyTargetIdentity(
        fixture.compileInput.target,
        Math.max(sourceBytes.byteLength, runtimeBytes.byteLength),
        aggregateBytes - 1,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "bounds_exceeded",
        message: expect.stringContaining("aggregate ceiling"),
      }),
    );
    expect(PHASE1_TARGET_VERIFICATION_LIMITS.maxArtifactBytes).toBeLessThan(
      1_073_741_824,
    );
  });

  it("rejects byte-array subclasses and ignores shadowed length accessors", async () => {
    const fixture = await loadManualFixtureInputs();
    class MisreportedBytes extends Uint8Array {
      public override get byteLength(): number {
        return 0;
      }
    }
    const subclass = new MisreportedBytes(
      fixture.compileInput.target.sourceArtifactBytes,
    );
    expect(() =>
      verifyTargetIdentity({
        ...fixture.compileInput.target,
        sourceArtifactBytes: subclass,
      }),
    ).toThrow("detached byte arrays");

    const exact = new Uint8Array(
      fixture.compileInput.target.sourceArtifactBytes,
    );
    let getterCalls = 0;
    Object.defineProperty(exact, "byteLength", {
      get() {
        getterCalls += 1;
        return 0;
      },
    });
    const runtimeLength =
      fixture.compileInput.target.runtimeSnapshotBytes.byteLength;
    expect(() =>
      verifyTargetIdentity(
        {
          ...fixture.compileInput.target,
          sourceArtifactBytes: exact,
        },
        exact.length,
        exact.length + runtimeLength - 1,
      ),
    ).toThrow("aggregate ceiling");
    expect(getterCalls).toBe(0);
  });
});
