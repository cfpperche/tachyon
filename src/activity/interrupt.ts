/** Runtime-written markers for a human interrupting the current turn. These are control records, not prompts. */
export function isUserInterrupt(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ");
  return /^\[?Request interrupted by user\]?$/i.test(normalized)
    || /^Conversation interrupted\b/i.test(normalized)
    || /^Interrupted by user\.?$/i.test(normalized)
    || /^User interrupted\.?$/i.test(normalized);
}
