import { describe, it, expect } from "vitest";
import { redactSecrets } from "@tachyon/engine/bridge/redact.js";

/** spec 351 T7 (dueto F8) — redaction of Bridge auth secrets out of Tachyon-generated diagnostics. */
describe("redactSecrets", () => {
  const TOKEN = "a".repeat(64);

  it("redacts an exact known-secret occurrence, even bare (no prefix)", () => {
    expect(redactSecrets(`some output\n${TOKEN}\nmore output`, [TOKEN])).toBe("some output\n[redacted]\nmore output");
  });

  it("redacts a TACHYON_BRIDGE_TOKEN/TACHYON_AGENT_BRIDGE_TOKEN env-assignment line by PATTERN, with no known-secret list needed", () => {
    expect(redactSecrets(`TACHYON_BRIDGE_TOKEN=${TOKEN}`)).toBe("TACHYON_BRIDGE_TOKEN=[redacted]");
    expect(redactSecrets(`TACHYON_AGENT_BRIDGE_TOKEN=${TOKEN}`)).toBe("TACHYON_AGENT_BRIDGE_TOKEN=[redacted]");
  });

  it("redacts a Bearer header value by PATTERN — catches a per-agent token Tachyon never retained in plaintext", () => {
    expect(redactSecrets(`Authorization: Bearer ${TOKEN}`)).toBe(`Authorization: Bearer [redacted]`);
  });

  it("leaves unrelated text untouched (no over-redaction)", () => {
    const text = "npm test passed, 200 tests green\ncommit abc123def456";
    expect(redactSecrets(text, [TOKEN])).toBe(text);
  });

  it("handles multiple occurrences and multiple forms in the same text", () => {
    const text = `env dump:\nTACHYON_BRIDGE_TOKEN=${TOKEN}\ncurl -H "Authorization: Bearer ${TOKEN}"\necho $TACHYON_BRIDGE_TOKEN -> ${TOKEN}`;
    const out = redactSecrets(text, [TOKEN]);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("TACHYON_BRIDGE_TOKEN=[redacted]");
    expect(out).toContain("Bearer [redacted]");
  });
});
