export const AGENT_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_PATTERN.test(name);
}

export function assertValidAgentName(name: string): void {
  if (!isValidAgentName(name)) {
    throw new Error(`invalid agent name '${name}' (must match ${AGENT_NAME_PATTERN})`);
  }
}

export function asciiFoldAgentName(name: string): string {
  return name.replace(/[A-Z]/g, (character) => character.toLowerCase());
}
