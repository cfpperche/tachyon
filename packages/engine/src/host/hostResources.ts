import hostMemory from "@tachyon/shared/host-memory.cjs";

/**
 * Product-only host memory reading. Test gate sizing lives under scripts/ so none of its policy or
 * TACHYON_VERIFY_* controls enter the extension daemon bundle. The shared CJS module remains the
 * single runtime implementation and this file is its typed engine door.
 */

export type HostMemorySnapshot = hostMemory.HostMemorySnapshot;

export const { parseMeminfo, readHostMemory } = hostMemory;
