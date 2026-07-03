// spec 342 — the Kit legacy-fallback kill switch. ONE build-time flag per component that has a genuine
// pre-existing legacy implementation to fall back to (only KitSelect today — see notes.md's "T4 — fallback
// scope" design decision for why KitFieldRow/KitLabeledInput/KitDropdown don't need one). Baked in via
// esbuild's `define` (esbuild.mjs), NEVER a runtime toggle and NEVER a call-site change: flip with
// `TACHYON_KIT_SELECT=legacy npm run build`. Outside an esbuild bundle (e.g. plain `tsc`/vitest node
// execution, which never defines the global), the safe default is the vendored implementation.
declare const __TACHYON_KIT_FLAGS__: { select: "radix" | "legacy" } | undefined;

export const KIT_FLAGS: { select: "radix" | "legacy" } =
  typeof __TACHYON_KIT_FLAGS__ !== "undefined" ? __TACHYON_KIT_FLAGS__ : { select: "radix" };
