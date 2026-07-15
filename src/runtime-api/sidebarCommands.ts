const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const PIN_ID_RE = /^p-[0-9a-f]{6}$/;
const PROPOSAL_ID_RE = /^[a-f0-9]{12}$/;

export type SidebarMutationInputV1 =
  | { action: "pin.toggle"; id: string; done: boolean }
  | { action: "pin.delete"; id: string }
  | { action: "schedule.toggle-pause"; id: string }
  | { action: "schedule.delete"; id: string }
  | { action: "proposal.approve"; id: string }
  | { action: "proposal.reject"; id: string };

export function isSidebarMutationInputV1(value: unknown): value is SidebarMutationInputV1 {
  if (!isRecord(value) || typeof value.action !== "string" || typeof value.id !== "string") return false;
  if (value.action === "pin.toggle") {
    return exactKeys(value, ["action", "id", "done"]) && PIN_ID_RE.test(value.id) && typeof value.done === "boolean";
  }
  if (value.action === "pin.delete") return exactKeys(value, ["action", "id"]) && PIN_ID_RE.test(value.id);
  if (value.action === "schedule.toggle-pause" || value.action === "schedule.delete") {
    return exactKeys(value, ["action", "id"]) && NAME_RE.test(value.id);
  }
  if (value.action === "proposal.approve" || value.action === "proposal.reject") {
    return exactKeys(value, ["action", "id"]) && PROPOSAL_ID_RE.test(value.id);
  }
  return false;
}

export function parseSidebarMutationInputV1(value: unknown): SidebarMutationInputV1 {
  if (!isSidebarMutationInputV1(value)) throw new Error("invalid sidebar mutation input");
  return value.action === "pin.toggle"
    ? { action: value.action, id: value.id, done: value.done }
    : { action: value.action, id: value.id };
}

export function isSidebarMutationResultIdentityV1(action: unknown, id: unknown): action is SidebarMutationInputV1["action"] {
  if (typeof action !== "string" || typeof id !== "string") return false;
  if (action === "pin.toggle" || action === "pin.delete") return PIN_ID_RE.test(id);
  if (action === "schedule.toggle-pause" || action === "schedule.delete") return NAME_RE.test(id);
  return (action === "proposal.approve" || action === "proposal.reject") && PROPOSAL_ID_RE.test(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
