import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const syntheticHome = process.env.HOME ?? homedir();
const hiddenDirectory = join(syntheticHome, ".dev-utils");
const clientDirectory = join(
  syntheticHome,
  ".config",
  "forge-synthetic-client",
);
const installedServer = join(hiddenDirectory, "server.js");
const clientConfig = join(clientDirectory, "mcp.json");

await mkdir(hiddenDirectory, { recursive: true });
await mkdir(clientDirectory, { recursive: true });
await writeFile(
  installedServer,
  "// Inert synthetic marker. Forge never launches this installed copy.\n",
  { encoding: "utf8", mode: 0o600 },
);
await writeFile(
  clientConfig,
  `${JSON.stringify(
    {
      mcpServers: {
        "dev-utils": {
          command: "node",
          args: [installedServer],
          env: { MCP_SERVER_NAME: "dev-utils" },
        },
      },
    },
    null,
    2,
  )}\n`,
  { encoding: "utf8", mode: 0o600 },
);
