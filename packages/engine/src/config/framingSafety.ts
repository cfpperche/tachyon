/** Characters that can create terminal/control framing, visual line breaks or bidi reordering
 * when project-configured facts are interpolated into a Tachyon-generated primer. */
const UNSAFE_FRAMING_CHAR_RE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

export function containsUnsafeFramingCharacter(value: string): boolean {
  return UNSAFE_FRAMING_CHAR_RE.test(value);
}
