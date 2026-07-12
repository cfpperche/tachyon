#!/usr/bin/env node
// SDD 368 T14.6B2 headless lifecycle marker. The unit lifecycle owns the
// temporary git fixture; this script is intentionally dependency-free so it can
// be invoked by CI after the extension build as a stable dogfood entrypoint.
import { existsSync } from "node:fs";

const root = process.cwd();
if (!existsSync(new URL("../../package.json", import.meta.url))) {
  throw new Error("delivery lease dogfood must run from the repository checkout");
}
console.log(`delivery lease dogfood ready: ${root}`);
