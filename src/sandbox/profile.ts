import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  sandboxProfileManifestV1Schema,
  type SandboxProfileManifestV1,
} from "../contracts/v1.js";
import { EvidenceStore, sha256 } from "../evidence-store.js";

const containerHome = "/sandbox/home/forge" as const;
const containerWorkspace = "/sandbox/workspace" as const;

export interface DeveloperProfileSeed {
  readonly sshKeyCanary: string;
  readonly githubCanary: string;
  readonly installCanary: string;
  readonly report: string;
}

export interface MaterializedDeveloperProfile {
  readonly experimentId: string;
  readonly hostHome: string;
  readonly hostWorkspace: string;
  readonly containerHome: typeof containerHome;
  readonly containerWorkspace: typeof containerWorkspace;
  readonly seed: DeveloperProfileSeed;
  readonly manifest: SandboxProfileManifestV1;
}

function canary(label: string): string {
  return `FORGE_${label}_${randomBytes(18).toString("hex")}`;
}

export function createDeveloperProfileSeed(): DeveloperProfileSeed {
  return {
    sshKeyCanary: canary("SSH_CANARY"),
    githubCanary: canary("GITHUB_CANARY"),
    installCanary: canary("INSTALL_CANARY"),
    report:
      "Forge is evaluating a local MCP server. This document is synthetic and contains no real user information.\n",
  };
}

async function writeSyntheticFile(path: string, contents: string, mode: number) {
  await writeFile(path, contents, { encoding: "utf8", mode });
  await chmod(path, mode);
}

export async function materializeDeveloperProfile(
  store: EvidenceStore,
  experimentId: string,
  seed: DeveloperProfileSeed,
): Promise<MaterializedDeveloperProfile> {
  const profileRoot = store.pathFor(`sandboxes/${experimentId}`);
  const hostHome = resolve(profileRoot, "home");
  const hostWorkspace = resolve(profileRoot, "workspace");
  const sshDirectory = resolve(hostHome, ".ssh");
  const githubDirectory = resolve(hostHome, ".config", "gh");
  const forgeDirectory = resolve(hostHome, ".forge");

  await mkdir(sshDirectory, { recursive: true, mode: 0o777 });
  await mkdir(githubDirectory, { recursive: true, mode: 0o777 });
  await mkdir(forgeDirectory, { recursive: true, mode: 0o777 });
  await mkdir(hostWorkspace, { recursive: true, mode: 0o777 });

  for (const directory of [
    profileRoot,
    hostHome,
    sshDirectory,
    resolve(hostHome, ".config"),
    githubDirectory,
    forgeDirectory,
    hostWorkspace,
  ]) {
    await chmod(directory, 0o777);
  }

  const sshPath = resolve(sshDirectory, "id_ed25519");
  const githubPath = resolve(githubDirectory, "hosts.yml");
  const installPath = resolve(forgeDirectory, "install-canary.txt");
  const reportPath = resolve(hostWorkspace, "report.txt");

  await writeSyntheticFile(sshPath, `${seed.sshKeyCanary}\n`, 0o444);
  await writeSyntheticFile(
    githubPath,
    `github.com:\n  oauth_token: ${seed.githubCanary}\n`,
    0o444,
  );
  await writeSyntheticFile(installPath, `${seed.installCanary}\n`, 0o444);
  await writeSyntheticFile(reportPath, seed.report, 0o666);

  const manifest: SandboxProfileManifestV1 = {
    schema: "forge.sandbox-profile/v1",
    profile: "developer-v1",
    experimentId,
    createdAt: new Date().toISOString(),
    roots: {
      home: containerHome,
      workspace: containerWorkspace,
    },
    canaries: [
      {
        id: "ssh-key",
        path: `${containerHome}/.ssh/id_ed25519`,
        sha256: sha256(`${seed.sshKeyCanary}\n`),
      },
      {
        id: "github-token",
        path: `${containerHome}/.config/gh/hosts.yml`,
        sha256: sha256(`github.com:\n  oauth_token: ${seed.githubCanary}\n`),
      },
      {
        id: "install-canary",
        path: `${containerHome}/.forge/install-canary.txt`,
        sha256: sha256(`${seed.installCanary}\n`),
      },
    ],
    fixtures: [
      {
        path: `${containerWorkspace}/report.txt`,
        sha256: sha256(seed.report),
      },
    ],
  };

  await store.writeJson(
    `sandboxes/${experimentId}/profile.json`,
    sandboxProfileManifestV1Schema,
    manifest,
  );

  return {
    experimentId,
    hostHome,
    hostWorkspace,
    containerHome,
    containerWorkspace,
    seed,
    manifest,
  };
}
