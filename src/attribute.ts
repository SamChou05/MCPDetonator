import {
  attributionV1Schema,
  type AttributionV1,
  type ObservedEventV1,
  type PhaseV1,
} from "./contracts/v1.js";
import type { EvidenceStore } from "./evidence-store.js";

function activePhase(event: ObservedEventV1, phases: readonly PhaseV1[]): PhaseV1 | undefined {
  const timestamp = Date.parse(event.timestamp);
  let active: PhaseV1 | undefined;

  for (const phase of phases) {
    if (
      phase.experimentId !== event.experimentId ||
      Date.parse(phase.startedAt) > timestamp ||
      timestamp > Date.parse(phase.endedAt)
    ) {
      continue;
    }

    if (
      active === undefined ||
      Date.parse(phase.startedAt) >= Date.parse(active.startedAt)
    ) {
      active = phase;
    }
  }

  return active;
}

function eventIsEarlier(
  candidate: ObservedEventV1,
  current: ObservedEventV1,
): boolean {
  const candidateTime = Date.parse(candidate.timestamp);
  const currentTime = Date.parse(current.timestamp);
  return (
    candidateTime < currentTime ||
    (candidateTime === currentTime && candidate.sequence < current.sequence)
  );
}

function phasePrecedes(origin: PhaseV1, active: PhaseV1): boolean {
  return Date.parse(origin.endedAt) <= Date.parse(active.startedAt);
}

export async function attributeEvents(options: {
  readonly store: EvidenceStore;
  readonly events: readonly ObservedEventV1[];
  readonly phases: readonly PhaseV1[];
  readonly isolatedToolExperimentIds: ReadonlySet<string>;
}): Promise<AttributionV1[]> {
  const firstEventByProcess = new Map<string, ObservedEventV1>();
  const originByProcess = new Map<string, PhaseV1 | undefined>();

  for (const event of options.events) {
    const current = firstEventByProcess.get(event.processRef);
    if (current === undefined || eventIsEarlier(event, current)) {
      firstEventByProcess.set(event.processRef, event);
    }
  }
  for (const [processRef, firstEvent] of firstEventByProcess) {
    originByProcess.set(processRef, activePhase(firstEvent, options.phases));
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
      }

      if (origin?.phaseId === active.phaseId) {
        reasons.push("process_origin_matches_active_phase");
        confidence = "high";
      } else if (origin === undefined) {
        reasons.push("process_origin_outside_recorded_phases");
      } else {
        reasons.push(
          phasePrecedes(origin, active)
            ? "process_origin_precedes_active_phase"
            : "process_origin_differs_from_active_phase",
        );
      }

      if (active.kind === "tool" && origin?.phaseId !== active.phaseId) {
        if (origin?.kind === "initialization") {
          reasons.push("initialization_process_active_during_tool_phase");
        }
        reasons.push("tool_phase_temporal_overlap_only");
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
