/**
 * t-b0cfd4 — one capability that cannot be delivered costs ITSELF, never the agent around it.
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
 * ## Why the notice is a shared function
 *
 * Two layers withhold — canonical config projection and delegated toolkit — and they must say the
 * SAME thing, because a human reading one and then the other cannot tell two wordings of one rule
 * from two different rules. The text names the capability, both digests and the repair GESTURE that
 * already exists, because the failure it replaces named two hashes and left the reader to find the
 * button themselves.
 *
 * Re-authorization stays a human act. `authorizeAgentSkill`'s `reauthorize` has no default on
 * purpose — it says "I know this content changed since I approved it" — and nothing here automates
 * it. What changes is the COST of not having done it yet: one missing tool instead of a dead agent.
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
  /** The diagnostic code that caused the withholding (`profile/digest-mismatch`, `profile/too-large`, …). */
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

/**
 * The one sentence both layers emit. It has to carry four things, and it is tested for all four:
 * WHICH capability, what the agent lost, the two digests, and the gesture that repairs it.
 */
export function withheldCapabilityNotice(agentName: string, withheld: WithheldCapability): string {
  const what = `${withheld.kind} '${withheld.name}'`;
  const where = withheld.path;
  const cause = withheld.code === "profile/digest-mismatch"
    ? `its content changed since it was authorized${withheld.version ? ` at version ${withheld.version}` : ""}`
      + ` (pinned ${shortDigest(withheld.expectedSha256) ?? "an earlier digest"},`
      + ` on disk ${shortDigest(withheld.consumedSha256) ?? "different bytes"})`
    : `it could not be captured (${withheld.code}: ${withheld.detail})`;
  return `${what} is withheld from agent '${agentName}' because ${cause} — ${where}. `
    + `'${agentName}' keeps running without it and nothing else about it is affected. `
    + "To accept the new content, open Agent Studio → Runtime tooling and use Reauthorize for it "
    + "(authorizeAgentSkill with reauthorize), which re-pins the capability to the digest on disk; "
    + "leaving it withheld keeps the pin you already approved.";
}

/** Full digests for the durable surfaces, where the reader may need to compare exact bytes. */
export function withheldCapabilityDigestDetail(withheld: WithheldCapability): string {
  if (!withheld.expectedSha256 || !withheld.consumedSha256) return withheld.detail;
  return `expected ${withheld.expectedSha256}, consumed ${withheld.consumedSha256}`;
}
