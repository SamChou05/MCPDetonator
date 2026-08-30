export type V2CompileErrorCode =
  | "approval_escalation"
  | "artifact_mismatch"
  | "binding_unsupported"
  | "bounds_exceeded"
  | "digest_mismatch"
  | "duplicate_id"
  | "mandatory_collision"
  | "policy_denied"
  | "policy_missing"
  | "receipt_invalid"
  | "resource_unknown"
  | "schema_unsupported"
  | "schema_validation_failed"
  | "tool_missing"
  | "unsafe_reference";

export class V2CompileError extends Error {
  public constructor(
    readonly code: V2CompileErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "V2CompileError";
  }
}
