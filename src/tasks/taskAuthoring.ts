/** Canonical authoring bounds for a Task created through Board. */
export const TASK_AUTHORING_LIMITS = {
  title: 300,
  body: 4_000,
  kind: 64,
  artifactRefs: 10,
  artifactRefType: 64,
  artifactRefValue: 500,
} as const;

export type TaskAuthoringLimitField =
  | "title"
  | "body"
  | "kind"
  | "artifact_refs"
  | "artifact_refs.type"
  | "artifact_refs.ref";

export function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * A bounded, content-free authoring error. Never interpolate the rejected value:
 * callers need its size and a preservation path, not an echo of potentially
 * sensitive task material.
 */
export function taskAuthoringLimitMessage(
  field: TaskAuthoringLimitField,
  received: number,
  maximum: number,
): string {
  const unit = field === "artifact_refs" ? "entries" : "code points";
  const prefix = `create_task ${field} received ${received} ${unit}; maximum ${maximum}.`;

  switch (field) {
    case "body":
      return (
        `${prefix} Do not truncate. Keep the Task body to its bounded objective and acceptance context. ` +
        "For four independently shippable slices, create one umbrella Task plus explicit follow-up Tasks. " +
        "Use append_task_note for chronological execution context and artifact_refs for pointers to long durable artifacts. " +
        "create_task does not create follow-ups or infer dependencies automatically."
      );
    case "title":
      return `${prefix} Use a concise outcome-oriented title and put bounded context in body.`;
    case "kind":
      return `${prefix} Use a short classification label; put explanatory context in body.`;
    case "artifact_refs":
      return `${prefix} Keep only Task-relevant pointers; collect additional links in a durable artifact and reference that artifact.`;
    case "artifact_refs.type":
      return `${prefix} Use a short opaque artifact kind such as path, issue, or task.`;
    case "artifact_refs.ref":
      return `${prefix} Store long material as a durable artifact and pass only its stable pointer.`;
  }
}
