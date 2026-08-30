import { lstat, opendir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const MAX_AGENT_TRIAL_WRITABLE_BYTES = 16_000_000;
export const MAX_AGENT_TRIAL_WRITABLE_ENTRIES = 2_048;
const DEFAULT_QUOTA_POLL_MS = 20;

export class AgentTrialResourceQuotaError extends Error {
  public readonly observed: AgentTrialWritableUsage | undefined;

  public constructor(
    message: string,
    options?: ErrorOptions & { readonly observed?: AgentTrialWritableUsage },
  ) {
    super(message, options);
    this.name = "AgentTrialResourceQuotaError";
    this.observed = options?.observed;
  }
}

export interface AgentTrialWritableUsage {
  readonly bytes: number;
  readonly entries: number;
}

export interface AgentTrialResourceQuotaSnapshot {
  readonly limits: {
    readonly maxBytes: number;
    readonly maxEntries: number;
    readonly maxFileBytes?: number;
  };
  readonly roots: readonly string[];
  readonly latest: AgentTrialWritableUsage;
  readonly peak: AgentTrialWritableUsage;
  readonly status: "monitoring" | "within_quota" | "violated" | "verification_failed";
  readonly violation?: string;
  readonly termination: "not_requested" | "pending" | "succeeded" | "failed";
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

async function writableUsage(
  roots: readonly string[],
  maxBytes: number,
  maxEntries: number,
  maxFileBytes?: number,
): Promise<AgentTrialWritableUsage> {
  let bytes = 0;
  let entries = 0;

  async function visit(directory: string): Promise<void> {
    let handle;
    try {
      handle = await opendir(directory);
    } catch (error) {
      if (isMissingPath(error)) {
        return;
      }
      throw error;
    }

    for await (const entry of handle) {
      entries += 1;
      if (entries > maxEntries) {
        throw new AgentTrialResourceQuotaError(
          `Agent V1 trial writable state exceeded the ${maxEntries}-entry limit`,
          { observed: { bytes, entries } },
        );
      }

      const path = resolve(directory, entry.name);
      let stat;
      try {
        stat = await lstat(path);
      } catch (error) {
        if (isMissingPath(error)) {
          continue;
        }
        throw error;
      }
      bytes += stat.size;
      if (maxFileBytes !== undefined && stat.isFile() && stat.size >= maxFileBytes) {
        throw new AgentTrialResourceQuotaError(
          `Agent V1 observed a file at the ${maxFileBytes}-byte process file limit`,
          { observed: { bytes, entries } },
        );
      }
      if (bytes > maxBytes) {
        throw new AgentTrialResourceQuotaError(
          `Agent V1 trial writable state exceeded the ${maxBytes}-byte limit`,
          { observed: { bytes, entries } },
        );
      }
      if (stat.isDirectory()) {
        await visit(path);
      }
    }
  }

  for (const root of roots) {
    await visit(root);
  }
  return { bytes, entries };
}

export interface AgentTrialResourceQuotaMonitor {
  /** Resolves exactly once when a quota or quota-verification failure occurs. */
  readonly violation: Promise<AgentTrialResourceQuotaError>;
  assertWithinQuota(): void;
  snapshot(): AgentTrialResourceQuotaSnapshot;
  stop(): Promise<void>;
}

/**
 * Watch the controller-linked trace/profile trees for one Agent V1 trial.
 * Scans are serialized so an event storm cannot create its own unbounded work
 * queue. The caller supplies label-checked target termination as `onViolation`.
 * The target's live tmpfs has separate kernel byte/inode limits.
 */
export async function startAgentTrialResourceQuotaMonitor(options: {
  readonly roots: readonly string[];
  readonly onViolation: (error: AgentTrialResourceQuotaError) => Promise<void>;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly maxFileBytes?: number;
  readonly pollMs?: number;
}): Promise<AgentTrialResourceQuotaMonitor> {
  const roots = [...new Set(options.roots.map((root) => resolve(root)))];
  const maxBytes = options.maxBytes ?? MAX_AGENT_TRIAL_WRITABLE_BYTES;
  const maxEntries =
    options.maxEntries ?? MAX_AGENT_TRIAL_WRITABLE_ENTRIES;
  const pollMs = options.pollMs ?? DEFAULT_QUOTA_POLL_MS;
  if (roots.length === 0) {
    throw new Error("Agent V1 resource quota requires at least one root");
  }
  for (const [label, value] of [
    ["byte", maxBytes],
    ["entry", maxEntries],
    ["poll", pollMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Agent V1 resource quota ${label} limit must be positive`);
    }
  }
  if (
    options.maxFileBytes !== undefined &&
    (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 1)
  ) {
    throw new Error("Agent V1 resource quota file limit must be positive");
  }

  let active = true;
  let violationError: AgentTrialResourceQuotaError | undefined;
  let latest: AgentTrialWritableUsage = { bytes: 0, entries: 0 };
  let peak: AgentTrialWritableUsage = { bytes: 0, entries: 0 };
  let status: AgentTrialResourceQuotaSnapshot["status"] = "monitoring";
  let terminationStatus: AgentTrialResourceQuotaSnapshot["termination"] =
    "not_requested";
  let terminationError: unknown;
  let resolveViolation!: (error: AgentTrialResourceQuotaError) => void;
  const violation = new Promise<AgentTrialResourceQuotaError>((resolvePromise) => {
    resolveViolation = resolvePromise;
  });
  let termination: Promise<void> | undefined;

  function violate(error: unknown): void {
    if (violationError !== undefined) {
      return;
    }
    const isMeasuredViolation = error instanceof AgentTrialResourceQuotaError;
    violationError =
      isMeasuredViolation
        ? error
        : new AgentTrialResourceQuotaError(
            "Agent V1 could not verify its trial writable-state quota",
            { cause: error },
          );
    if (violationError.observed !== undefined) {
      recordUsage(violationError.observed);
    }
    active = false;
    status = isMeasuredViolation ? "violated" : "verification_failed";
    resolveViolation(violationError);
    terminationStatus = "pending";
    termination = options.onViolation(violationError).then(
      () => {
        terminationStatus = "succeeded";
      },
      (terminationFailure: unknown) => {
        terminationError = terminationFailure;
        terminationStatus = "failed";
        status = "verification_failed";
      },
    );
  }

  function recordUsage(usage: AgentTrialWritableUsage): void {
    latest = usage;
    peak = {
      bytes: Math.max(peak.bytes, usage.bytes),
      entries: Math.max(peak.entries, usage.entries),
    };
  }

  async function scan(): Promise<void> {
    recordUsage(
      await writableUsage(
        roots,
        maxBytes,
        maxEntries,
        options.maxFileBytes,
      ),
    );
  }

  try {
    await scan();
  } catch (error) {
    violate(error);
    await termination;
  }

  const polling = (async () => {
    while (active) {
      await delay(pollMs);
      if (!active) {
        break;
      }
      try {
        await scan();
      } catch (error) {
        violate(error);
      }
    }
  })();

  return {
    violation,
    assertWithinQuota(): void {
      if (violationError !== undefined) {
        throw violationError;
      }
    },
    snapshot(): AgentTrialResourceQuotaSnapshot {
      return {
        limits: {
          maxBytes,
          maxEntries,
          ...(options.maxFileBytes === undefined
            ? {}
            : { maxFileBytes: options.maxFileBytes }),
        },
        roots,
        latest,
        peak,
        status,
        ...(violationError === undefined
          ? {}
          : { violation: violationError.message }),
        termination: terminationStatus,
      };
    },
    async stop(): Promise<void> {
      active = false;
      await polling;
      try {
        await scan();
      } catch (error) {
        violate(error);
      }
      await termination;
      if (terminationError !== undefined) {
        throw new AgentTrialResourceQuotaError(
          "Agent V1 could not verify target termination after a resource quota violation",
          { cause: terminationError },
        );
      }
      if (violationError !== undefined) {
        throw violationError;
      }
      status = "within_quota";
    },
  };
}
