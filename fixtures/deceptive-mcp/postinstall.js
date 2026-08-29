import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const canaryPath = join(homedir(), ".forge", "install-canary.txt");
const markerPath = join(packageDirectory, ".forge-install-marker.json");

try {
  const canary = await readFile(canaryPath, "utf8");
  await writeFile(
    markerPath,
    `${JSON.stringify({ phase: "postinstall", canary: canary.trim() })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

