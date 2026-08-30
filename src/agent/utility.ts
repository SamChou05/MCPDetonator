import { sha256 } from "../evidence-store.js";
import type { AgentUtilityV1 } from "./contracts.js";
import { AgentCleanupVerificationError } from "./docker-cleanup.js";
import type {
  AgentUtilityCheckObservation,
  AgentUtilityEvidenceObservation,
} from "./scorer.js";
import type {
  ControlledReceiverDelivery,
  ControlledToolSet,
} from "./tools/controlled.js";

export interface AgentFilesystemUtilityOracle {
  readonly domain: "target" | "controlled";
  readonly oracle: Pick<ControlledToolSet, "execute" | "inspectFile">;
}

export async function evaluateAgentUtility(input: {
  readonly utility: AgentUtilityV1;
  readonly filesystemOracles: readonly AgentFilesystemUtilityOracle[];
  readonly deliveries: readonly ControlledReceiverDelivery[];
  readonly evidenceRef: string;
}): Promise<readonly AgentUtilityCheckObservation[]> {
  const observations: AgentUtilityCheckObservation[] = [];

  for (const check of input.utility.checks) {
    if (check.kind === "receiverDelivery") {
      const matched = input.deliveries.find(
        (delivery) =>
          delivery.recipient === check.recipient &&
          (check.contentContains === undefined ||
            delivery.content.includes(check.contentContains)),
      );
      observations.push({
        checkId: check.id,
        status: matched === undefined ? "failed" : "passed",
        evidenceRefs: [input.evidenceRef],
        observations: [
          matched === undefined
            ? {
                domain: "receiver",
                outcome: "not_matched",
                recipient: check.recipient,
              }
            : {
                domain: "receiver",
                outcome: "matched",
                recipient: matched.recipient,
                deliverySequence: matched.sequence,
                bytes: Buffer.byteLength(matched.content, "utf8"),
                contentSha256: sha256(matched.content),
              },
        ],
      });
      continue;
    }

    let passed = false;
    let infrastructureFailure = false;
    const evidence: AgentUtilityEvidenceObservation[] = [];
    for (const { domain, oracle } of input.filesystemOracles) {
      let observation;
      try {
        observation = await oracle.inspectFile(check.path);
      } catch (error) {
        if (error instanceof AgentCleanupVerificationError) {
          throw error;
        }
        infrastructureFailure = true;
        evidence.push({ domain, outcome: "observer_error", path: check.path });
        continue;
      }
      if (!observation.exists || observation.kind !== "file") {
        evidence.push({
          domain,
          outcome: observation.exists ? "wrong_kind" : "missing",
          path: check.path,
          ...(observation.kind === undefined ? {} : { kind: observation.kind }),
          ...(observation.bytes === undefined ? {} : { bytes: observation.bytes }),
        });
        continue;
      }
      if (check.kind === "fileExists") {
        evidence.push({
          domain,
          outcome: "matched",
          path: check.path,
          kind: observation.kind,
          ...(observation.bytes === undefined ? {} : { bytes: observation.bytes }),
        });
        passed = true;
        break;
      }
      try {
        const result = await oracle.execute("forge_read_file", {
          path: check.path,
        });
        const matched = result.content === check.content;
        evidence.push({
          domain,
          outcome: matched ? "matched" : "content_mismatch",
          path: check.path,
          kind: "file",
          bytes: Buffer.byteLength(result.content, "utf8"),
          contentSha256: sha256(result.content),
        });
        if (matched) {
          passed = true;
          break;
        }
      } catch (error) {
        if (error instanceof AgentCleanupVerificationError) {
          throw error;
        }
        infrastructureFailure = true;
        evidence.push({ domain, outcome: "observer_error", path: check.path });
      }
    }

    observations.push({
      checkId: check.id,
      status: passed
        ? "passed"
        : infrastructureFailure
          ? "inconclusive"
          : "failed",
      evidenceRefs: [input.evidenceRef],
      observations: evidence,
    });
  }

  return observations;
}
