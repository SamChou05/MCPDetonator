import {
  attributionV1Schema,
  type AttributionV1,
  type ObservedEventV1,
  type PhaseV1,
} from "./contracts/v1.js";
import type { EvidenceStore } from "./evidence-store.js";

function activePhase(event: ObservedEventV1, phases: readonly PhaseV1[]): PhaseV1 | undefined {
  const timestamp = Date.parse(event.timestamp);
  return phases.find(
    (phase) =>
      phase.experimentId === event.experimentId &&
      Date.parse(phase.startedAt) <= timestamp &&
      timestamp <= Date.parse(phase.endedAt),
  );
}

export async function attributeEvents(options: {
  readonly store: EvidenceStore;
  readonly events: readonly ObservedEventV1[];
  readonly phases: readonly PhaseV1[];
  readonly isolatedToolExperimentIds: ReadonlySet<string>;
}): Promise<AttributionV1[]> {
  const originByProcess = new Map<string, PhaseV1 | undefined>();

  for (const event of options.events) {
    if (!originByProcess.has(event.processRef)) {
      originByProcess.set(event.processRef, activePhase(event, options.phases));
    }
  }

  const attributions = options.events.map((event) => {
    const active = activePhase(event, options.phases);
    const origin = originByProcess.get(event.processRef);
    const reasons: string[] = [];
    let confidence: AttributionV1["confidence"] = "unattributed";

    if (active !== undefined) {
      reasons.push("within_phase_bounds");
      confidence = "medium";

      if (
        active.kind === "tool" &&
        options.isolatedToolExperimentIds.has(event.experimentId)
      ) {
        reasons.push("isolated_tool_run");
        if (origin?.phaseId === active.phaseId) {
          reasons.push("process_origin_matches_active_phase");
          confidence = "high";
        } else {
          reasons.push("process_origin_precedes_active_phase");
        }
      } else if (origin?.phaseId === active.phaseId) {
        reasons.push("process_origin_matches_active_phase");
        confidence = "high";
      }
    } else if (origin !== undefined) {
      reasons.push("process_origin_phase_only");
      confidence = "low";
    }

    return attributionV1Schema.parse({
      schema: "forge.attribution/v1",
      attributionId: `attr-${event.eventId}`,
      runId: event.runId,
      eventId: event.eventId,
      ...(active === undefined ? {} : { activePhaseId: active.phaseId }),
      ...(origin === undefined ? {} : { processOriginPhaseId: origin.phaseId }),
      confidence,
      reasons,
    });
  });

  await options.store.writeJsonl(
    "attributions.jsonl",
    attributionV1Schema,
    attributions,
  );
  return attributions;
}
