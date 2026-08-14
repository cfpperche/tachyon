/**
 * t-b0cfd4 / t-dfc4de — one capability that cannot be delivered costs ITSELF, never the agent around it.
 *
 * ## The rule
 *
 * A pin exists to keep bytes a human never approved away from an agent. WITHHOLDING the capability
 * satisfies that purpose completely — the agent does not receive the new bytes. Invalidating the
 * whole configuration adds no protection on top of that; it only takes the rest of the agent down
 * with it. A refusal must be the size of what it protects.
 *
 * Measured three times on 2026-08-02, always the same shape: `product-foundation` (8.1 MiB against a
 * 1 MiB capture cap) refused EVERY delegation until 9aa17ace; agent-browser's changed sha refused
 * every delegation until 4601017b; and the same sha marked the whole coordinator `config invalid`,
 * which is what this module answers. In all three a problematic item cost the system instead of
 * costing itself.
 *
 * t-dfc4de extends the same rule past capture: a payload that captured cleanly but does not
 * validate, a selection without an exact host grant, or two capabilities claiming one delivered
 * name each cost those capabilities — never the agent that selected them.
 *
 * ## Why the notice is a shared function
 *
 * Two layers withhold — canonical config projection and delegated toolkit — and they must say the
 * SAME thing, because a human reading one and then the other cannot tell two wordings of one rule
 * from two different rules. The text names the capability, the reason, and the repair GESTURE that
 * already exists. Capture digest drift still names both digests; validation and collision name the
 * fix the human has to make on the source or selection. Re-authorization stays a human act when the
 * repair is accepting new bytes — nothing here automates it.
 */

/** One capability held back from an agent, and everything a human needs to decide what to do. */
export interface WithheldCapability {
  /** Profile reference id, or `plugin:<plugin>:<skill>` when the plugin lockfile is the grant door. */
  referenceId: string;
  /** The name the human sees in Agent Studio — the basename of the captured source. */
  name: string;
  /** Reference kind (`skill`, `mcp`, `hook`, `pi-*`), so the notice can say what was lost. */
  kind: string;
  /** Workspace-relative path of the source that could not be delivered. */
  path: string;
  /**
   * The diagnostic code that caused the withholding
   * (`profile/digest-mismatch`, `profile/capability`, `profile/capability-authority`,
   * `profile/capability-collision`, …).
   */
  code: string;
  /** The digest the profile pinned, when the failure knows it. */
  expectedSha256?: string;
  /** The digest actually read from disk, when the failure knows it. */
  consumedSha256?: string;
  /** The version recorded when the capability was authorized, when the reference carries one. */
  version?: string;
  /** The underlying failure detail, kept verbatim for the cases that are not a digest change. */
  detail: string;
}

function shortDigest(digest: string | undefined): string | undefined {
  return digest && digest.length > 16 ? `${digest.slice(0, 16)}…` : digest;
}

/** Capture-layer codes still use the Reauthorize gesture (bytes did not match the pin). */
const CAPTURE_CODES = new Set([
  "profile/digest-mismatch",
  "profile/too-large",
  "profile/missing-reference",
  "profile/unsafe-path",
  "profile/io",
  "profile/reference-unavailable",
]);

/**
 * The one sentence both layers emit. It has to carry three things, and it is tested for all three:
 * WHICH capability, WHY it was held back, and the gesture that repairs it. The agent-keeps-running
 * clause is always present so a warning never reads like a total failure.
 */
export function withheldCapabilityNotice(agentName: string, withheld: WithheldCapability): string {
  const what = `${withheld.kind} '${withheld.name}'`;
  const where = withheld.path;
  const running =
    `'${agentName}' keeps running without it and nothing else about it is affected. `;

  if (withheld.code === "profile/digest-mismatch") {
    const cause = `its content changed since it was authorized${withheld.version ? ` at version ${withheld.version}` : ""}`
      + ` (pinned ${shortDigest(withheld.expectedSha256) ?? "an earlier digest"},`
      + ` on disk ${shortDigest(withheld.consumedSha256) ?? "different bytes"})`;
    return `${what} is withheld from agent '${agentName}' because ${cause} — ${where}. `
      + running
      + "To accept the new content, open Agent Studio → Runtime tooling and use Reauthorize for it "
      + "(authorizeAgentSkill with reauthorize), which re-pins the capability to the digest on disk; "
      + "leaving it withheld keeps the pin you already approved.";
  }

  if (withheld.code === "profile/capability-authority") {
    return `${what} is withheld from agent '${agentName}' because it has no exact host-custodied grant `
      + `(${withheld.code}: ${withheld.detail}) — ${where}. `
      + running
      + "To restore it, open Agent Studio → Runtime tooling and authorize that capability so the host "
      + "records an exact grant matching its digest, adapter and kind; leaving it withheld keeps the "
      + "agent running without ungranted bytes.";
  }

  if (withheld.code === "profile/capability-collision") {
    return `${what} is withheld from agent '${agentName}' because its delivered name collides with `
      + `another selected capability (${withheld.code}: ${withheld.detail}) — ${where}. `
      + running
      + "Both claimants stay withheld — choosing a silent winner would hide the conflict. To restore "
      + "one of them, rename or deselect so only one capability claims that name, then reload.";
  }

  if (CAPTURE_CODES.has(withheld.code)) {
    const cause = `it could not be captured (${withheld.code}: ${withheld.detail})`;
    return `${what} is withheld from agent '${agentName}' because ${cause} — ${where}. `
      + running
      + "To accept the new content, open Agent Studio → Runtime tooling and use Reauthorize for it "
      + "(authorizeAgentSkill with reauthorize), which re-pins the capability to the digest on disk; "
      + "leaving it withheld keeps the pin you already approved.";
  }

  // profile/capability and any other per-capability validation failure: payload reached us but
  // is not a deliverable skill/MCP/hook/Pi resource (missing SKILL.md, YAML that does not parse, …).
  return `${what} is withheld from agent '${agentName}' because it is not a valid ${withheld.kind} `
    + `payload (${withheld.code}: ${withheld.detail}) — ${where}. `
    + running
    + "To restore it, fix the capability source (for a skill: a directory tree with a root SKILL.md; "
    + "for MCP/hook: a declaration that parses for this adapter; for Pi: the expected file type) or "
    + "remove it from the profile selection; re-authorize only if the digest also changed.";
}

/** Full digests for the durable surfaces, where the reader may need to compare exact bytes. */
export function withheldCapabilityDigestDetail(withheld: WithheldCapability): string {
  if (!withheld.expectedSha256 || !withheld.consumedSha256) return withheld.detail;
  return `expected ${withheld.expectedSha256}, consumed ${withheld.consumedSha256}`;
}
