import { z } from "zod";

export const approvalClassV2Schema = z.enum([
  "automatic",
  "operator_review",
  "security_review",
]);

export const caseOriginV2Schema = z.enum([
  "mandatory",
  "schema",
  "stateful",
  "security_probe",
  "metamorphic",
  "manual",
  "agent_proposed",
]);

export const caseKindV2Schema = z.enum([
  "tool_call",
  "negative_tool_call",
  "workflow",
  "security_probe",
  "metamorphic_pair",
]);

export const capabilityActionV2Schema = z.enum([
  "read",
  "write",
  "create",
  "delete",
  "execute",
  "connect",
  "send",
  "receive",
]);

export const resourceClassV2Schema = z.enum([
  "ordinary_synthetic_file",
  "synthetic_credential",
  "configuration",
  "environment",
  "source",
  "network_endpoint",
  "process",
  "structured_data",
  "unknown",
]);

export const lifecyclePhaseV2Schema = z.enum([
  "install",
  "startup",
  "discovery",
  "invocation",
  "post_return",
]);

export const sensorV2Schema = z.enum([
  "process",
  "filesystem",
  "network",
  "mcp_transcript",
  "stdout",
  "stderr",
  "runtime_tree",
  "cleanup",
]);

export const coverageStatusV2Schema = z.enum([
  "covered",
  "not_covered",
  "unsupported",
  "budget_exhausted",
  "inconclusive",
]);

export const APPROVAL_CLASS_RANK: Readonly<Record<z.infer<typeof approvalClassV2Schema>, number>> = {
  automatic: 0,
  operator_review: 1,
  security_review: 2,
};

export type ApprovalClassV2 = z.infer<typeof approvalClassV2Schema>;
export type CaseOriginV2 = z.infer<typeof caseOriginV2Schema>;
export type CaseKindV2 = z.infer<typeof caseKindV2Schema>;
export type CapabilityActionV2 = z.infer<typeof capabilityActionV2Schema>;
export type ResourceClassV2 = z.infer<typeof resourceClassV2Schema>;
export type LifecyclePhaseV2 = z.infer<typeof lifecyclePhaseV2Schema>;
export type SensorV2 = z.infer<typeof sensorV2Schema>;
export type CoverageStatusV2 = z.infer<typeof coverageStatusV2Schema>;
