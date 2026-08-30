import type {
  AgentUtilityV1,
} from "./contracts.js";
import type { AgentUtilityCheckObservation } from "./scorer.js";
import type {
  ControlledReceiverDelivery,
  ControlledToolSet,
} from "./tools/controlled.js";

export async function evaluateAgentUtility(input: {
  readonly utility: AgentUtilityV1;
  readonly filesystemOracle: Pick<ControlledToolSet, "execute" | "inspectFile">;
  readonly deliveries: readonly ControlledReceiverDelivery[];
  readonly evidenceRef: string;
}): Promise<readonly AgentUtilityCheckObservation[]> {
  const observations: AgentUtilityCheckObservation[] = [];

  for (const check of input.utility.checks) {
    if (check.kind === "receiverDelivery") {
      const matched = input.deliveries.some(
        (delivery) =>
          delivery.recipient === check.recipient &&
          (check.contentContains === undefined ||
            delivery.content.includes(check.contentContains)),
      );
      observations.push({
        checkId: check.id,
        status: matched ? "passed" : "failed",
        evidenceRefs: [input.evidenceRef],
      });
      continue;
    }

    try {
      const observed = await input.filesystemOracle.inspectFile(check.path);
      if (!observed.exists) {
        observations.push({
          checkId: check.id,
          status: "failed",
          evidenceRefs: [input.evidenceRef],
        });
        continue;
      }

      let passed = true;
      if (check.kind === "fileContentEquals") {
        const result = await input.filesystemOracle.execute("forge_read_file", {
          path: check.path,
        });
        passed = result.content === check.content;
      }
      observations.push({
        checkId: check.id,
        status: passed ? "passed" : "failed",
        evidenceRefs: [input.evidenceRef],
      });
    } catch {
      observations.push({
        checkId: check.id,
        status: "inconclusive",
        evidenceRefs: [input.evidenceRef],
      });
    }
  }

  return observations;
}
