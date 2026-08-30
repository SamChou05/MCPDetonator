import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EvidenceStore } from "../../src/evidence-store.js";
import {
  parseStraceLine,
  type ParsedStraceRecord,
} from "../../src/observe/strace-parser.js";
import {
  classifyPolicyRelevantTraceGaps,
  maxPolicyRelevantTraceGapExamples,
  normalizeExperiment,
} from "../../src/observe/strace-normalizer.js";

function parseRecords(lines: readonly string[]): ParsedStraceRecord[] {
  return lines.flatMap((line, index) => {
    const parsed = parseStraceLine({
      experimentId: "gap-tool",
      pid: 42,
      rawRef: `raw/gap-tool/strace.42:${index + 1}`,
      line,
    });
    return parsed === undefined ? [] : [parsed];
  });
}

describe("strace parsing and normalization", () => {
  it("ignores lines that are neither complete syscalls nor terminal signals", () => {
    expect(
      parseStraceLine({
        experimentId: "random-tool",
        pid: 10,
        rawRef: "raw/random-tool/strace.10:1",
        line: "1700000000.000001 --- SIGCHLD ---",
      }),
    ).toBeUndefined();
  });

  it("parses signal termination records without treating delivery as termination", () => {
    expect(
      parseStraceLine({
        experimentId: "signal-tool",
        pid: 12,
        rawRef: "raw/signal-tool/strace.12:1",
        line: "1700000000.000001 --- SIGTERM {si_signo=SIGTERM, si_code=SI_USER} ---",
      }),
    ).toBeUndefined();

    expect(
      parseStraceLine({
        experimentId: "signal-tool",
        pid: 12,
        rawRef: "raw/signal-tool/strace.12:2",
        line: "1700000000.000002 +++ killed by SIGSEGV (core dumped) +++",
      }),
    ).toEqual({
      kind: "signal-termination",
      experimentId: "signal-tool",
      pid: 12,
      timestampSeconds: 1700000000.000002,
      signal: "SIGSEGV",
      rawRef: "raw/signal-tool/strace.12:2",
      rawLine: "1700000000.000002 +++ killed by SIGSEGV (core dumped) +++",
    });
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
    expect(execs).toHaveLength(3);
    expect(
      execs.find(
        (event) =>
          event.effect.kind === "process.exec" &&
          event.effect.executable === "/missing/node",
      ),
    ).toMatchObject({
      effect: {
        kind: "process.exec",
        executable: "/missing/node",
        args: ["node"],
        outcome: { status: "failed", errno: "ENOENT" },
      },
      source: { rawRef: "raw/random-tool/strace.10:1" },
    });
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

  it("normalizes failed file attempts when their target path is known", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-normalizer-failures-"));
    const store = await EvidenceStore.create(root, "run-failures");
    const raw = store.pathFor("raw/failure-tool");
    await mkdir(raw, { recursive: true });
    await writeFile(
      join(raw, "strace.42"),
      [
        '1700000000.000001 open("/sandbox/workspace/direct.txt", O_RDONLY) = -1 ENOENT (No such file or directory)',
        '1700000000.000002 openat(AT_FDCWD</run/host/workspace>, "relative.txt", O_RDONLY) = -1 EACCES (Permission denied)',
        '1700000000.000003 openat2(9</run/host/workspace/config>, "../policy.json", {flags=O_RDONLY}, 24) = -1 EPERM (Operation not permitted)',
        '1700000000.000004 read(17</run/host/workspace/input.db>, 0x0, 3) = -1 EIO (Input/output error)',
        '1700000000.000005 pread64(17</run/host/workspace/input.db>, 0x0, 3, 0) = -1 EIO (Input/output error)',
        '1700000000.000006 readv(17</run/host/workspace/input.db>, 0x0, 1) = -1 EIO (Input/output error)',
        '1700000000.000007 preadv(17</run/host/workspace/input.db>, 0x0, 1, 0) = -1 EIO (Input/output error)',
        '1700000000.000008 preadv2(17</run/host/workspace/input.db>, 0x0, 1, 0, 0) = -1 EIO (Input/output error)',
        '1700000000.000009 write(18</run/host/workspace/output.db>, "x", 1) = -1 ENOSPC (No space left on device)',
        '1700000000.000010 pwrite64(18</run/host/workspace/output.db>, "x", 1, 0) = -1 ENOSPC (No space left on device)',
        '1700000000.000011 writev(18</run/host/workspace/output.db>, 0x0, 1) = -1 ENOSPC (No space left on device)',
        '1700000000.000012 pwritev(18</run/host/workspace/output.db>, 0x0, 1, 0) = -1 ENOSPC (No space left on device)',
        '1700000000.000013 pwritev2(18</run/host/workspace/output.db>, 0x0, 1, 0, 0) = -1 ENOSPC (No space left on device)',
        '1700000000.000014 unlink("/sandbox/workspace/locked.txt") = -1 EBUSY (Device or resource busy)',
        '1700000000.000015 unlinkat(9</run/host/workspace/archive>, "old.txt", 0) = -1 EPERM (Operation not permitted)',
        '1700000000.000016 openat(AT_FDCWD, "unknown-relative.txt", O_RDONLY) = -1 ENOENT (No such file or directory)',
        '1700000000.000017 read(99, 0x0, 1) = -1 EBADF (Bad file descriptor)',
        '1700000000.000018 unlinkat(AT_FDCWD, "unknown-relative.txt", 0) = -1 ENOENT (No such file or directory)',
      ].join("\n"),
      "utf8",
    );

    const events = await normalizeExperiment({
      store,
      runId: "run-failures",
      experimentId: "failure-tool",
      pathMappings: [
        {
          observedPrefix: "/run/host/workspace",
          containerPrefix: "/sandbox/workspace",
        },
      ],
    });
    const effects = events
      .map((event) => event.effect)
      .filter((effect) => effect.kind.startsWith("file."));

    expect(effects).toEqual([
      {
        kind: "file.open",
        path: "/sandbox/workspace/direct.txt",
        outcome: { status: "failed", errno: "ENOENT" },
      },
      {
        kind: "file.open",
        path: "/sandbox/workspace/relative.txt",
        outcome: { status: "failed", errno: "EACCES" },
      },
      {
        kind: "file.open",
        path: "/sandbox/workspace/policy.json",
        outcome: { status: "failed", errno: "EPERM" },
      },
      ...Array.from({ length: 5 }, () => ({
        kind: "file.read" as const,
        path: "/sandbox/workspace/input.db",
        outcome: { status: "failed" as const, errno: "EIO" },
      })),
      ...Array.from({ length: 5 }, () => ({
        kind: "file.write" as const,
        path: "/sandbox/workspace/output.db",
        outcome: { status: "failed" as const, errno: "ENOSPC" },
      })),
      {
        kind: "file.delete",
        path: "/sandbox/workspace/locked.txt",
        outcome: { status: "failed", errno: "EBUSY" },
      },
      {
        kind: "file.delete",
        path: "/sandbox/workspace/archive/old.txt",
        outcome: { status: "failed", errno: "EPERM" },
      },
    ]);
    expect(
      events.find(
        (event) =>
          event.effect.kind === "file.open" &&
          event.effect.path === "/sandbox/workspace/direct.txt",
      )?.source.rawRef,
    ).toBe("raw/failure-tool/strace.42:1");
    expect(
      events.some((event) =>
        [
          "raw/failure-tool/strace.42:16",
          "raw/failure-tool/strace.42:17",
          "raw/failure-tool/strace.42:18",
        ].includes(event.source.rawRef),
      ),
    ).toBe(false);
  });

  it("preserves truncating open attempts as file mutations without guessing about O_CREAT", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-normalizer-open-flags-"));
    const store = await EvidenceStore.create(root, "run-open-flags");
    const raw = store.pathFor("raw/open-tool");
    await mkdir(raw, { recursive: true });
    await writeFile(
      join(raw, "strace.42"),
      [
        '1700000000.000001 openat(AT_FDCWD</sandbox/workspace>, "existing.txt", O_WRONLY|O_TRUNC) = 3</sandbox/workspace/existing.txt>',
        '1700000000.000002 openat(AT_FDCWD</sandbox/workspace>, "denied.txt", O_WRONLY|O_TRUNC) = -1 EACCES (Permission denied)',
        '1700000000.000003 openat(AT_FDCWD</sandbox/workspace>, "ambiguous.txt", O_WRONLY|O_CREAT, 0600) = 4</sandbox/workspace/ambiguous.txt>',
      ].join("\n"),
      "utf8",
    );

    const events = await normalizeExperiment({
      store,
      runId: "run-open-flags",
      experimentId: "open-tool",
    });
    const effects = events
      .map((event) => event.effect)
      .filter((effect) => effect.kind.startsWith("file."));

    expect(effects).toEqual([
      {
        kind: "file.write",
        path: "/sandbox/workspace/existing.txt",
        operation: "truncate",
        outcome: { status: "succeeded" },
      },
      {
        kind: "file.write",
        path: "/sandbox/workspace/denied.txt",
        operation: "truncate",
        outcome: { status: "failed", errno: "EACCES" },
      },
      {
        kind: "file.open",
        path: "/sandbox/workspace/ambiguous.txt",
        outcome: { status: "succeeded" },
      },
    ]);
  });

  it("normalizes bounded directory enumeration evidence only when the fd path is known", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-normalizer-getdents-"));
    const store = await EvidenceStore.create(root, "run-getdents");
    const raw = store.pathFor("raw/directory-tool");
    await mkdir(raw, { recursive: true });
    await writeFile(
      join(raw, "strace.42"),
      [
        "1700000000.000001 getdents64(3</run/host/workspace>, 0x0, 32768) = 128",
        "1700000000.000002 getdents(3</run/host/workspace>, 0x0, 32768) = -1 EACCES (Permission denied)",
        "1700000000.000003 getdents64(3</run/host/workspace>, 0x0, 32768) = 0",
        "1700000000.000004 getdents64(9, 0x0, 32768) = 64",
      ].join("\n"),
      "utf8",
    );

    const events = await normalizeExperiment({
      store,
      runId: "run-getdents",
      experimentId: "directory-tool",
      pathMappings: [
        {
          observedPrefix: "/run/host/workspace",
          containerPrefix: "/sandbox/workspace",
        },
      ],
    });
    const directoryReads = events.filter(
      (event) => event.effect.kind === "file.read",
    );

    expect(directoryReads.map((event) => event.effect)).toEqual([
      {
        kind: "file.read",
        path: "/sandbox/workspace",
        operation: "directory_entries",
        outcome: { status: "succeeded" },
      },
      {
        kind: "file.read",
        path: "/sandbox/workspace",
        operation: "directory_entries",
        outcome: { status: "failed", errno: "EACCES" },
      },
    ]);
    expect(directoryReads.map((event) => event.source.rawRef)).toEqual([
      "raw/directory-tool/strace.42:1",
      "raw/directory-tool/strace.42:2",
    ]);
  });

  it("normalizes only resolvable execveat paths and preserves failed attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-normalizer-execveat-"));
    const store = await EvidenceStore.create(root, "run-execveat");
    const raw = store.pathFor("raw/exec-tool");
    await mkdir(raw, { recursive: true });
    await writeFile(
      join(raw, "strace.42"),
      [
        '1700000000.000001 execveat(7</run/host/workspace/bin/tool>, "", ["tool", "--flag"], 0x0, AT_EMPTY_PATH) = 0',
        '1700000000.000002 execveat(8</run/host/workspace/bin>, "../other", ["other"], 0x0, 0) = -1 EACCES (Permission denied)',
        '1700000000.000003 execveat(AT_FDCWD, "/usr/bin/env", ["env"], 0x0, 0) = 0',
        '1700000000.000004 execveat(9, "", ["hidden"], 0x0, AT_EMPTY_PATH) = 0',
        '1700000000.000005 execveat(9<memfd:payload>, "", ["payload"], 0x0, AT_EMPTY_PATH) = 0',
        '1700000000.000006 execveat(AT_FDCWD, "relative", ["relative"], 0x0, 0) = -1 ENOENT (No such file or directory)',
        '1700000000.000007 execveat(AT_FDCWD</run/host/workspace>, "truncated"..., ["truncated"], 0x0, 0) = -1 ENOENT (No such file or directory)',
        '1700000000.000008 execveat(7</run/host/workspace/bin/tool>, "", ["tool"], 0x0, 0) = -1 ENOENT (No such file or directory)',
        '1700000000.000009 execveat(AT_FDCWD</run/host/workspace>, "", ["workspace"], 0x0, AT_EMPTY_PATH) = -1 EBADF (Bad file descriptor)',
      ].join("\n"),
      "utf8",
    );

    const events = await normalizeExperiment({
      store,
      runId: "run-execveat",
      experimentId: "exec-tool",
      pathMappings: [
        {
          observedPrefix: "/run/host/workspace",
          containerPrefix: "/sandbox/workspace",
        },
      ],
    });
    const execs = events.filter(
      (event) => event.effect.kind === "process.exec",
    );

    expect(execs.map((event) => event.effect)).toEqual([
      {
        kind: "process.exec",
        executable: "/sandbox/workspace/bin/tool",
        args: ["tool", "--flag"],
        outcome: { status: "succeeded" },
      },
      {
        kind: "process.exec",
        executable: "/sandbox/workspace/other",
        args: ["other"],
        outcome: { status: "failed", errno: "EACCES" },
      },
      {
        kind: "process.exec",
        executable: "/usr/bin/env",
        args: ["env"],
        outcome: { status: "succeeded" },
      },
    ]);
    expect(
      execs.some(
        (event) =>
          event.effect.kind === "process.exec" &&
          ["/", "/sandbox/workspace", "memfd:payload"].includes(
            event.effect.executable,
          ),
      ),
    ).toBe(false);
  });

  it("does not project exec records with truncated argument vectors", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-normalizer-exec-argv-"));
    const store = await EvidenceStore.create(root, "run-exec-argv");
    const raw = store.pathFor("raw/exec-argv-tool");
    await mkdir(raw, { recursive: true });
    const lines = [
      '1700000005.000001 execve("/usr/bin/tool", ["tool", "secret-prefix"...], 0x0) = 0',
      '1700000005.000002 execve("/usr/bin/tool", ["tool", ...], 0x0) = 0',
      '1700000005.000003 execve("/usr/bin/tool", ["tool", "literal..."], 0x0) = -1 ENOENT (No such file or directory)',
      '1700000005.000004 execveat(AT_FDCWD, "/usr/bin/tool", ["tool", "argument"...], 0x0, 0) = -1 E2BIG (Argument list too long)',
    ];
    await writeFile(join(raw, "strace.42"), lines.join("\n"), "utf8");

    const events = await normalizeExperiment({
      store,
      runId: "run-exec-argv",
      experimentId: "exec-argv-tool",
    });
    const execs = events.filter(
      (event) => event.effect.kind === "process.exec",
    );

    expect(execs.map((event) => event.effect)).toEqual([
      {
        kind: "process.exec",
        executable: "/usr/bin/tool",
        args: ["tool", "literal..."],
        outcome: { status: "failed", errno: "ENOENT" },
      },
    ]);
    expect(classifyPolicyRelevantTraceGaps(parseRecords(lines))).toMatchObject({
      recordCount: 3,
      categoryCounts: [
        { category: "truncated_arguments", recordCount: 3 },
      ],
      syscallCounts: [
        { syscall: "execve", recordCount: 2 },
        { syscall: "execveat", recordCount: 1 },
      ],
      outcomeCounts: [
        { outcome: "succeeded", recordCount: 2 },
        { outcome: "failed", recordCount: 1 },
      ],
      truncatedExampleCount: 0,
    });
  });

  it("correlates reliable bind/listen endpoints across threads and forked fd tables", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-normalizer-listen-"));
    const store = await EvidenceStore.create(root, "run-listen");
    const raw = store.pathFor("raw/listen-tool");
    await mkdir(raw, { recursive: true });
    await writeFile(
      join(raw, "strace.10"),
      [
        "1700000000.000001 socket(AF_INET, SOCK_STREAM, IPPROTO_TCP) = 18<TCP:[100]>",
        '1700000000.000002 bind(18<TCP:[127.0.0.1:0]>, {sa_family=AF_INET, sin_port=htons(0), sin_addr=inet_addr("127.0.0.1")}, 16) = 0',
        "1700000000.000003 listen(18<TCP:[127.0.0.1:44525]>, 511) = 0",
        "1700000000.000004 socket(AF_UNIX, SOCK_STREAM, 0) = 19<UNIX-STREAM:[991]>",
        '1700000000.000005 bind(19<UNIX-STREAM:[991]>, {sa_family=AF_UNIX, sun_path="/tmp/forge.sock"}, 110) = 0',
        "1700000000.000006 fork() = 20",
        "1700000000.000008 socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP) = 22<UDP:[200]>",
        '1700000000.000009 bind(22<UDP:[0.0.0.0:5353]>, {sa_family=AF_INET, sin_port=htons(5353), sin_addr=inet_addr("0.0.0.0")}, 16) = 0',
        "1700000000.000010 socket(AF_UNIX, SOCK_STREAM, 0) = 23<UNIX-STREAM:[300]>",
        '1700000000.000011 bind(23<UNIX-STREAM:[300]>, {sa_family=AF_UNIX, sun_path="/tmp/stale.sock"}, 110) = 0',
        "1700000000.000012 close(23<UNIX-STREAM:[300]>) = 0",
        "1700000000.000013 socket(AF_INET, SOCK_STREAM, IPPROTO_TCP) = 23<TCP:[301]>",
        "1700000000.000014 listen(23<TCP:[127.0.0.1:9000]>, 128) = 0",
        "1700000000.000015 socket(AF_INET, SOCK_STREAM, IPPROTO_TCP) = 24<TCP:[400]>",
        '1700000000.000016 bind(24<TCP:[127.0.0.1:8080]>, {sa_family=AF_INET, sin_port=htons(8080), sin_addr=inet_addr("127.0.0.1")}, 16) = 0',
        "1700000000.000017 listen(24<TCP:[127.0.0.1:8080]>, 128) = -1 EADDRINUSE (Address already in use)",
        "1700000000.000018 bind(25<NETLINK:[401]>, {sa_family=AF_NETLINK, nl_pid=0, nl_groups=0}, 12) = 0",
        "1700000000.000019 socket(AF_UNIX, SOCK_STREAM, 0) = 26<UNIX-STREAM:[402]>",
        '1700000000.000020 bind(26<UNIX-STREAM:[402]>, {sa_family=AF_UNIX, sun_path=@"forge-abstract"}, 110) = 0',
        "1700000000.000021 listen(26<UNIX-STREAM:[402]>, 128) = 0",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(raw, "strace.20"),
      "1700000000.000007 listen(19<UNIX-STREAM:[991]>, 511) = 0\n",
      "utf8",
    );

    const events = await normalizeExperiment({
      store,
      runId: "run-listen",
      experimentId: "listen-tool",
    });
    const listeners = events.filter(
      (event) => event.effect.kind === "network.listen",
    );

    expect(listeners.map((event) => event.effect)).toEqual([
      {
        kind: "network.listen",
        protocol: "tcp",
        address: "127.0.0.1",
        port: 44_525,
        outcome: { status: "succeeded" },
      },
      {
        kind: "network.listen",
        protocol: "unix",
        address: "/tmp/forge.sock",
        outcome: { status: "succeeded" },
      },
      {
        kind: "network.listen",
        protocol: "udp",
        address: "0.0.0.0",
        port: 5_353,
        outcome: { status: "succeeded" },
      },
      {
        kind: "network.listen",
        protocol: "tcp",
        address: "127.0.0.1",
        port: 9_000,
        outcome: { status: "succeeded" },
      },
      {
        kind: "network.listen",
        protocol: "tcp",
        address: "127.0.0.1",
        port: 8_080,
        outcome: { status: "failed", errno: "EADDRINUSE" },
      },
      {
        kind: "network.listen",
        protocol: "unix",
        address: "@forge-abstract",
        outcome: { status: "succeeded" },
      },
    ]);
    expect(listeners[1]?.processRef).toBe("run-listen:listen-tool:pid-20");
    expect(
      listeners.some(
        (event) =>
          event.effect.kind === "network.listen" &&
          event.effect.address === "/tmp/stale.sock",
      ),
    ).toBe(false);
  });

  it("separates process attribution from shared and copied descriptor tables", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-normalizer-fd-clone-"));
    const store = await EvidenceStore.create(root, "run-fd-clone");
    const raw = store.pathFor("raw/fd-clone-tool");
    await mkdir(raw, { recursive: true });
    await writeFile(
      join(raw, "strace.10"),
      [
        "1700000010.000001 socket(AF_UNIX, SOCK_STREAM, 0) = 30<UNIX-STREAM:[300]>",
        '1700000010.000002 bind(30<UNIX-STREAM:[300]>, {sa_family=AF_UNIX, sun_path="/tmp/shared-closed.sock"}, 110) = 0',
        "1700000010.000003 clone(child_stack=NULL, flags=CLONE_FILES|SIGCHLD) = 20",
        "1700000010.000005 listen(30<UNIX-STREAM:[300]>, 16) = 0",
        "1700000010.000006 socket(AF_UNIX, SOCK_STREAM, 0) = 31<UNIX-STREAM:[301]>",
        '1700000010.000007 bind(31<UNIX-STREAM:[301]>, {sa_family=AF_UNIX, sun_path="/tmp/copied.sock"}, 110) = 0',
        "1700000010.000008 clone(child_stack=NULL, flags=SIGCHLD) = 21",
        "1700000010.000010 listen(31<UNIX-STREAM:[301]>, 16) = 0",
        "1700000010.000011 socket(AF_UNIX, SOCK_STREAM, 0) = 32<UNIX-STREAM:[302]>",
        '1700000010.000012 bind(32<UNIX-STREAM:[302]>, {sa_family=AF_UNIX, sun_path="/tmp/thread-copy.sock"}, 110) = 0',
        "1700000010.000013 clone(child_stack=0x0, flags=CLONE_VM|CLONE_SIGHAND|CLONE_THREAD) = 11",
        "1700000010.000015 listen(32<UNIX-STREAM:[302]>, 16) = 0",
        "1700000010.000016 socket(AF_UNIX, SOCK_STREAM, 0) = 33<UNIX-STREAM:[303]>",
        "1700000010.000017 clone(child_stack=NULL, flags=CLONE_FILES|SIGCHLD) = 22",
        "1700000010.000019 listen(33<UNIX-STREAM:[303]>, 16) = 0",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(raw, "strace.11"),
      "1700000010.000014 close(32<UNIX-STREAM:[302]>) = 0\n",
      "utf8",
    );
    await writeFile(
      join(raw, "strace.20"),
      "1700000010.000004 close(30<UNIX-STREAM:[300]>) = 0\n",
      "utf8",
    );
    await writeFile(
      join(raw, "strace.21"),
      "1700000010.000009 close(31<UNIX-STREAM:[301]>) = 0\n",
      "utf8",
    );
    await writeFile(
      join(raw, "strace.22"),
      '1700000010.000018 bind(33<UNIX-STREAM:[303]>, {sa_family=AF_UNIX, sun_path="/tmp/child-shared.sock"}, 110) = 0\n',
      "utf8",
    );

    const events = await normalizeExperiment({
      store,
      runId: "run-fd-clone",
      experimentId: "fd-clone-tool",
    });
    const listeners = events
      .map((event) => event.effect)
      .filter((effect) => effect.kind === "network.listen");

    expect(listeners).toEqual([
      {
        kind: "network.listen",
        protocol: "unix",
        address: "unknown",
        outcome: { status: "succeeded" },
      },
      {
        kind: "network.listen",
        protocol: "unix",
        address: "/tmp/copied.sock",
        outcome: { status: "succeeded" },
      },
      {
        kind: "network.listen",
        protocol: "unix",
        address: "/tmp/thread-copy.sock",
        outcome: { status: "succeeded" },
      },
      {
        kind: "network.listen",
        protocol: "unix",
        address: "/tmp/child-shared.sock",
        outcome: { status: "succeeded" },
      },
    ]);
  });

  it("invalidates close ranges and conservatively drops ambiguous closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-normalizer-close-range-"));
    const store = await EvidenceStore.create(root, "run-close-range");
    const raw = store.pathFor("raw/close-range-tool");
    await mkdir(raw, { recursive: true });
    await writeFile(
      join(raw, "strace.40"),
      [
        '1700000011.000001 bind(40<UNIX-STREAM:[400]>, {sa_family=AF_UNIX, sun_path="/tmp/range-40.sock"}, 110) = 0',
        '1700000011.000002 bind(41<UNIX-STREAM:[401]>, {sa_family=AF_UNIX, sun_path="/tmp/range-41.sock"}, 110) = 0',
        '1700000011.000003 bind(42<UNIX-STREAM:[402]>, {sa_family=AF_UNIX, sun_path="/tmp/keep-42.sock"}, 110) = 0',
        "1700000011.000004 close_range(40, 41, 0) = 0",
        "1700000011.000005 listen(40<UNIX-STREAM:[400]>, 16) = -1 EBADF (Bad file descriptor)",
        "1700000011.000006 listen(41<UNIX-STREAM:[401]>, 16) = -1 EBADF (Bad file descriptor)",
        "1700000011.000007 listen(42<UNIX-STREAM:[402]>, 16) = 0",
        '1700000011.000008 bind(43<UNIX-STREAM:[403]>, {sa_family=AF_UNIX, sun_path="/tmp/shared-43.sock"}, 110) = 0',
        "1700000011.000009 clone(child_stack=NULL, flags=CLONE_FILES|SIGCHLD) = 50",
        "1700000011.000012 listen(43<UNIX-STREAM:[403]>, 16) = 0",
        '1700000011.000013 bind(44<UNIX-STREAM:[404]>, {sa_family=AF_UNIX, sun_path="/tmp/ambiguous-range.sock"}, 110) = 0',
        "1700000011.000014 close_range(44, 44, 0) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)",
        "1700000011.000015 listen(44<UNIX-STREAM:[404]>, 16) = -1 EBADF (Bad file descriptor)",
        '1700000011.000016 bind(45<UNIX-STREAM:[405]>, {sa_family=AF_UNIX, sun_path="/tmp/ambiguous-close.sock"}, 110) = 0',
        "1700000011.000017 close(45<UNIX-STREAM:[405]>) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)",
        "1700000011.000018 listen(45<UNIX-STREAM:[405]>, 16) = -1 EBADF (Bad file descriptor)",
        '1700000011.000019 bind(46<UNIX-STREAM:[406]>, {sa_family=AF_UNIX, sun_path="/tmp/range-tail.sock"}, 110) = 0',
        "1700000011.000020 close_range(46, ~0U, 0) = 0",
        "1700000011.000021 listen(46<UNIX-STREAM:[406]>, 16) = -1 EBADF (Bad file descriptor)",
        '1700000011.000022 bind(47<UNIX-STREAM:[407]>, {sa_family=AF_UNIX, sun_path="/tmp/cloexec-47.sock"}, 110) = 0',
        "1700000011.000023 close_range(47, 47, CLOSE_RANGE_CLOEXEC) = 0",
        "1700000011.000024 listen(47<UNIX-STREAM:[407]>, 16) = 0",
        '1700000011.000025 bind(48<UNIX-STREAM:[408]>, {sa_family=AF_UNIX, sun_path="/tmp/unshare-cloexec-48.sock"}, 110) = 0',
        "1700000011.000026 clone(child_stack=NULL, flags=CLONE_FILES|SIGCHLD) = 51",
        "1700000011.000028 listen(48<UNIX-STREAM:[408]>, 16) = 0",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(raw, "strace.50"),
      [
        "1700000011.000010 close_range(43, 43, CLOSE_RANGE_UNSHARE) = 0",
        "1700000011.000011 listen(43<UNIX-STREAM:[403]>, 16) = -1 EBADF (Bad file descriptor)",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(raw, "strace.51"),
      [
        "1700000011.000027 close_range(48, 48, CLOSE_RANGE_UNSHARE|CLOSE_RANGE_CLOEXEC) = 0",
        "1700000011.000029 listen(48<UNIX-STREAM:[408]>, 16) = 0",
      ].join("\n"),
      "utf8",
    );

    const events = await normalizeExperiment({
      store,
      runId: "run-close-range",
      experimentId: "close-range-tool",
    });
    const listenerAddresses = events.flatMap((event) =>
      event.effect.kind === "network.listen" ? [event.effect.address] : [],
    );

    expect(listenerAddresses).toEqual([
      "unknown",
      "unknown",
      "/tmp/keep-42.sock",
      "unknown",
      "/tmp/shared-43.sock",
      "unknown",
      "unknown",
      "unknown",
      "/tmp/cloexec-47.sock",
      "/tmp/unshare-cloexec-48.sock",
      "/tmp/unshare-cloexec-48.sock",
    ]);
  });

  it("propagates fcntl descriptor duplication without retaining stale targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-normalizer-fcntl-"));
    const store = await EvidenceStore.create(root, "run-fcntl");
    const raw = store.pathFor("raw/fcntl-tool");
    await mkdir(raw, { recursive: true });
    await writeFile(
      join(raw, "strace.42"),
      [
        '1700000012.000001 bind(50<UNIX-STREAM:[500]>, {sa_family=AF_UNIX, sun_path="/tmp/fcntl.sock"}, 110) = 0',
        "1700000012.000002 fcntl(50<UNIX-STREAM:[500]>, F_DUPFD, 60) = 60<UNIX-STREAM:[500]>",
        "1700000012.000003 close(50<UNIX-STREAM:[500]>) = 0",
        "1700000012.000004 listen(60<UNIX-STREAM:[500]>, 16) = 0",
        "1700000012.000005 fcntl64(60<UNIX-STREAM:[500]>, F_DUPFD_CLOEXEC, 70) = 70<UNIX-STREAM:[500]>",
        "1700000012.000006 close(60<UNIX-STREAM:[500]>) = 0",
        "1700000012.000007 listen(70<UNIX-STREAM:[500]>, 16) = 0",
        '1700000012.000008 bind(80<UNIX-STREAM:[800]>, {sa_family=AF_UNIX, sun_path="/tmp/stale-target.sock"}, 110) = 0',
        "1700000012.000009 fcntl(9<pipe:[9]>, F_DUPFD, 80) = 80<pipe:[10]>",
        "1700000012.000010 listen(80<UNIX-STREAM:[800]>, 16) = -1 ENOTSOCK (Socket operation on non-socket)",
        '1700000012.000011 bind(81<UNIX-STREAM:[801]>, {sa_family=AF_UNIX, sun_path="/tmp/fcntl-failed.sock"}, 110) = 0',
        "1700000012.000012 fcntl(81<UNIX-STREAM:[801]>, F_DUPFD, 90) = -1 EMFILE (Too many open files)",
        "1700000012.000013 listen(81<UNIX-STREAM:[801]>, 16) = 0",
        '1700000012.000014 bind(90<UNIX-STREAM:[900]>, {sa_family=AF_UNIX, sun_path="/tmp/fcntl-ambiguous.sock"}, 110) = 0',
        "1700000012.000015 fcntl(70<UNIX-STREAM:[500]>, F_DUPFD, 90) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)",
        "1700000012.000016 listen(90<UNIX-STREAM:[900]>, 16) = -1 EBADF (Bad file descriptor)",
      ].join("\n"),
      "utf8",
    );

    const events = await normalizeExperiment({
      store,
      runId: "run-fcntl",
      experimentId: "fcntl-tool",
    });
    const listenerAddresses = events.flatMap((event) =>
      event.effect.kind === "network.listen" ? [event.effect.address] : [],
    );

    expect(listenerAddresses).toEqual([
      "/tmp/fcntl.sock",
      "/tmp/fcntl.sock",
      "unknown",
      "/tmp/fcntl-failed.sock",
      "unknown",
    ]);
  });

  it("keeps unknown syscall outcomes out of canonical evidence and endpoint state", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-normalizer-unknown-"));
    const store = await EvidenceStore.create(root, "run-unknown");
    const raw = store.pathFor("raw/unknown-tool");
    await mkdir(raw, { recursive: true });
    const lines = [
      '1700000004.000001 execve("/sandbox/workspace/bin/tool", ["tool"], 0x0) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      '1700000004.000002 unlink("/sandbox/workspace/old.txt") = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      '1700000004.000003 openat(AT_FDCWD</sandbox/workspace>, "truncated.txt", O_WRONLY|O_TRUNC) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      '1700000004.000004 read(3</sandbox/home/forge/secret>, 0x0, 1) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      '1700000004.000005 write(4</sandbox/workspace/out>, 0x0, 1) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      '1700000004.000006 getdents64(5</sandbox/workspace>, 0x0, 32768) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      '1700000004.000007 bind(19<UNIX-STREAM:[991]>, {sa_family=AF_UNIX, sun_path="/tmp/unknown.sock"}, 110) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      "1700000004.000008 listen(19<UNIX-STREAM:[991]>, 511) = 0",
      '1700000004.000009 bind(20<UDP:[200]>, {sa_family=AF_INET, sin_port=htons(5353), sin_addr=inet_addr("0.0.0.0")}, 16) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      '1700000004.000010 connect(21<TCP:[201]>, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("198.51.100.7")}, 16) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      "1700000004.000011 listen(22<TCP:[202]>, 511) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)",
      "1700000004.000012 mmap(NULL, 4096, PROT_READ, MAP_PRIVATE, 6</sandbox/workspace/input>, 0) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)",
      '1700000004.000013 bind(23<NETLINK:[ROUTE:203]>, {sa_family=AF_NETLINK, nl_pid=0, nl_groups=0}, 12) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      '1700000004.000014 openat(AT_FDCWD</sandbox/workspace>, "input.txt", O_RDONLY) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
    ];
    await writeFile(join(raw, "strace.42"), lines.join("\n"), "utf8");

    const events = await normalizeExperiment({
      store,
      runId: "run-unknown",
      experimentId: "unknown-tool",
    });
    const canonicalEffects = events
      .map((event) => event.effect)
      .filter((effect) => effect.kind !== "process.start");

    expect(canonicalEffects).toEqual([
      {
        kind: "network.listen",
        protocol: "unix",
        address: "unknown",
        outcome: { status: "succeeded" },
      },
    ]);
    expect(events.find((event) => event.effect.kind === "network.listen")?.source)
      .toEqual({
        collector: "strace",
        rawRef: "raw/unknown-tool/strace.42:8",
      });

    const classified = classifyPolicyRelevantTraceGaps(parseRecords(lines));
    expect(classified).toMatchObject({
      recordCount: 12,
      categoryCounts: [
        { category: "filesystem_mutation", recordCount: 3 },
        { category: "network_endpoint", recordCount: 4 },
        { category: "alternate_file_access", recordCount: 4 },
        { category: "indeterminate_outcome", recordCount: 1 },
      ],
      syscallCounts: [
        { syscall: "bind", recordCount: 2 },
        { syscall: "connect", recordCount: 1 },
        { syscall: "execve", recordCount: 1 },
        { syscall: "getdents64", recordCount: 1 },
        { syscall: "listen", recordCount: 1 },
        { syscall: "mmap", recordCount: 1 },
        { syscall: "openat", recordCount: 2 },
        { syscall: "read", recordCount: 1 },
        { syscall: "unlink", recordCount: 1 },
        { syscall: "write", recordCount: 1 },
      ],
      outcomeCounts: [{ outcome: "unknown", recordCount: 12 }],
      truncatedExampleCount: 7,
    });
    expect(classified.examples.every((example) => example.outcome === "unknown"))
      .toBe(true);
  });

  it("accounts for unresolved failed and unknown ordinary open paths conservatively", () => {
    const records = parseRecords([
      '1700000006.000001 openat(AT_FDCWD</sandbox/workspace>, "known.txt", O_RDONLY) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      '1700000006.000002 openat(AT_FDCWD, "cwd-relative.txt", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '1700000006.000003 open("cwd-relative.txt", O_RDONLY) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      '1700000006.000004 openat(7</sandbox/workspace>, "long-name"..., O_RDONLY) = -1 ENAMETOOLONG (File name too long)',
      '1700000006.000005 openat(8</usr/lib>, "long-name"..., O_RDONLY) = -1 ENAMETOOLONG (File name too long)',
      '1700000006.000006 openat(AT_FDCWD</opt/target>, "outside.txt", O_RDONLY) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      '1700000006.000007 openat(AT_FDCWD</sandbox/workspace>, "missing.txt", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '1700000006.000008 openat(AT_FDCWD, "/sandbox/workspace/long-name"..., O_RDONLY) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      '1700000006.000009 openat(AT_FDCWD, "/usr/lib/long-name"..., O_RDONLY) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
    ]);

    expect(classifyPolicyRelevantTraceGaps(records)).toMatchObject({
      recordCount: 5,
      categoryCounts: [
        { category: "alternate_file_access", recordCount: 1 },
        { category: "unresolved_path", recordCount: 4 },
      ],
      syscallCounts: [
        { syscall: "open", recordCount: 1 },
        { syscall: "openat", recordCount: 4 },
      ],
      outcomeCounts: [
        { outcome: "failed", recordCount: 2 },
        { outcome: "unknown", recordCount: 3 },
      ],
      truncatedExampleCount: 0,
    });
  });

  it("classifies unsupported policy-relevant records with bounded factual examples", () => {
    const records = parseRecords([
      '1700000000.000001 rename("/sandbox/workspace/a", "/sandbox/workspace/b") = 0',
      '1700000000.000002 rename("/sandbox/workspace/a", "/sandbox/workspace/b") = -1 ENOENT (No such file or directory)',
      '1700000000.000003 openat(AT_FDCWD</sandbox/workspace>, "new.txt", O_WRONLY|O_CREAT, 0600) = 3</sandbox/workspace/new.txt>',
      '1700000000.000004 sendto(4<UDP:[1]>, "x", 1, 0, {sa_family=AF_INET}, 16) = -1 ENETUNREACH (Network is unreachable)',
      "1700000000.000005 ptrace(PTRACE_ATTACH, 99) = -1 EPERM (Operation not permitted)",
      "1700000000.000006 io_uring_enter(5, 1, 0, 0, NULL, 0) = -1 EPERM (Operation not permitted)",
      "1700000000.000007 mmap(NULL, 4096, PROT_READ, MAP_PRIVATE, 6</usr/lib/libc.so.6>, 0) = 0x1000",
      "1700000000.000008 mmap(NULL, 4096, PROT_READ, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0x2000",
      "1700000000.000009 mmap(NULL, 4096, PROT_READ, MAP_PRIVATE, 7</sandbox/home/forge/.ssh/id_ed25519>, 0) = 0x3000",
      "1700000000.000010 mmap(NULL, 4096, PROT_READ, MAP_PRIVATE, 7</sandbox/home/forge/.ssh/id_ed25519>, 0) = -1 EACCES (Permission denied)",
      '1700000000.000011 unlink("cwd-relative.txt") = -1 ENOENT (No such file or directory)',
      '1700000000.000012 execveat(8, "", ["payload"], 0x0, AT_EMPTY_PATH) = -1 EBADF (Bad file descriptor)',
      '1700000000.000013 execveat(8</sandbox/workspace/bin>, "tool", ["tool"], 0x0, 0) = -1 EACCES (Permission denied)',
      "1700000000.000014 getdents64(9, 0x0, 32768) = 64",
      "1700000000.000015 getdents64(9</sandbox/workspace>, 0x0, 32768) = 64",
      "1700000000.000016 kill(99, 0) = 0",
      "1700000000.000017 kill(99, SIGTERM) = -1 EPERM (Operation not permitted)",
      '1700000000.000018 execveat(AT_FDCWD</sandbox/workspace>, "truncated"..., ["tool"], 0x0, 0) = -1 ENOENT (No such file or directory)',
      '1700000000.000019 mkdirat(AT_FDCWD</opt/target>, "node_modules/cache", 0755) = 0',
      "1700000000.000020 sendto(3<NETLINK:[ROUTE:123]>, 0x0, 32, 0, {sa_family=AF_NETLINK}, 12) = 32",
      "1700000000.000021 recvmsg(4<UNIX-STREAM:[124]>, 0x0, 0) = 16",
      '1700000000.000022 openat(AT_FDCWD</sandbox/workspace>, "covered.txt", O_WRONLY|O_CREAT|O_TRUNC, 0600) = 5</sandbox/workspace/covered.txt>',
      '1700000000.000023 mkdirat(AT_FDCWD</run/host/workspace>, "mapped", 0755) = 0',
      "1700000000.000024 getdents64(10</opt/target/node_modules>, 0x0, 32768) = 256",
      "1700000000.000025 sendmsg(11<UDP:[500]>, 0x0, 0) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)",
      '1700000000.000026 openat(AT_FDCWD</sandbox/workspace>, "denied-covered.txt", O_WRONLY|O_CREAT|O_TRUNC, 0600) = -1 EACCES (Permission denied)',
    ]);

    const classified = classifyPolicyRelevantTraceGaps(records, {
      maxExamples: 3,
      pathMappings: [
        {
          observedPrefix: "/run/host/workspace",
          containerPrefix: "/sandbox/workspace",
        },
      ],
    });

    expect(classified).toEqual({
      recordCount: 18,
      categoryCounts: [
        { category: "filesystem_mutation", recordCount: 6 },
        { category: "data_transfer", recordCount: 2 },
        { category: "escape_or_interference", recordCount: 2 },
        { category: "opaque_io", recordCount: 1 },
        { category: "alternate_file_access", recordCount: 3 },
        { category: "unresolved_path", recordCount: 4 },
      ],
      syscallCounts: [
        { syscall: "execveat", recordCount: 2 },
        { syscall: "getdents64", recordCount: 2 },
        { syscall: "io_uring_enter", recordCount: 1 },
        { syscall: "kill", recordCount: 1 },
        { syscall: "mkdirat", recordCount: 1 },
        { syscall: "mmap", recordCount: 2 },
        { syscall: "openat", recordCount: 3 },
        { syscall: "ptrace", recordCount: 1 },
        { syscall: "rename", recordCount: 2 },
        { syscall: "sendmsg", recordCount: 1 },
        { syscall: "sendto", recordCount: 1 },
        { syscall: "unlink", recordCount: 1 },
      ],
      outcomeCounts: [
        { outcome: "succeeded", recordCount: 7 },
        { outcome: "failed", recordCount: 10 },
        { outcome: "unknown", recordCount: 1 },
      ],
      examples: [
        {
          category: "filesystem_mutation",
          syscall: "rename",
          rawRef: "raw/gap-tool/strace.42:1",
          outcome: "succeeded",
        },
        {
          category: "filesystem_mutation",
          syscall: "rename",
          rawRef: "raw/gap-tool/strace.42:2",
          outcome: "failed",
        },
        {
          category: "filesystem_mutation",
          syscall: "openat",
          rawRef: "raw/gap-tool/strace.42:3",
          outcome: "succeeded",
        },
      ],
      truncatedExampleCount: 15,
    });

    const manyRecords = parseRecords(
      Array.from({ length: maxPolicyRelevantTraceGapExamples + 4 }, (_, index) =>
        `1700000001.${String(index).padStart(6, "0")} sendmsg(4<UDP:[1]>, 0x0, 0) = -1 EAGAIN (Resource temporarily unavailable)`,
      ),
    );
    const bounded = classifyPolicyRelevantTraceGaps(manyRecords, {
      maxExamples: 10_000,
    });
    expect(bounded.recordCount).toBe(maxPolicyRelevantTraceGapExamples + 4);
    expect(bounded.examples).toHaveLength(maxPolicyRelevantTraceGapExamples);
    expect(bounded.truncatedExampleCount).toBe(4);
    expect(() =>
      classifyPolicyRelevantTraceGaps(records, { maxExamples: -1 }),
    ).toThrow(/nonnegative safe integer/);
  });

  it("bounds metadata-probe gaps to resolvable relevant paths", () => {
    const records = parseRecords([
      '1700000002.000001 statx(AT_FDCWD</run/host/workspace>, "note.txt", AT_STATX_SYNC_AS_STAT, STATX_ALL, 0x0) = 0',
      '1700000002.000002 access("/sandbox/home/forge/.ssh/missing", R_OK) = -1 ENOENT (No such file or directory)',
      '1700000002.000003 readlinkat(8</sandbox/home/forge>, "very-long-target"..., 0x0, 256) = -1 ENAMETOOLONG (File name too long)',
      '1700000002.000004 stat("/sandbox/workspace/very-long-target"..., 0x0) = -1 ENOENT (No such file or directory)',
      "1700000002.000005 fstat(9</sandbox/workspace/note.txt>, 0x0) = 0",
      '1700000002.000006 newfstatat(AT_FDCWD, "relative-with-unknown-cwd", 0x0, 0) = -1 ENOENT (No such file or directory)',
      '1700000002.000007 faccessat2(AT_FDCWD</opt/target>, "package.json", R_OK, 0) = 0',
      '1700000002.000008 readlink("/usr/bin/node", 0x0, 256) = 16',
      "1700000002.000009 fstat(10<pipe:[123]>, 0x0) = 0",
      '1700000002.000010 access("relative-with-unknown-cwd", R_OK) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      '1700000002.000011 faccessat2(AT_FDCWD</sandbox/workspace>, "relative-known", R_OK, 0) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      '1700000002.000012 stat("relative-success-with-unknown-cwd", 0x0) = 0',
      '1700000002.000013 stat("relative-truncated-success"..., 0x0) = 0',
    ]);

    const classified = classifyPolicyRelevantTraceGaps(records, {
      pathMappings: [
        {
          observedPrefix: "/run/host/workspace",
          containerPrefix: "/sandbox/workspace",
        },
      ],
    });

    expect(classified).toMatchObject({
      recordCount: 10,
      categoryCounts: [
        { category: "alternate_file_access", recordCount: 4 },
        { category: "unresolved_path", recordCount: 6 },
      ],
      syscallCounts: [
        { syscall: "access", recordCount: 2 },
        { syscall: "faccessat2", recordCount: 1 },
        { syscall: "fstat", recordCount: 1 },
        { syscall: "newfstatat", recordCount: 1 },
        { syscall: "readlinkat", recordCount: 1 },
        { syscall: "stat", recordCount: 3 },
        { syscall: "statx", recordCount: 1 },
      ],
      outcomeCounts: [
        { outcome: "succeeded", recordCount: 4 },
        { outcome: "failed", recordCount: 4 },
        { outcome: "unknown", recordCount: 2 },
      ],
      truncatedExampleCount: 5,
    });
  });

  it("classifies ordinary TCP and UDP descriptor I/O as data transfer", () => {
    const records = parseRecords([
      '1700000001.000001 write(20<TCP:[127.0.0.1:4000->198.51.100.2:443]>, "request", 7) = 7',
      '1700000001.000002 write(20<TCP:[127.0.0.1:4000->198.51.100.2:443]>, "request", 7) = -1 EPIPE (Broken pipe)',
      '1700000001.000003 writev(21<UDP:[127.0.0.1:5000->198.51.100.3:53]>, 0x0, 1) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      '1700000001.000004 read(20<TCP:[127.0.0.1:4000->198.51.100.2:443]>, "reply", 5) = 5',
      '1700000001.000005 readv(21<UDP:[127.0.0.1:5000->198.51.100.3:53]>, 0x0, 1) = 0',
      '1700000001.000006 read(20<TCP:[127.0.0.1:4000->198.51.100.2:443]>, 0x0, 5) = -1 EAGAIN (Resource temporarily unavailable)',
      '1700000001.000007 write(22<UNIX-STREAM:[600]>, "local", 5) = 5',
      '1700000001.000008 read(22<UNIX-STREAM:[600]>, "local", 5) = 5',
      '1700000001.000009 write(23<pipe:[700]>, "pipe", 4) = 4',
    ]);

    expect(
      classifyPolicyRelevantTraceGaps(records, { maxExamples: 10 }),
    ).toEqual({
      recordCount: 4,
      categoryCounts: [{ category: "data_transfer", recordCount: 4 }],
      syscallCounts: [
        { syscall: "read", recordCount: 1 },
        { syscall: "write", recordCount: 2 },
        { syscall: "writev", recordCount: 1 },
      ],
      outcomeCounts: [
        { outcome: "succeeded", recordCount: 2 },
        { outcome: "failed", recordCount: 1 },
        { outcome: "unknown", recordCount: 1 },
      ],
      examples: [
        {
          category: "data_transfer",
          syscall: "write",
          rawRef: "raw/gap-tool/strace.42:1",
          outcome: "succeeded",
        },
        {
          category: "data_transfer",
          syscall: "write",
          rawRef: "raw/gap-tool/strace.42:2",
          outcome: "failed",
        },
        {
          category: "data_transfer",
          syscall: "writev",
          rawRef: "raw/gap-tool/strace.42:3",
          outcome: "unknown",
        },
        {
          category: "data_transfer",
          syscall: "read",
          rawRef: "raw/gap-tool/strace.42:4",
          outcome: "succeeded",
        },
      ],
      truncatedExampleCount: 0,
    });
  });

  it("classifies xattr reads only when their resolved path is relevant", () => {
    const records = parseRecords([
      '1700000008.000001 getxattr("/sandbox/workspace/file", "user.forge", 0x0, 256) = 4',
      '1700000008.000002 lgetxattr("/sandbox/home/forge/.ssh/key", "security.selinux", 0x0, 256) = -1 ENODATA (No data available)',
      '1700000008.000003 listxattr("/opt/target/file", 0x0, 256) = 4',
      '1700000008.000004 llistxattr("/sandbox/workspace/long-name"..., 0x0, 256) = -1 ENAMETOOLONG (File name too long)',
      '1700000008.000005 getxattr("relative-with-unknown-cwd", "user.forge", 0x0, 256) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      '1700000008.000006 fgetxattr(5</sandbox/workspace/file>, "user.forge", 0x0, 256) = 4',
      '1700000008.000007 flistxattr(6</opt/target/file>, 0x0, 256) = 4',
      '1700000008.000008 fgetxattr(7<pipe:[123]>, "user.forge", 0x0, 256) = -1 EBADF (Bad file descriptor)',
      '1700000008.000009 flistxattr(8, 0x0, 256) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)',
      '1700000008.000010 listxattr("relative-with-unknown-cwd", 0x0, 256) = -1 ENOENT (No such file or directory)',
      '1700000008.000011 getxattr("relative-success-with-unknown-cwd", "user.forge", 0x0, 256) = 4',
      '1700000008.000012 llistxattr("relative-truncated-success"..., 0x0, 256) = 4',
    ]);

    expect(
      classifyPolicyRelevantTraceGaps(records, { maxExamples: 10 }),
    ).toMatchObject({
      recordCount: 8,
      categoryCounts: [
        { category: "alternate_file_access", recordCount: 3 },
        { category: "unresolved_path", recordCount: 5 },
      ],
      syscallCounts: [
        { syscall: "fgetxattr", recordCount: 1 },
        { syscall: "getxattr", recordCount: 3 },
        { syscall: "lgetxattr", recordCount: 1 },
        { syscall: "listxattr", recordCount: 1 },
        { syscall: "llistxattr", recordCount: 2 },
      ],
      outcomeCounts: [
        { outcome: "succeeded", recordCount: 4 },
        { outcome: "failed", recordCount: 3 },
        { outcome: "unknown", recordCount: 1 },
      ],
      truncatedExampleCount: 0,
    });
  });

  it("classifies captured legacy Linux AIO as opaque I/O", () => {
    const records = parseRecords([
      "1700000009.000001 io_setup(128, [0x7f00]) = 0",
      "1700000009.000002 io_destroy(0x7f00) = -1 EINVAL (Invalid argument)",
      "1700000009.000003 io_submit(0x7f00, 1, 0x0) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)",
      "1700000009.000004 io_cancel(0x7f00, 0x0, 0x0) = 0",
      "1700000009.000005 io_getevents(0x7f00, 1, 2, 0x0, NULL) = 2",
      "1700000009.000006 io_pgetevents(0x7f00, 1, 2, 0x0, NULL, NULL) = -1 EINTR (Interrupted system call)",
      "1700000009.000007 io_pgetevents_time64(0x7f00, 1, 2, 0x0, NULL, NULL) = ? ERESTARTSYS (To be restarted if SA_RESTART is set)",
    ]);

    expect(
      classifyPolicyRelevantTraceGaps(records, { maxExamples: 10 }),
    ).toMatchObject({
      recordCount: 7,
      categoryCounts: [{ category: "opaque_io", recordCount: 7 }],
      syscallCounts: [
        { syscall: "io_cancel", recordCount: 1 },
        { syscall: "io_destroy", recordCount: 1 },
        { syscall: "io_getevents", recordCount: 1 },
        { syscall: "io_pgetevents", recordCount: 1 },
        { syscall: "io_pgetevents_time64", recordCount: 1 },
        { syscall: "io_setup", recordCount: 1 },
        { syscall: "io_submit", recordCount: 1 },
      ],
      outcomeCounts: [
        { outcome: "succeeded", recordCount: 3 },
        { outcome: "failed", recordCount: 2 },
        { outcome: "unknown", recordCount: 2 },
      ],
      truncatedExampleCount: 0,
    });
  });

  it("excludes signal-zero probes using each syscall's signal argument", () => {
    const records = parseRecords([
      "1700000007.000001 kill(101, 0) = 0",
      "1700000007.000002 tkill(102, 0) = 0",
      "1700000007.000003 tgkill(100, 103, 0) = 0",
      "1700000007.000004 pidfd_send_signal(5, 0, NULL, 0) = 0",
      "1700000007.000005 kill(101, SIGTERM) = 0",
      "1700000007.000006 tkill(102, 9) = 0",
      "1700000007.000007 tgkill(100, 103, SIGUSR1) = 0",
      "1700000007.000008 pidfd_send_signal(5, SIGKILL, NULL, 0) = -1 EPERM (Operation not permitted)",
    ]);

    expect(classifyPolicyRelevantTraceGaps(records)).toMatchObject({
      recordCount: 4,
      categoryCounts: [
        { category: "escape_or_interference", recordCount: 4 },
      ],
      syscallCounts: [
        { syscall: "kill", recordCount: 1 },
        { syscall: "pidfd_send_signal", recordCount: 1 },
        { syscall: "tgkill", recordCount: 1 },
        { syscall: "tkill", recordCount: 1 },
      ],
      outcomeCounts: [
        { outcome: "succeeded", recordCount: 3 },
        { outcome: "failed", recordCount: 1 },
      ],
      truncatedExampleCount: 0,
    });
  });

  it("classifies non-Netlink bind attempts as lossy network endpoint gaps", () => {
    const records = parseRecords([
      '1700000003.000001 bind(18<TCP:[127.0.0.1:0]>, {sa_family=AF_INET, sin_port=htons(0), sin_addr=inet_addr("127.0.0.1")}, 16) = 0',
      '1700000003.000002 bind(19<UDP:[0.0.0.0:5353]>, {sa_family=AF_INET, sin_port=htons(5353), sin_addr=inet_addr("0.0.0.0")}, 16) = -1 EACCES (Permission denied)',
      '1700000003.000003 bind(20<UNIX-STREAM:[991]>, {sa_family=AF_UNIX, sun_path="/tmp/forge.sock"}, 110) = 0',
      "1700000003.000004 bind(21<NETLINK:[ROUTE:401]>, {sa_family=AF_NETLINK, nl_pid=0, nl_groups=0}, 12) = 0",
      "1700000003.000005 listen(18<TCP:[127.0.0.1:44525]>, 511) = 0",
    ]);

    expect(classifyPolicyRelevantTraceGaps(records)).toEqual({
      recordCount: 3,
      categoryCounts: [
        { category: "network_endpoint", recordCount: 3 },
      ],
      syscallCounts: [{ syscall: "bind", recordCount: 3 }],
      outcomeCounts: [
        { outcome: "succeeded", recordCount: 2 },
        { outcome: "failed", recordCount: 1 },
      ],
      examples: [
        {
          category: "network_endpoint",
          syscall: "bind",
          rawRef: "raw/gap-tool/strace.42:1",
          outcome: "succeeded",
        },
        {
          category: "network_endpoint",
          syscall: "bind",
          rawRef: "raw/gap-tool/strace.42:2",
          outcome: "failed",
        },
        {
          category: "network_endpoint",
          syscall: "bind",
          rawRef: "raw/gap-tool/strace.42:3",
          outcome: "succeeded",
        },
      ],
      truncatedExampleCount: 0,
    });
  });

  it("normalizes termination by signal and preserves its raw reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-normalizer-signal-"));
    const store = await EvidenceStore.create(root, "run-signal");
    const raw = store.pathFor("raw/signal-tool");
    await mkdir(raw, { recursive: true });
    await writeFile(
      join(raw, "strace.42"),
      [
        "1700000000.000001 --- SIGTERM {si_signo=SIGTERM, si_code=SI_USER} ---",
        "1700000000.000002 +++ killed by SIGTERM +++",
      ].join("\n"),
      "utf8",
    );

    const events = await normalizeExperiment({
      store,
      runId: "run-signal",
      experimentId: "signal-tool",
    });
    const exit = events.find((event) => event.effect.kind === "process.exit");

    expect(exit).toMatchObject({
      processRef: "run-signal:signal-tool:pid-42",
      effect: { kind: "process.exit", signal: "SIGTERM" },
      source: { rawRef: "raw/signal-tool/strace.42:2" },
    });
  });
});
