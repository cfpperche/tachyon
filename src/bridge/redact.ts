/**
 * spec 351 T7 (dueto F8) — redact Bridge auth secrets out of Tachyon-generated diagnostics (postmortem
 * captures, live `read_output`, logs). Two complementary strategies:
 *  - EXACT match on known plaintext secrets Tachyon still holds in memory (the shared/legacy token via
 *    getExtraEnv) — catches a bare `echo $TACHYON_BRIDGE_TOKEN` with no surrounding syntax to key off.
 *  - PATTERN match on the syntactic shapes a token appears in regardless of its value (an env-var
 *    assignment line, a Bearer header) — catches ANY token, including a per-agent one, whose plaintext
 *    Tachyon deliberately never retains (the digest-only registry invariant extends here: this module
 *    can redact a per-agent token it recognizes SYNTACTICALLY, never one it remembers by value).
 *
 * Honest residual: a per-agent token bare-echoed with no prefix (no var name, no "Bearer ") is NOT
 * redactable after the fact — Tachyon never held its plaintext to match against. Documented, not silent.
 */

const TOKEN_ENV_ASSIGNMENT_RE = /\b(TACHYON_(?:AGENT_)?BRIDGE_TOKEN)=(\S+)/g;
const BEARER_HEADER_RE = /\b(Bearer\s+)(\S+)/gi;

export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  out = out.replace(TOKEN_ENV_ASSIGNMENT_RE, "$1=[redacted]");
  out = out.replace(BEARER_HEADER_RE, "$1[redacted]");
  return out;
}
