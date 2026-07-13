/** @jsxRuntime automatic @jsxImportSource preact */
import type { JSX } from "preact";

export const RUNTIME_LOGO_IDS = [
  "claude",
  "codex",
  "agy",
  "gemini",
  "opencode",
  "copilot",
  "aider",
  "goose",
  "amp",
  "grok",
  "qwen",
  "cursor-agent",
  "pi",
  "hermes",
  "verboo",
] as const;

export type RuntimeLogoId = (typeof RUNTIME_LOGO_IDS)[number];
type RuntimeLogoSvg = () => JSX.Element;

const ClaudeLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <path fill="#D97757" fill-rule="nonzero" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
  </svg>
);

const CodexLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <path fill="currentColor" fill-rule="evenodd" d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
  </svg>
);

const GeminiLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <path fill="#8E75B2" d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
  </svg>
);

const OpenCodeLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <path fill="currentColor" d="M22 24H2V0h20zM17 4.8H7v14.4h10z" />
  </svg>
);

const CopilotLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <path fill="currentColor" d="M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z" />
  </svg>
);

const AiderLogo = () => (
  <svg viewBox="0 0 200 60" class="ash-runtime-logo ash-runtime-logo-wide" aria-hidden="true" focusable="false">
    <text x="100" y="38" fill="#14B014" font-family="monospace" font-size="48" text-anchor="middle">aider</text>
  </svg>
);

const AmpLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <path fill="#005AF0" d="M12 0c6.628 0 12 5.373 12 12s-5.372 12-12 12C5.373 24 0 18.627 0 12S5.373 0 12 0zm-.92 19.278l5.034-8.377a.444.444 0 00.097-.268.455.455 0 00-.455-.455l-2.851.004.924-5.468-.927-.003-5.018 8.367s-.1.183-.1.291c0 .251.204.455.455.455l2.831-.004-.901 5.458z" />
  </svg>
);

const QwenLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <path fill="#6950EF" d="M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z" />
  </svg>
);

const CursorAgentLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <path fill="currentColor" d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
  </svg>
);

/** No official Antigravity brand asset ships in the repo (docs/specs/327) — a neutral upward-motion mark. */
const AntigravityLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="none" stroke="currentColor" stroke-width="2" />
    <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M8 14l4-5 4 5" />
  </svg>
);

/** No official goose brand asset in the repo — a neutral bird-silhouette placeholder. */
const GooseLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M2 14c3-5 7-5 10-2 3-3 7-3 10 2" />
  </svg>
);

/** Official Pi mark from https://pi.dev/logo.svg — block "Pi" glyph; fill follows theme. */
const PiLogo = () => (
  <svg viewBox="0 0 800 800" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <path fill="currentColor" fill-rule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
    <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
  </svg>
);

/** Official Hermes ACP icon from NousResearch/hermes-agent acp_registry/icon.svg — caduceus staff. */
const HermesLogo = () => (
  <svg viewBox="0 0 16 16" class="ash-runtime-logo" aria-hidden="true" focusable="false" fill="none">
    <path d="M8 1.5v13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    <path d="M8 3.25c-2.35-1.4-4.7-.95-6.25.35 1.85-.2 3.8.2 5.55 1.55" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M8 3.25c2.35-1.4 4.7-.95 6.25.35-1.85-.2-3.8.2-5.55 1.55" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M8 13.25c-2.3-1-3.05-2.65-1.35-4.15-2 .8-2.35 2.95-.35 4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M8 13.25c2.3-1 3.05-2.65 1.35-4.15 2 .8 2.35 2.95.35 4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
    <circle cx="8" cy="1.8" r="1.1" fill="currentColor" />
  </svg>
);

/** Official Verboo Code mark from verbeux-ai/code vscode-extension media/verboo.svg — terminal + caret. */
const VerbooLogo = () => (
  <svg viewBox="0 0 128 128" class="ash-runtime-logo" aria-hidden="true" focusable="false" fill="none">
    <rect width="128" height="128" rx="20" fill="#0B0F18" />
    <rect x="16" y="20" width="96" height="88" rx="10" fill="#090B10" stroke="#2A3350" />
    <path d="M32 48L46 60L32 72" stroke="#66D9EF" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />
    <rect x="56" y="68" width="38" height="8" rx="4" fill="#89DD7C" />
  </svg>
);

/** grok is the only runtime still on a PNG data-URI (valid, 32x32) — kept as <img> so it isn't broken by this fix. */
const pngLogos: Record<string, string> = {
  grok: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAY1BMVEX///8AAACfn5/f39+/v7/Pz88NDQ2vr6/s7OxDQ0MeHh7w8PAHBwdUVFTk5OQvLy9PT0/Jyck7Ozu4uLiEhIR2dnZoaGixsbH19fUnJycXFxeRkZFcXFy8vLyoqKg/Pz9kZGR1Z31eAAAAwklEQVQ4jd2R0Q6CMAxFe8eGgCBOBBER/P+vtCt7YhvvugTS5B7W9kD0tyczxpyP8hyojoAbgM6m8zvn/aCSuamB9oEkMD6BWk847QfTWmeuGLjBq0EI+Mk7zkuqQoAUJzMVE5BfqAXeQXO+FkvvXuQAHQDysc35GjERAlt7JQpXICZKFpBVSsBEgMIpkOAaBUylncQxBbDCRn4D1zOQRSewPJ2bPwZsCr3QTwh4hV4o+yr2EyqlZPWFi9HyE1nzd88XhycHNygsF+YAAAAASUVORK5CYII=",
};

/** Any remaining PNG data-URIs in this module (kept only for grok) — exported so tests can catch a bad base64 paste. */
export const PNG_LOGOS: Readonly<Record<string, string>> = pngLogos;

export const RUNTIME_LOGOS: Record<Exclude<RuntimeLogoId, "grok">, RuntimeLogoSvg> = {
  claude: ClaudeLogo,
  codex: CodexLogo,
  agy: AntigravityLogo,
  gemini: GeminiLogo,
  opencode: OpenCodeLogo,
  copilot: CopilotLogo,
  aider: AiderLogo,
  goose: GooseLogo,
  amp: AmpLogo,
  qwen: QwenLogo,
  "cursor-agent": CursorAgentLogo,
  pi: PiLogo,
  hermes: HermesLogo,
  verboo: VerbooLogo,
};

export function RuntimeLogo({ id }: { id: string }) {
  const png = pngLogos[id];
  if (png) return <img class="ash-runtime-logo ash-runtime-logo-img" src={png} alt="" aria-hidden="true" />;
  const Logo = RUNTIME_LOGOS[id as Exclude<RuntimeLogoId, "grok">];
  return Logo ? <Logo /> : null;
}
