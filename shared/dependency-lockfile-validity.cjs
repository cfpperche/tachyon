/**
 * The environment-independent dependency provenance shared by worktree setup and verification
 * recording. CommonJS is deliberate: extension-host source compiles as CJS while the verification
 * gate is an `.mjs` script, so both can consume this module without depending on each other's tree.
 */
const { createHash } = require("node:crypto");

const LOCKFILES = Object.freeze([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
]);

/** Digest the lockfile set: names and bytes both, so an added or removed lockfile is divergence. */
function fingerprintLockfiles(read) {
  const hash = createHash("sha256");
  const files = [];
  for (const name of LOCKFILES) {
    const bytes = read(name);
    if (!bytes) continue;
    files.push(name);
    // Length-prefixed so no pair of (name, content) concatenations can collide.
    hash.update(`${name}:${bytes.length}:`);
    hash.update(bytes);
  }
  return { digest: hash.digest("hex"), files };
}

/** Name WHICH lockfiles disagree — "they differ" without saying how is not actionable. */
function lockfileDivergenceReason(primary, worktree) {
  const added = worktree.files.filter((file) => !primary.files.includes(file));
  const removed = primary.files.filter((file) => !worktree.files.includes(file));
  const parts = [];
  if (added.length > 0) parts.push(`this worktree adds ${added.join(", ")}`);
  if (removed.length > 0) parts.push(`this worktree is missing ${removed.join(", ")}`);
  if (parts.length === 0) {
    const shared = worktree.files.length > 0 ? worktree.files.join(", ") : "the lockfile set";
    parts.push(`${shared} differs in content from the primary checkout`);
  }
  return `${parts.join("; ")} — this worktree needs its own dependencies`;
}

module.exports = { LOCKFILES, fingerprintLockfiles, lockfileDivergenceReason };
