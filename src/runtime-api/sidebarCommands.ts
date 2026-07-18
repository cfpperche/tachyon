const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const PIN_ID_RE = /^p-[0-9a-f]{6}$/;
const PROPOSAL_ID_RE = /^[a-f0-9]{12}$/;
/** UUID or notice ids from DaemonEngineHost (randomUUID). */
const NOTICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SidebarMutationInputV1 =
  | { action: "pin.toggle"; id: string; done: boolean }
  | { action: "pin.delete"; id: string }
  | { action: "schedule.toggle-pause"; id: string }
  | { action: "schedule.delete"; id: string }
  | { action: "proposal.approve"; id: string }
  | { action: "proposal.reject"; id: string }
  | { action: "notice.markRead"; id: string }
  | { action: "notice.markAllRead"; id: "all" }
  | { action: "notice.invoke"; id: string; actionId: string }
  | { action: "agent.markSeen"; id: string };

export function isSidebarMutationInputV1(value: unknown): value is SidebarMutationInputV1 {
  if (!isRecord(value) || typeof value.action !== "string") return false;
  if (value.action === "pin.toggle") {
    return exactKeys(value, ["action", "id", "done"])
      && typeof value.id === "string"
      && PIN_ID_RE.test(value.id)
      && typeof value.done === "boolean";
  }
  if (value.action === "pin.delete") {
    return exactKeys(value, ["action", "id"]) && typeof value.id === "string" && PIN_ID_RE.test(value.id);
  }
  if (value.action === "schedule.toggle-pause" || value.action === "schedule.delete") {
    return exactKeys(value, ["action", "id"]) && typeof value.id === "string" && NAME_RE.test(value.id);
  }
  if (value.action === "proposal.approve" || value.action === "proposal.reject") {
    return exactKeys(value, ["action", "id"]) && typeof value.id === "string" && PROPOSAL_ID_RE.test(value.id);
  }
  if (value.action === "notice.markRead") {
    return exactKeys(value, ["action", "id"]) && typeof value.id === "string" && NOTICE_ID_RE.test(value.id);
  }
  if (value.action === "notice.markAllRead") {
    return exactKeys(value, ["action", "id"]) && value.id === "all";
  }
  if (value.action === "notice.invoke") {
    return exactKeys(value, ["action", "id", "actionId"])
      && typeof value.id === "string"
      && NOTICE_ID_RE.test(value.id)
      && typeof value.actionId === "string"
      && NOTICE_ID_RE.test(value.actionId);
  }
  if (value.action === "agent.markSeen") {
    return exactKeys(value, ["action", "id"]) && typeof value.id === "string" && NAME_RE.test(value.id);
  }
  return false;
}

export function parseSidebarMutationInputV1(value: unknown): SidebarMutationInputV1 {
  if (!isSidebarMutationInputV1(value)) throw new Error("invalid sidebar mutation input");
  if (value.action === "pin.toggle") return { action: value.action, id: value.id, done: value.done };
  if (value.action === "notice.invoke") return { action: value.action, id: value.id, actionId: value.actionId };
  return { action: value.action, id: value.id } as SidebarMutationInputV1;
}

export function isSidebarMutationResultIdentityV1(action: unknown, id: unknown): action is SidebarMutationInputV1["action"] {
  if (typeof action !== "string" || typeof id !== "string") return false;
  if (action === "pin.toggle" || action === "pin.delete") return PIN_ID_RE.test(id);
  if (action === "schedule.toggle-pause" || action === "schedule.delete") return NAME_RE.test(id);
  if (action === "agent.markSeen") return NAME_RE.test(id);
  if (action === "notice.markRead" || action === "notice.invoke") return NOTICE_ID_RE.test(id);
  if (action === "notice.markAllRead") return id === "all";
  return (action === "proposal.approve" || action === "proposal.reject") && PROPOSAL_ID_RE.test(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
