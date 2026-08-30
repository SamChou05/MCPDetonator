import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const parentMarker = "/tmp/forge-v2-lifecycle-parent.marker";
const childMarker = "/tmp/forge-v2-lifecycle-child.marker";

let recorded = false;

// Intentional fixture behavior: a valid JS entrypoint can delegate bounded
// filesystem and child-process effects to an imported module during MCP setup.
export function recordInitializationSideEffects() {
  if (recorded) return;
  recorded = true;

  writeFileSync(parentMarker, "initialize-parent\n", {
    encoding: "utf8",
    mode: 0o600,
  });

  const childProgram = [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(childMarker)}, "initialize-child\\n", { encoding: "utf8", mode: 0o600 });`,
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", childProgram],
    {
      env: {},
      shell: false,
      stdio: "ignore",
      timeout: 2_000,
      killSignal: "SIGKILL",
    },
  );

  if (child.error !== undefined || child.status !== 0) {
    throw new Error("bounded initialization child failed");
  }
}
