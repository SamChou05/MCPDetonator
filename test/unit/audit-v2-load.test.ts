import { describe, expect, it } from "vitest";

import {
  parseV2ArtifactJson,
  parseV2ArtifactValue,
} from "../../src/audit/v2/load.js";
import { loadManualFixtureInputs } from "../helpers/evidence-first-v2.js";

describe("Evidence-First V2 artifact loading boundary", () => {
  it("selects and validates a known strict top-level schema", async () => {
    const fixture = await loadManualFixtureInputs();
    const encoded = JSON.stringify(fixture.policy);
    expect(parseV2ArtifactJson(encoded)).toEqual(fixture.policy);
    expect(parseV2ArtifactValue(fixture.claimProfile)).toEqual(
      fixture.claimProfile,
    );
  });

  it("rejects duplicate keys before Zod can erase them", async () => {
    const fixture = await loadManualFixtureInputs();
    const encoded = JSON.stringify(fixture.policy).replace(
      '"policyId":"manual-audit-policy"',
      '"policyId":"manual-audit-policy","\\u0070olicyId":"substituted"',
    );
    expect(() => parseV2ArtifactJson(encoded)).toThrowError(
      expect.objectContaining({ code: "duplicate_key" }),
    );
  });

  it("rejects unknown versions, unknown fields, and accessor values", async () => {
    const fixture = await loadManualFixtureInputs();
    expect(() =>
      parseV2ArtifactValue({ ...fixture.policy, schema: "forge.audit-policy/v3" }),
    ).toThrow("unknown or missing");
    expect(() =>
      parseV2ArtifactValue({ ...fixture.policy, extra: "not allowed" }),
    ).toThrow();

    let invoked = false;
    const accessor = Object.defineProperty({}, "schema", {
      enumerable: true,
      get() {
        invoked = true;
        return "forge.audit-policy/v2";
      },
    });
    expect(() => parseV2ArtifactValue(accessor)).toThrow("non_json_value");
    expect(invoked).toBe(false);
  });
});
