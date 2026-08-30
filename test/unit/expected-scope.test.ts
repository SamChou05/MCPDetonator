import { describe, expect, it } from "vitest";

import {
  isRoutineNameServiceConnection,
  pathMatchesExpectedScope,
} from "../../src/expected-scope.js";

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

  it("exempts only outbound connections to the routine NSCD Unix sockets", () => {
    const connection = (protocol: "tcp" | "unix", address: string) => ({
      kind: "network.connect_attempt" as const,
      protocol,
      address,
      outcome: { status: "succeeded" as const },
    });

    expect(
      isRoutineNameServiceConnection(
        connection("unix", "/var/run/nscd/socket"),
      ),
    ).toBe(true);
    expect(
      isRoutineNameServiceConnection(connection("unix", "/run/nscd/socket")),
    ).toBe(true);
    expect(
      isRoutineNameServiceConnection(
        connection("tcp", "/var/run/nscd/socket"),
      ),
    ).toBe(false);
    expect(
      isRoutineNameServiceConnection(
        connection("unix", "/var/run/docker.sock"),
      ),
    ).toBe(false);
    expect(
      isRoutineNameServiceConnection(connection("unix", "/tmp/server.sock")),
    ).toBe(false);
    expect(
      isRoutineNameServiceConnection({
        kind: "network.listen",
        protocol: "unix",
        address: "/var/run/nscd/socket",
        outcome: { status: "succeeded" },
      }),
    ).toBe(false);
  });
});
