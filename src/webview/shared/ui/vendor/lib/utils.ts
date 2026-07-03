import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn/ui's standard `cn` helper (unmodified) — the ONE adaptation every vendored component needs is
// pointing its `@/lib/utils` import here instead. clsx + tailwind-merge are exact-pinned deps (see
// VENDORED.md).
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
