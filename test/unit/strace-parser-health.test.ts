import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readExperimentStrace,
  readExperimentStraceDetailed,
  straceHealthMaxExampleRawRefs,
  straceHealthMaxTraceFileDetails,
  type StraceParseHealth,
} from "../../src/observe/strace-parser.js";

async function createRawDirectory(experimentId: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forge-strace-parser-health-"));
  const rawDirectory = join(root, experimentId);
  await mkdir(rawDirectory, { recursive: true });
  return rawDirectory;
}

function expectExactAccounting(health: StraceParseHealth): void {
  expect(health.parsedRecordCount).toBe(
    health.parsedSyscallRecordCount +
      health.parsedSignalTerminationRecordCount,
  );
  expect(health.recognizedControlLineCount).toBe(
    health.recognizedExitControlLineCount +
      health.recognizedSignalDeliveryControlLineCount,
  );
  expect(health.nonemptyLineCount).toBe(
    health.parsedRecordCount +
      health.recognizedControlLineCount +
      health.unfinishedLineCount +
      health.resumedLineCount +
      health.malformedLineCount,
  );
  expect(health.traceFileCount).toBe(
    health.terminalMarkerPresentTraceFileCount +
      health.missingTerminalMarkerTraceFileCount,
  );
  expect(health.traceFileCount).toBe(
    health.traceFileDetails.length + health.traceFileDetailOmittedCount,
  );
}

describe("strace parser health", () => {
  it("accounts for parsed records, control lines, terminal markers, and abbreviated strings", async () => {
    const rawDirectory = await createRawDirectory("healthy-tool");
    await writeFile(
      join(rawDirectory, "strace.10"),
      [
        '1700000000.000001 write(1</tmp/output>, "literal <unfinished ...> text", 29) = 29',
        '1700000000.000002 writev(1</tmp/output>, [{iov_base="alpha"..., iov_len=9}, {iov_base="beta"..., iov_len=8}], 2) = 17',
        "1700000000.000003 --- SIGCHLD {si_signo=SIGCHLD, si_code=CLD_EXITED} ---",
        "1700000000.000004 +++ exited with 0 +++",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(rawDirectory, "strace.20"),
      [
        "1700000000.000005 exit_group(0) = ?",
        "1700000000.000006 +++ killed by SIGKILL (core dumped) +++",
      ].join("\n"),
      "utf8",
    );

    const result = await readExperimentStraceDetailed(
      rawDirectory,
      "healthy-tool",
    );

    expect(result.records).toHaveLength(4);
    expect(result.health).toMatchObject({
      traceDirectoryPresent: true,
      traceFileCount: 2,
      nonemptyLineCount: 6,
      parsedRecordCount: 4,
      parsedSyscallRecordCount: 3,
      parsedSignalTerminationRecordCount: 1,
      recognizedControlLineCount: 2,
      recognizedExitControlLineCount: 1,
      recognizedSignalDeliveryControlLineCount: 1,
      unfinishedLineCount: 0,
      resumedLineCount: 0,
      malformedLineCount: 0,
      stringTruncationIndicatorCount: 2,
      stringTruncationLineCount: 1,
      terminalMarkerPresentTraceFileCount: 2,
      missingTerminalMarkerTraceFileCount: 0,
      traceFileDetailOmittedCount: 0,
      integrityComplete: true,
    });
    expect(result.health.stringTruncationRawRefs).toEqual([
      "raw/healthy-tool/strace.10:2",
    ]);
    expect(result.health.traceFileDetails).toEqual([
      {
        rawRef: "raw/healthy-tool/strace.10",
        pid: 10,
        nonemptyLineCount: 4,
        terminalMarker: {
          status: "present",
          kind: "exit",
          rawRef: "raw/healthy-tool/strace.10:4",
        },
      },
      {
        rawRef: "raw/healthy-tool/strace.20",
        pid: 20,
        nonemptyLineCount: 2,
        terminalMarker: {
          status: "present",
          kind: "signal-termination",
          rawRef: "raw/healthy-tool/strace.20:2",
        },
      },
    ]);
    expectExactAccounting(result.health);
  });

  it("separates unfinished, resumed, and malformed lines and requires a final terminal marker", async () => {
    const rawDirectory = await createRawDirectory("damaged-tool");
    const malformedLines = Array.from(
      { length: straceHealthMaxExampleRawRefs + 2 },
      (_, index) => `malformed line ${index + 1}`,
    );
    await writeFile(
      join(rawDirectory, "strace.42"),
      [
        '1700000000.000001 execve("/usr/bin/node"..., ["node"], 0x0) = 0',
        '1700000000.000002 read(3</tmp/input>, "abc", 3 <unfinished ...>',
        "1700000000.000003 <... read resumed>\"abc\", 3) = 3",
        "1700000000.000004 +++ exited with 0 +++",
        ...malformedLines,
      ].join("\n"),
      "utf8",
    );

    const result = await readExperimentStraceDetailed(
      rawDirectory,
      "damaged-tool",
    );

    expect(result.health).toMatchObject({
      nonemptyLineCount: 11,
      parsedRecordCount: 1,
      parsedSyscallRecordCount: 1,
      parsedSignalTerminationRecordCount: 0,
      recognizedControlLineCount: 1,
      recognizedExitControlLineCount: 1,
      unfinishedLineCount: 1,
      resumedLineCount: 1,
      malformedLineCount: 7,
      stringTruncationIndicatorCount: 1,
      stringTruncationLineCount: 1,
      terminalMarkerPresentTraceFileCount: 0,
      missingTerminalMarkerTraceFileCount: 1,
      integrityComplete: false,
    });
    expect(result.health.unfinishedRawRefs).toEqual([
      "raw/damaged-tool/strace.42:2",
    ]);
    expect(result.health.resumedRawRefs).toEqual([
      "raw/damaged-tool/strace.42:3",
    ]);
    expect(result.health.malformedRawRefs).toEqual(
      Array.from(
        { length: straceHealthMaxExampleRawRefs },
        (_, index) => `raw/damaged-tool/strace.42:${index + 5}`,
      ),
    );
    expect(result.health.missingTerminalMarkerTraceFileRawRefs).toEqual([
      "raw/damaged-tool/strace.42",
    ]);
    expect(result.health.traceFileDetails[0]?.terminalMarker).toEqual({
      status: "missing",
    });
    expectExactAccounting(result.health);
  });

  it("bounds every attacker-amplifiable example list", async () => {
    const rawDirectory = await createRawDirectory("bounded-tool");
    const lines: string[] = [];
    const oversizedCount = straceHealthMaxExampleRawRefs + 3;
    for (let index = 0; index < oversizedCount; index += 1) {
      lines.push(
        `1700000000.${String(index).padStart(6, "0")} read(3, "x", 1 <unfinished ...>`,
      );
      lines.push(
        `1700000001.${String(index).padStart(6, "0")} <... read resumed>"x", 1) = 1`,
      );
      lines.push(`malformed-${index}`);
      lines.push(
        `1700000002.${String(index).padStart(6, "0")} write(1, "value-${index}"..., 7) = 7`,
      );
    }
    lines.push("1700000003.000001 +++ exited with 0 +++");
    await writeFile(join(rawDirectory, "strace.9"), lines.join("\n"), "utf8");
    await Promise.all(
      Array.from({ length: oversizedCount }, (_, index) =>
        writeFile(join(rawDirectory, `strace.${100 + index}`), "", "utf8"),
      ),
    );

    const { health } = await readExperimentStraceDetailed(
      rawDirectory,
      "bounded-tool",
    );

    expect(health.unfinishedLineCount).toBe(oversizedCount);
    expect(health.resumedLineCount).toBe(oversizedCount);
    expect(health.malformedLineCount).toBe(oversizedCount);
    expect(health.stringTruncationLineCount).toBe(oversizedCount);
    expect(health.unfinishedRawRefs).toHaveLength(
      straceHealthMaxExampleRawRefs,
    );
    expect(health.resumedRawRefs).toHaveLength(straceHealthMaxExampleRawRefs);
    expect(health.malformedRawRefs).toHaveLength(straceHealthMaxExampleRawRefs);
    expect(health.stringTruncationRawRefs).toHaveLength(
      straceHealthMaxExampleRawRefs,
    );
    expect(health.missingTerminalMarkerTraceFileCount).toBe(oversizedCount);
    expect(health.missingTerminalMarkerTraceFileRawRefs).toHaveLength(
      straceHealthMaxExampleRawRefs,
    );
    expectExactAccounting(health);
  });

  it("bounds per-file details while retaining aggregate terminal accounting", async () => {
    const rawDirectory = await createRawDirectory("many-processes");
    const traceFileCount = straceHealthMaxTraceFileDetails + 1;
    await Promise.all(
      Array.from({ length: traceFileCount }, async (_, index) => {
        const pid = index + 1;
        await writeFile(
          join(rawDirectory, `strace.${pid}`),
          [
            `1700000000.${String(index).padStart(6, "0")} execve("/bin/true", ["true"], 0x0) = 0`,
            `1700000001.${String(index).padStart(6, "0")} +++ exited with 0 +++`,
          ].join("\n"),
          "utf8",
        );
      }),
    );

    const { health } = await readExperimentStraceDetailed(
      rawDirectory,
      "many-processes",
    );

    expect(health.traceFileCount).toBe(traceFileCount);
    expect(health.terminalMarkerPresentTraceFileCount).toBe(traceFileCount);
    expect(health.missingTerminalMarkerTraceFileCount).toBe(0);
    expect(health.traceFileDetails).toHaveLength(
      straceHealthMaxTraceFileDetails,
    );
    expect(health.traceFileDetailOmittedCount).toBe(1);
    expect(health.integrityComplete).toBe(true);
    expectExactAccounting(health);
  });

  it("does not treat a terminal-signal-only trace as complete observation", async () => {
    const rawDirectory = await createRawDirectory("signal-only");
    await writeFile(
      join(rawDirectory, "strace.7"),
      "1700000000.000001 +++ killed by SIGKILL +++\n",
      "utf8",
    );

    const { health } = await readExperimentStraceDetailed(
      rawDirectory,
      "signal-only",
    );

    expect(health).toMatchObject({
      parsedRecordCount: 1,
      parsedSyscallRecordCount: 0,
      parsedSignalTerminationRecordCount: 1,
      terminalMarkerPresentTraceFileCount: 1,
      missingTerminalMarkerTraceFileCount: 0,
      integrityComplete: false,
    });
    expectExactAccounting(health);
  });

  it("returns empty unhealthy detail for a missing directory without changing the legacy reader", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-strace-parser-missing-"));
    const missingDirectory = join(root, "missing");

    const result = await readExperimentStraceDetailed(
      missingDirectory,
      "missing-tool",
    );

    expect(result.records).toEqual([]);
    expect(result.health).toMatchObject({
      traceDirectoryPresent: false,
      traceFileCount: 0,
      nonemptyLineCount: 0,
      parsedRecordCount: 0,
      terminalMarkerPresentTraceFileCount: 0,
      missingTerminalMarkerTraceFileCount: 0,
      traceFileDetails: [],
      integrityComplete: false,
    });
    await expect(
      readExperimentStrace(missingDirectory, "missing-tool"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expectExactAccounting(result.health);
  });
});
