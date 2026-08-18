/** Apply the chosen bundled mono family. Lives in CSS via `data-tachyon-font` on <html>. */
export function applyTachyonFont(face: "tachyon" | "departure"): void {
  if (typeof document === "undefined") return;
  if (face === "departure") document.documentElement.setAttribute("data-tachyon-font", "departure");
  else document.documentElement.removeAttribute("data-tachyon-font");
}
