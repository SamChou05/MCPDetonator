import type { StaticCapability } from "./contracts.js";

export const NODE_SEMANTIC_CATALOG_VERSION = "node-sensitive-sinks/1";

export type SemanticOperation =
  | "call"
  | "construct"
  | "property_access"
  | "module_load";

export interface NodeSemanticSink {
  readonly sinkId: string;
  readonly capability: StaticCapability;
  readonly module: string;
  readonly member: string;
  readonly operation: SemanticOperation;
}

function callableSinks(
  module: string,
  capability: StaticCapability,
  members: readonly string[],
): NodeSemanticSink[] {
  return members.map((member) => ({
    sinkId: `node.${module.replace("/", ".")}.${member}.call`,
    capability,
    module,
    member,
    operation: "call",
  }));
}

const filesystemMembers = [
  "access",
  "accessSync",
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "createReadStream",
  "createWriteStream",
  "link",
  "linkSync",
  "lstat",
  "lstatSync",
  "mkdir",
  "mkdirSync",
  "mkdtemp",
  "mkdtempSync",
  "open",
  "openSync",
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
  "readlink",
  "readlinkSync",
  "realpath",
  "realpathSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "stat",
  "statSync",
  "symlink",
  "symlinkSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "utimes",
  "utimesSync",
  "watch",
  "writeFile",
  "writeFileSync",
] as const;

const filesystemPromiseMembers = [
  "access",
  "appendFile",
  "chmod",
  "chown",
  "copyFile",
  "cp",
  "link",
  "lstat",
  "mkdir",
  "mkdtemp",
  "open",
  "readFile",
  "readdir",
  "readlink",
  "realpath",
  "rename",
  "rm",
  "rmdir",
  "stat",
  "symlink",
  "truncate",
  "unlink",
  "utimes",
  "watch",
  "writeFile",
] as const;

const processMembers = [
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
] as const;

const dnsMembers = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
] as const;

const vmMembers = [
  "compileFunction",
  "runInContext",
  "runInNewContext",
  "runInThisContext",
] as const;

export const NODE_SEMANTIC_SINKS: readonly NodeSemanticSink[] = [
  ...callableSinks("fs", "filesystem_access", filesystemMembers),
  ...callableSinks(
    "fs/promises",
    "filesystem_access",
    filesystemPromiseMembers,
  ),
  ...callableSinks("child_process", "process_execution", processMembers),
  ...callableSinks("http", "network_access", ["get", "request"]),
  ...callableSinks("https", "network_access", ["get", "request"]),
  ...callableSinks("http2", "network_access", ["connect"]),
  ...callableSinks("net", "network_access", ["connect", "createConnection"]),
  ...callableSinks("tls", "network_access", ["connect"]),
  ...callableSinks("dns", "network_access", dnsMembers),
  ...callableSinks("dns/promises", "network_access", dnsMembers),
  ...callableSinks("vm", "dynamic_code_execution", vmMembers),
  {
    sinkId: "node.vm.Script.construct",
    capability: "dynamic_code_execution",
    module: "vm",
    member: "Script",
    operation: "construct",
  },
  {
    sinkId: "node.global.fetch.call",
    capability: "network_access",
    module: "global",
    member: "fetch",
    operation: "call",
  },
  {
    sinkId: "node.global.WebSocket.construct",
    capability: "network_access",
    module: "global",
    member: "WebSocket",
    operation: "construct",
  },
  {
    sinkId: "node.global.eval.call",
    capability: "dynamic_code_execution",
    module: "global",
    member: "eval",
    operation: "call",
  },
  {
    sinkId: "node.global.Function.construct",
    capability: "dynamic_code_execution",
    module: "global",
    member: "Function",
    operation: "construct",
  },
  {
    sinkId: "node.global.Function.call",
    capability: "dynamic_code_execution",
    module: "global",
    member: "Function",
    operation: "call",
  },
  {
    sinkId: "node.process.env.access",
    capability: "environment_access",
    module: "process",
    member: "env",
    operation: "property_access",
  },
  {
    sinkId: "node.process.dlopen.call",
    capability: "native_code_loading",
    module: "process",
    member: "dlopen",
    operation: "call",
  },
  {
    sinkId: "node.global.require.dynamic",
    capability: "dynamic_module_loading",
    module: "global",
    member: "require",
    operation: "module_load",
  },
  {
    sinkId: "node.global.import.dynamic",
    capability: "dynamic_module_loading",
    module: "global",
    member: "import",
    operation: "module_load",
  },
  {
    sinkId: "node.global.require.native",
    capability: "native_code_loading",
    module: "global",
    member: "require.node_addon",
    operation: "module_load",
  },
  {
    sinkId: "node.global.import.native",
    capability: "native_code_loading",
    module: "global",
    member: "import.node_addon",
    operation: "module_load",
  },
] as const;

const catalogIds = new Set<string>();
const catalogOperations = new Set<string>();
for (const sink of NODE_SEMANTIC_SINKS) {
  const operationKey = [sink.module, sink.member, sink.operation].join("\0");
  if (catalogIds.has(sink.sinkId) || catalogOperations.has(operationKey)) {
    throw new Error(
      `duplicate trusted Node semantic sink catalog entry: ${sink.sinkId}`,
    );
  }
  catalogIds.add(sink.sinkId);
  catalogOperations.add(operationKey);
}

export const NODE_SEMANTIC_SINK_BY_ID = new Map(
  NODE_SEMANTIC_SINKS.map((sink) => [sink.sinkId, sink]),
);

export function findNodeSemanticSink(options: {
  readonly module: string;
  readonly member: string;
  readonly operation: SemanticOperation;
}): NodeSemanticSink | undefined {
  return NODE_SEMANTIC_SINKS.find(
    (sink) =>
      sink.module === options.module &&
      sink.member === options.member &&
      sink.operation === options.operation,
  );
}
