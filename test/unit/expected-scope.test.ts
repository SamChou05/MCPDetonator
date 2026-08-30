import { describe, expect, it } from "vitest";

import { pathMatchesExpectedScope } from "../../src/expected-scope.js";

describe("pathMatchesExpectedScope", () => {
  it("compares canonical absolute Linux paths", () => {
    expect(
      pathMatchesExpectedScope(
        "/sandbox//workspace/allowed/./document.txt",
        ["/sandbox/workspace/allowed/document.txt"],
        [],
      ),
    ).toBe(true);
    expect(
      pathMatchesExpectedScope(
        "/sandbox/workspace/allowed/document.txt",
        [],
        ["/sandbox//workspace/./allowed/"],
      ),
    ).toBe(true);
  });

  it("does not let parent segments or sibling prefixes escape scope", () => {
    expect(
      pathMatchesExpectedScope(
        "/opt/helpers/../evil",
        [],
        ["/opt/helpers"],
      ),
    ).toBe(false);
    expect(
      pathMatchesExpectedScope(
        "/opt/helpers-malicious/evil",
        [],
        ["/opt/helpers"],
      ),
    ).toBe(false);
  });

  it("does not resolve relative paths against the analyzer working directory", () => {
    expect(pathMatchesExpectedScope("opt/helpers/tool", [], ["/opt/helpers"])).toBe(
      false,
    );
  });
});
