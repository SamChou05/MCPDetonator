import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EvidenceStore } from "../../src/evidence-store.js";
import { parseStraceLine } from "../../src/observe/strace-parser.js";
import { normalizeExperiment } from "../../src/observe/strace-normalizer.js";

describe("strace parsing and normalization", () => {
  it("ignores lines that are not complete syscalls", () => {
    expect(
      parseStraceLine({
        experimentId: "random-tool",
        pid: 10,
        rawRef: "raw/random-tool/strace.10:1",
        line: "1700000000.000001 --- SIGCHLD ---",
      }),
    ).toBeUndefined();
  });

  it("distinguishes threads from child processes and links raw evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-normalizer-"));
    const store = await EvidenceStore.create(root, "run-random");
    const raw = store.pathFor("raw/random-tool");
    await mkdir(raw, { recursive: true });
    await writeFile(
      join(raw, "strace.10"),
      [
        '1700000000.000001 execve("/missing/node", ["node"], 0x0) = -1 ENOENT (No such file or directory)',
        '1700000000.000002 execve("/usr/local/bin/node", ["node", "server.js"], 0x0) = 0',
        "1700000000.000003 clone(child_stack=0x0, flags=CLONE_VM|CLONE_THREAD|CLONE_SIGHAND, parent_tid=[11]) = 11",
        "1700000000.000004 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD, child_tidptr=0x0) = 20",
        '1700000000.000008 connect(8<TCP:[99]>, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("198.51.100.7")}, 16) = -1 ENETUNREACH (Network is unreachable)',
        "1700000000.000009 exit_group(0) = ?",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(raw, "strace.11"),
      '1700000000.000005 read(5</sandbox/home/forge/random-secret>, "secret", 6) = 6\n',
      "utf8",
    );
    await writeFile(
      join(raw, "strace.20"),
      '1700000000.000006 execve("/usr/bin/node", ["node", "-e", "0"], 0x0) = 0\n1700000000.000007 exit_group(0) = ?\n',
      "utf8",
    );

    const events = await normalizeExperiment({
      store,
      runId: "run-random",
      experimentId: "random-tool",
    });
    const starts = events.filter((event) => event.effect.kind === "process.start");
    const execs = events.filter((event) => event.effect.kind === "process.exec");
    const read = events.find(
      (event) =>
        event.effect.kind === "file.read" &&
        event.effect.path === "/sandbox/home/forge/random-secret",
    );
    const connection = events.find(
      (event) => event.effect.kind === "network.connect_attempt",
    );

    expect(starts.map((event) => event.effect)).toEqual([
      { kind: "process.start", pid: 10 },
      {
        kind: "process.start",
        pid: 20,
        parentProcessRef: "run-random:random-tool:pid-10",
      },
    ]);
    expect(execs).toHaveLength(2);
    expect(execs.some((event) => JSON.stringify(event).includes("/missing/node"))).toBe(false);
    expect(read?.processRef).toBe("run-random:random-tool:pid-10");
    expect(read?.source.rawRef).toBe("raw/random-tool/strace.11:1");
    expect(connection?.effect).toMatchObject({
      kind: "network.connect_attempt",
      address: "198.51.100.7",
      port: 443,
      outcome: { status: "failed", errno: "ENETUNREACH" },
    });
  });

  it("maps observer-specific bind paths back to stable container paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-normalizer-mount-"));
    const store = await EvidenceStore.create(root, "run-mount");
    const raw = store.pathFor("raw/write-tool");
    await mkdir(raw, { recursive: true });
    await writeFile(
      join(raw, "strace.42"),
      '1700000000.000001 write(18</run/host_virtiofs/host/run/workspace/output.txt>, "ok", 2) = 2\n',
      "utf8",
    );

    const events = await normalizeExperiment({
      store,
      runId: "run-mount",
      experimentId: "write-tool",
      pathMappings: [
        {
          observedPrefix: "/run/host_virtiofs/host/run/workspace",
          containerPrefix: "/synthetic/workspace",
        },
      ],
    });

    expect(events.find((event) => event.effect.kind === "file.write")?.effect).toEqual({
      kind: "file.write",
      path: "/synthetic/workspace/output.txt",
      bytes: 2,
      outcome: { status: "succeeded" },
    });
  });
});
