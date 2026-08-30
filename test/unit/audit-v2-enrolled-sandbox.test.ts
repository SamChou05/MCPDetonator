import { describe, expect, it } from "vitest";

import { digestCanonicalJson } from "../../src/audit/v2/canonical.js";
import {
  CONTROLLED_OUTCOME_BOUNDS,
  CONTROLLED_SANDBOX_IMAGE_ID,
  CONTROLLED_SANDBOX_IMAGE_REFERENCE,
} from "../../src/audit/v2/controlled-fixture.js";
import {
  computeEnrolledBackendProfileDigest,
  computeEnrolledDockerInvocationDigest,
  createEnrolledNodeStdioDockerInvocation,
  verifyEnrolledDockerInvocationBinding,
  type EnrolledNodeStdioDockerInvocation,
  type NormalizedEnrolledNodeInvocationForSandbox,
  type VerifiedV2SandboxImage,
} from "../../src/audit/v2/enrolled-sandbox.js";
import { MCP_STDIO_MESSAGE_BUFFER_BYTES } from "../../src/sandbox/docker.js";
import type { PreparedTarget } from "../../src/target/prepare.js";
import type { ExecutionBoundsV2 } from "../../src/contracts/v2/index.js";

const MANIFEST_DIGEST = "a".repeat(64);
const DEFAULT_TARGET_ROOT = "/private/tmp/forge-enrolled-target";
const DEFAULT_RESOURCE_ROOT = "/private/tmp/forge-enrolled-resources";

function normalizedRuntime(options: {
  readonly entrypoint?: string;
  readonly applicationArgs?: readonly string[];
} = {}): NormalizedEnrolledNodeInvocationForSandbox {
  const payload = {
    format: "forge.enrolled-node-invocation/v1alpha1" as const,
    transport: "stdio" as const,
    protocol: "mcp" as const,
    descriptorCommand: "node" as const,
    executable: "/usr/local/bin/node" as const,
    cwd: "/opt/target" as const,
    entrypoint: options.entrypoint ?? "/opt/target/dist/server.js",
    applicationArgs: [
      ...(options.applicationArgs ?? [
        "stdio",
        "/forge/synthetic/probe-input",
      ]),
    ],
    environment: {},
  };
  return {
    ...payload,
    digest: digestCanonicalJson(
      "forge.enrolled-node-invocation",
      "v1alpha1",
      payload,
    ),
  };
}

function verifiedImage(): VerifiedV2SandboxImage {
  return {
    imageReference: CONTROLLED_SANDBOX_IMAGE_REFERENCE,
    imageId: CONTROLLED_SANDBOX_IMAGE_ID,
    declaredVolumes: false,
  };
}

function preparedTarget(
  hostRoot = DEFAULT_TARGET_ROOT,
  containerRoot: string = "/opt/target",
): PreparedTarget {
  return {
    hostRoot,
    packageRoot: hostRoot,
    containerRoot,
    dispose: async () => undefined,
  } as PreparedTarget;
}

function createInvocation(options: {
  readonly targetRoot?: string;
  readonly targetContainerRoot?: string;
  readonly resourceRoot?: string;
  readonly manifestDigest?: string;
  readonly runtime?: NormalizedEnrolledNodeInvocationForSandbox;
  readonly bounds?: ExecutionBoundsV2;
  readonly image?: VerifiedV2SandboxImage;
} = {}): EnrolledNodeStdioDockerInvocation {
  return createEnrolledNodeStdioDockerInvocation({
    runId: "enrolled-sandbox-test",
    experimentId: "blind-one-call",
    preparedTarget: preparedTarget(
      options.targetRoot,
      options.targetContainerRoot,
    ),
    resources: {
      hostRoot: options.resourceRoot ?? DEFAULT_RESOURCE_ROOT,
      manifestDigest: options.manifestDigest ?? MANIFEST_DIGEST,
    },
    runtime: options.runtime ?? normalizedRuntime(),
    bounds: options.bounds ?? CONTROLLED_OUTCOME_BOUNDS,
    image: options.image ?? verifiedImage(),
  });
}

function mutableClone(
  invocation: EnrolledNodeStdioDockerInvocation,
): EnrolledNodeStdioDockerInvocation {
  return JSON.parse(JSON.stringify(invocation)) as EnrolledNodeStdioDockerInvocation;
}

function argumentValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (index < 0 || value === undefined) {
    throw new Error(`missing Docker argument '${flag}'`);
  }
  return value;
}

describe("enrolled Node STDIO Docker sandbox", () => {
  it("builds one immutable-image invocation with the controlled containment profile", () => {
    const invocation = createInvocation();
    const args = invocation.server.args ?? [];

    expect(argumentValue(args, "--network")).toBe("none");
    expect(argumentValue(args, "--ipc")).toBe("none");
    expect(argumentValue(args, "--log-driver")).toBe("none");
    expect(argumentValue(args, "--pull")).toBe("never");
    expect(argumentValue(args, "--user")).toBe("65534:65534");
    expect(argumentValue(args, "--cap-drop")).toBe("ALL");
    expect(argumentValue(args, "--security-opt")).toBe(
      "no-new-privileges",
    );
    expect(args).toContain("--read-only");
    expect(args).toContain("--init");
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--volume");
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--device");
    expect(args).not.toContain("--env");

    expect(
      args.filter((argument) => argument.startsWith("type=bind,")),
    ).toEqual([
      `type=bind,src=${DEFAULT_TARGET_ROOT},dst=/opt/target,readonly`,
      `type=bind,src=${DEFAULT_RESOURCE_ROOT},dst=/forge/synthetic,readonly`,
    ]);
    expect(args).toContain(
      "/dev/mqueue:ro,noexec,nosuid,nodev,size=4096,nr_inodes=1,mode=0555",
    );
    expect(args).toContain(
      `/tmp:rw,noexec,nosuid,nodev,size=${CONTROLLED_OUTCOME_BOUNDS.maxWritableBytes},nr_inodes=${CONTROLLED_OUTCOME_BOUNDS.maxWritableFiles},uid=65534,gid=65534,mode=0700`,
    );

    const imageIndex = args.indexOf(CONTROLLED_SANDBOX_IMAGE_ID);
    expect(imageIndex).toBeGreaterThan(0);
    expect(args).not.toContain(CONTROLLED_SANDBOX_IMAGE_REFERENCE);
    expect(args.slice(imageIndex)).toEqual([
      CONTROLLED_SANDBOX_IMAGE_ID,
      "-i",
      "HOME=/tmp",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "NODE_ENV=production",
      "/usr/local/bin/node",
      "/opt/target/dist/server.js",
      "stdio",
      "/forge/synthetic/probe-input",
    ]);

    expect(invocation.backend).toMatchObject({
      executionClass: "enrolled_node_stdio_single_call",
      network: "none",
      ipc: "none",
      logDriver: "none",
      maxCalls: 1,
      maxRetries: 0,
      sandboxImageId: CONTROLLED_SANDBOX_IMAGE_ID,
      imageHasDeclaredVolumes: false,
      readonlyTargetMount: true,
      readonlySyntheticResourceMount: true,
      readonlyMessageQueueMount: true,
      writableRootFilesystem: false,
      writableHostBinds: false,
      providerAvailable: false,
      cleanupVerification: true,
    });
    expect(invocation.server.maxBufferSize).toBe(
      MCP_STDIO_MESSAGE_BUFFER_BYTES,
    );
    expect(Object.isFrozen(invocation)).toBe(true);
    expect(Object.isFrozen(invocation.server)).toBe(true);
    expect(Object.isFrozen(invocation.server.args)).toBe(true);
    expect(Object.isFrozen(invocation.backend)).toBe(true);
    expect(Object.isFrozen(invocation.backend.containerProcess.runtime)).toBe(
      true,
    );
    expect(verifyEnrolledDockerInvocationBinding(invocation)).toEqual({
      backendProfileDigest: invocation.backendProfileDigest,
      invocationDigest: invocation.invocationDigest,
    });
  });

  it("rejects mutated Docker flags, extra process settings, and weakened profile claims", () => {
    const original = createInvocation();

    const networkMutation = mutableClone(original) as unknown as {
      server: { args: string[] };
    };
    const networkIndex = networkMutation.server.args.indexOf("--network");
    networkMutation.server.args[networkIndex + 1] = "bridge";
    expect(() =>
      verifyEnrolledDockerInvocationBinding(
        networkMutation as unknown as EnrolledNodeStdioDockerInvocation,
      ),
    ).toThrow(/argument vector/u);

    const extraEnvironment = mutableClone(original) as unknown as {
      server: Record<string, unknown>;
    };
    extraEnvironment.server.env = { HOST_TOKEN: "must-not-propagate" };
    expect(() =>
      verifyEnrolledDockerInvocationBinding(
        extraEnvironment as unknown as EnrolledNodeStdioDockerInvocation,
      ),
    ).toThrow(/server parameters/u);

    const backendMutation = mutableClone(original) as unknown as {
      backend: { network: string };
    };
    backendMutation.backend.network = "bridge";
    expect(() =>
      verifyEnrolledDockerInvocationBinding(
        backendMutation as unknown as EnrolledNodeStdioDockerInvocation,
      ),
    ).toThrow(/weakened/u);

    const writableMount = mutableClone(original) as unknown as {
      backend: { targetMount: { readonly: boolean } };
    };
    writableMount.backend.targetMount.readonly = false;
    expect(() =>
      verifyEnrolledDockerInvocationBinding(
        writableMount as unknown as EnrolledNodeStdioDockerInvocation,
      ),
    ).toThrow(/weakened/u);

    const unknownProfileField = mutableClone(original) as unknown as {
      backend: Record<string, unknown>;
    };
    unknownProfileField.backend.unreviewedSetting = true;
    expect(() =>
      verifyEnrolledDockerInvocationBinding(
        unknownProfileField as unknown as EnrolledNodeStdioDockerInvocation,
      ),
    ).toThrow(/unknown or missing fields/u);
  });

  it("validates exact private bind sources and binds them into the backend profile", () => {
    const first = createInvocation();
    const concurrent = createInvocation();
    const differentTarget = createInvocation({
      targetRoot: "/private/tmp/forge-enrolled-target-two",
    });

    expect(concurrent.backendProfileDigest).toBe(first.backendProfileDigest);
    expect(concurrent.containerName).not.toBe(first.containerName);
    expect(concurrent.invocationDigest).not.toBe(first.invocationDigest);
    expect(differentTarget.backendProfileDigest).not.toBe(
      first.backendProfileDigest,
    );

    for (const targetRoot of [
      "relative/target",
      "/",
      "/private/tmp/target,second",
      "/private/tmp/target/../target",
      "/private/tmp/target\nsecond",
      `/${"é".repeat(2_050)}`,
      "/private/tmp/\ud800",
    ]) {
      expect(() => createInvocation({ targetRoot })).toThrow(
        /bind source|invalid Unicode/u,
      );
    }
    expect(() =>
      createInvocation({ targetContainerRoot: "/workspace" }),
    ).toThrow(/destination/u);
    expect(() =>
      createInvocation({ resourceRoot: DEFAULT_TARGET_ROOT }),
    ).toThrow(/must be distinct/u);
    expect(() => createInvocation({ manifestDigest: "not-a-digest" })).toThrow(
      /manifest digest/u,
    );
  });

  it("accepts only the reviewed immutable image identity with no declared volumes", () => {
    expect(() =>
      createInvocation({
        image: {
          ...verifiedImage(),
          imageId: `sha256:${"b".repeat(64)}`,
        } as unknown as VerifiedV2SandboxImage,
      }),
    ).toThrow(/exact verified immutable V2 image/u);
    expect(() =>
      createInvocation({
        image: {
          ...verifiedImage(),
          imageReference: "forge-sandbox:latest",
        } as unknown as VerifiedV2SandboxImage,
      }),
    ).toThrow(/exact verified immutable V2 image/u);
    expect(() =>
      createInvocation({
        image: {
          ...verifiedImage(),
          declaredVolumes: true,
        } as unknown as VerifiedV2SandboxImage,
      }),
    ).toThrow(/without declared volumes/u);
  });

  it("places only validated application arguments after the fixed Node entrypoint", () => {
    const selectedRuntime = normalizedRuntime({
      entrypoint: "/opt/target/build/index.mjs",
      applicationArgs: ["stdio", "/forge/synthetic/input.json"],
    });
    const invocation = createInvocation({ runtime: selectedRuntime });
    const args = invocation.server.args ?? [];
    const executableIndex = args.indexOf("/usr/local/bin/node");
    expect(args.slice(executableIndex)).toEqual([
      "/usr/local/bin/node",
      "/opt/target/build/index.mjs",
      "stdio",
      "/forge/synthetic/input.json",
    ]);

    const invalidRuntimes: NormalizedEnrolledNodeInvocationForSandbox[] = [
      normalizedRuntime({ entrypoint: "/etc/server.js" }),
      normalizedRuntime({ entrypoint: "/opt/target/../server.js" }),
      normalizedRuntime({ applicationArgs: ["line\nfeed"] }),
      normalizedRuntime({ applicationArgs: ["--require=./preload.cjs"] }),
      normalizedRuntime({ applicationArgs: ["/etc/passwd"] }),
      normalizedRuntime({ applicationArgs: ["windows\\path"] }),
      normalizedRuntime({ applicationArgs: Array(33).fill("argument") }),
      {
        ...normalizedRuntime(),
        executable: "/usr/bin/node",
      } as unknown as NormalizedEnrolledNodeInvocationForSandbox,
      {
        ...normalizedRuntime(),
        environment: { TOKEN: "host-secret" },
      } as unknown as NormalizedEnrolledNodeInvocationForSandbox,
      {
        ...normalizedRuntime(),
        digest: "b".repeat(64),
      },
    ];
    for (const runtime of invalidRuntimes) {
      expect(() => createInvocation({ runtime })).toThrow();
    }
  });

  it("rejects bounds that cannot be represented by the hard Docker profile", () => {
    expect(() =>
      createInvocation({
        bounds: {
          ...CONTROLLED_OUTCOME_BOUNDS,
          maxCpuMs: CONTROLLED_OUTCOME_BOUNDS.maxCpuMs + 1,
        },
      }),
    ).toThrow(/whole-second CPU bounds/u);
    expect(() =>
      createInvocation({
        bounds: {
          ...CONTROLLED_OUTCOME_BOUNDS,
          maxOutputBytesPerStep: MCP_STDIO_MESSAGE_BUFFER_BYTES + 1,
          maxTotalOutputBytes: MCP_STDIO_MESSAGE_BUFFER_BYTES + 1,
        },
      }),
    ).toThrow(/hard MCP message buffer/u);
    expect(() =>
      createInvocation({
        bounds: {
          ...CONTROLLED_OUTCOME_BOUNDS,
          maxMemoryMb: 0,
        },
      }),
    ).toThrow();
  });

  it("binds the complete frozen profile and exact Docker vector into separate digests", () => {
    const invocation = createInvocation();
    expect(invocation.backendProfileDigest).toBe(
      computeEnrolledBackendProfileDigest(invocation.backend),
    );
    expect(invocation.invocationDigest).toBe(
      computeEnrolledDockerInvocationDigest(invocation),
    );

    const profileMutation = mutableClone(invocation) as unknown as {
      backend: { syntheticResourceMount: { source: string } };
    };
    profileMutation.backend.syntheticResourceMount.source =
      "/private/tmp/substituted-resources";
    expect(() =>
      verifyEnrolledDockerInvocationBinding(
        profileMutation as unknown as EnrolledNodeStdioDockerInvocation,
      ),
    ).toThrow(/profile digest/u);

    const invocationDigestMutation = mutableClone(invocation) as unknown as {
      invocationDigest: string;
    };
    invocationDigestMutation.invocationDigest = "c".repeat(64);
    expect(() =>
      verifyEnrolledDockerInvocationBinding(
        invocationDigestMutation as unknown as EnrolledNodeStdioDockerInvocation,
      ),
    ).toThrow(/invocation digest/u);
  });
});
