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

  it("unwraps nested device annotations without changing literal angle brackets", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-normalizer-descriptor-"));
    const store = await EvidenceStore.create(root, "run-descriptor");
    const raw = store.pathFor("raw/descriptor-tool");
    await mkdir(raw, { recursive: true });
    await writeFile(
      join(raw, "strace.42"),
      [
        '1700000000.000001 openat(AT_FDCWD</sandbox/workspace>, "/dev/null", O_RDONLY) = 17</dev/null<char 1:3>>',
        '1700000000.000002 read(17</dev/null<char 1:3>>, "x", 1) = 1',
        '1700000000.000003 write(18</dev/loop0<block 7:0>>, "y", 1) = 1',
        '1700000000.000004 openat(AT_FDCWD</sandbox/workspace>, "/sandbox/workspace/plain.txt", O_RDONLY) = 19</sandbox/workspace/plain.txt>',
        '1700000000.000005 read(20</sandbox/workspace/report<draft>.txt>, "z", 1) = 1',
        '1700000000.000006 write(21</sandbox/workspace/literal<char x:y>>, "q", 1) = 1',
      ].join("\n"),
      "utf8",
    );

    const events = await normalizeExperiment({
      store,
      runId: "run-descriptor",
      experimentId: "descriptor-tool",
    });
    const fileEffects = events
      .map((event) => event.effect)
      .filter((effect) => effect.kind.startsWith("file."));

    expect(fileEffects).toEqual([
      {
        kind: "file.open",
        path: "/dev/null",
        outcome: { status: "succeeded" },
      },
      {
        kind: "file.read",
        path: "/dev/null",
        bytes: 1,
        outcome: { status: "succeeded" },
      },
      {
        kind: "file.write",
        path: "/dev/loop0",
        bytes: 1,
        outcome: { status: "succeeded" },
      },
      {
        kind: "file.open",
        path: "/sandbox/workspace/plain.txt",
        outcome: { status: "succeeded" },
      },
      {
        kind: "file.read",
        path: "/sandbox/workspace/report<draft>.txt",
        bytes: 1,
        outcome: { status: "succeeded" },
      },
      {
        kind: "file.write",
        path: "/sandbox/workspace/literal<char x:y>",
        bytes: 1,
        outcome: { status: "succeeded" },
      },
    ]);
  });

  it("normalizes positional and vectored file I/O syscall families", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-normalizer-file-io-"));
    const store = await EvidenceStore.create(root, "run-file-io");
    const raw = store.pathFor("raw/file-io-tool");
    await mkdir(raw, { recursive: true });
    await writeFile(
      join(raw, "strace.42"),
      [
        '1700000000.000001 pread64(17</sandbox/workspace/input.db>, "abc", 3, 0) = 3',
        '1700000000.000002 readv(17</sandbox/workspace/input.db>, [{iov_base="de", iov_len=2}], 1) = 2',
        '1700000000.000003 preadv(17</sandbox/workspace/input.db>, [{iov_base="f", iov_len=1}], 1, 2) = 1',
        '1700000000.000004 preadv2(17</sandbox/workspace/input.db>, [{iov_base="gh", iov_len=2}], 1, 3, 0) = 2',
        '1700000000.000005 pwrite64(18</sandbox/workspace/output.db>, "abc", 3, 0) = 3',
        '1700000000.000006 writev(18</sandbox/workspace/output.db>, [{iov_base="de", iov_len=2}], 1) = 2',
        '1700000000.000007 pwritev(18</sandbox/workspace/output.db>, [{iov_base="f", iov_len=1}], 1, 2) = 1',
        '1700000000.000008 pwritev2(18</sandbox/workspace/output.db>, [{iov_base="gh", iov_len=2}], 1, 3, 0) = 2',
      ].join("\n"),
      "utf8",
    );

    const events = await normalizeExperiment({
      store,
      runId: "run-file-io",
      experimentId: "file-io-tool",
    });
    const effects = events
      .map((event) => event.effect)
      .filter(
        (effect) => effect.kind === "file.read" || effect.kind === "file.write",
      );

    expect(effects).toEqual([
      { kind: "file.read", path: "/sandbox/workspace/input.db", bytes: 3, outcome: { status: "succeeded" } },
      { kind: "file.read", path: "/sandbox/workspace/input.db", bytes: 2, outcome: { status: "succeeded" } },
      { kind: "file.read", path: "/sandbox/workspace/input.db", bytes: 1, outcome: { status: "succeeded" } },
      { kind: "file.read", path: "/sandbox/workspace/input.db", bytes: 2, outcome: { status: "succeeded" } },
      { kind: "file.write", path: "/sandbox/workspace/output.db", bytes: 3, outcome: { status: "succeeded" } },
      { kind: "file.write", path: "/sandbox/workspace/output.db", bytes: 2, outcome: { status: "succeeded" } },
      { kind: "file.write", path: "/sandbox/workspace/output.db", bytes: 1, outcome: { status: "succeeded" } },
      { kind: "file.write", path: "/sandbox/workspace/output.db", bytes: 2, outcome: { status: "succeeded" } },
    ]);
  });
});
