export const AGENT_INPUT_MAX_BYTES = 48 * 1024;
const AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

export interface AgentInputCommandV1 {
  agent: string;
  text: string;
  submit: boolean;
}

export function isAgentInputCommandV1(value: unknown): value is AgentInputCommandV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<AgentInputCommandV1>;
  const keys = Object.keys(value);
  return keys.length === 3
    && keys.every((key) => key === "agent" || key === "text" || key === "submit")
    && typeof input.agent === "string"
    && AGENT_NAME_RE.test(input.agent)
    && typeof input.text === "string"
    && input.text.length > 0
    && !input.text.includes("\0")
    && Buffer.byteLength(input.text, "utf8") <= AGENT_INPUT_MAX_BYTES
    && typeof input.submit === "boolean";
}
