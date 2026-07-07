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
] as const;

export type RuntimeLogoId = (typeof RUNTIME_LOGO_IDS)[number];
type RuntimeLogoSvg = () => JSX.Element;

const ClaudeLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <path fill="#D97757" d="M11.98 2.1l2.07 6.33 5.88-3.13-3.13 5.88 6.33 2.07-6.33 2.07 3.13 5.88-5.88-3.13-2.07 6.33-2.06-6.33-5.89 3.13 3.14-5.88L.83 13.25l6.34-2.07L4.03 5.3l5.89 3.13 2.06-6.33Z" />
    <circle cx="11.98" cy="13.25" r="2.35" fill="#FFF7ED" />
  </svg>
);

const CodexLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <g fill="none" stroke="#10A37F" stroke-width="2.05" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3.15c2.58 0 4.38 1.24 5.05 3.06 1.96.35 3.38 1.87 3.38 4.02 0 1.35-.58 2.44-1.48 3.18.28 2.04-.74 3.9-2.71 4.95-1.22.65-2.58.7-3.78.25-1.48 1.39-3.6 1.69-5.48.63-1.14-.65-1.84-1.72-2.09-2.9-1.74-.8-2.83-2.5-2.6-4.56.15-1.36.9-2.4 1.94-3.03-.05-2.07 1.1-3.86 3.08-4.76 1.28-.58 2.54-.52 3.56.02.38-.52.78-.86 1.13-.86Z" />
      <path d="M8.2 4.1l7.15 4.14v8.27" />
      <path d="M19 13.36l-7.13 4.12-7.13-4.12" />
      <path d="M4.75 8.77l7.12 4.12 7.12-4.12" />
      <path d="M8.36 19.17v-8.23L15.49 6.8" />
    </g>
  </svg>
);

const AntigravityLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <path fill="#4285F4" d="M12 2.6l8.14 4.7v9.4L12 21.4l-8.14-4.7V7.3L12 2.6Z" />
    <path fill="#fff" d="M12 5.45l5.67 3.27v6.56L12 18.55l-5.67-3.27V8.72L12 5.45Zm0 3.18-2.92 1.69v3.36L12 15.37l2.92-1.69v-3.36L12 8.63Z" />
    <path fill="#34A853" d="M12 8.63l2.92 1.69v3.36L12 15.37V8.63Z" />
    <path fill="#FBBC04" d="M6.33 8.72L12 5.45v3.18l-2.92 1.69-2.75-1.6Z" />
    <path fill="#EA4335" d="M6.33 15.28l2.75-1.6L12 15.37v3.18l-5.67-3.27Z" />
  </svg>
);

const GeminiLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="geminiLogoGradient" x1="5" y1="19" x2="19" y2="5" gradientUnits="userSpaceOnUse">
        <stop stop-color="#4285F4" />
        <stop offset=".48" stop-color="#A142F4" />
        <stop offset="1" stop-color="#EA4335" />
      </linearGradient>
    </defs>
    <path fill="url(#geminiLogoGradient)" d="M12 2.5c.92 5.3 4.2 8.58 9.5 9.5-5.3.92-8.58 4.2-9.5 9.5-.92-5.3-4.2-8.58-9.5-9.5 5.3-.92 8.58-4.2 9.5-9.5Z" />
  </svg>
);

const OpenCodeLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <rect x="3" y="3" width="18" height="18" rx="3.8" fill="#111827" />
    <path fill="#F8FAFC" d="M8.85 7.55L4.9 12l3.95 4.45 1.45-1.32L7.55 12l2.75-3.13-1.45-1.32Zm6.3 0-1.45 1.32L16.45 12l-2.75 3.13 1.45 1.32L19.1 12l-3.95-4.45Z" />
  </svg>
);

const CopilotLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <path fill="#24292F" d="M7.6 7.05c.52-2.42 2.08-3.95 4.4-3.95 2.34 0 3.9 1.53 4.42 3.95 2.54.35 4.38 2.45 4.38 5.23v4.37c0 2.1-1.7 3.8-3.8 3.8H7c-2.1 0-3.8-1.7-3.8-3.8v-4.37c0-2.78 1.84-4.88 4.4-5.23Z" />
    <path fill="#fff" d="M8.15 12.05c1.2 0 2.15.98 2.15 2.18s-.95 2.17-2.15 2.17S6 15.43 6 14.23s.95-2.18 2.15-2.18Zm7.7 0c1.2 0 2.15.98 2.15 2.18s-.95 2.17-2.15 2.17-2.15-.97-2.15-2.17.95-2.18 2.15-2.18Z" />
    <path fill="#24292F" d="M8.15 13.35c.48 0 .85.4.85.88s-.37.87-.85.87-.85-.39-.85-.87.37-.88.85-.88Zm7.7 0c.48 0 .85.4.85.88s-.37.87-.85.87-.85-.39-.85-.87.37-.88.85-.88Z" />
  </svg>
);

const AiderLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <path fill="#1F7A8C" d="M12 2.6 22 21.4h-4.35l-1.72-3.5H8.07l-1.72 3.5H2L12 2.6Zm0 6.85-2.42 5.25h4.84L12 9.45Z" />
  </svg>
);

const GooseLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <path fill="#F59E0B" d="M5.1 15.65c0-4.18 3.38-7.55 7.55-7.55h2.68c2.26 0 4.1 1.84 4.1 4.1v1.5h-4.07l2.68 3.18-1.68 1.43-3.9-4.61h-2.1v7.05H7.4V18.7a4.04 4.04 0 0 1-2.3-3.05Z" />
    <path fill="#fff" d="M15.35 5.25a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />
    <circle cx="13.35" cy="5.25" r=".62" fill="#111827" />
  </svg>
);

const AmpLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <path fill="#FF5A1F" d="M7.1 20.8h-4L11.55 3.2h.9l8.45 17.6h-4l-1.34-3.12H8.44L7.1 20.8Zm2.55-5.94h4.7L12 9.28l-2.35 5.58Z" />
  </svg>
);

const GrokLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <rect x="3" y="3" width="18" height="18" rx="4" fill="#111" />
    <path fill="#fff" d="M17.55 6.1 12.9 12l4.65 5.9h-3.28l-3-3.9-3.02 3.9H4.95L9.62 12 4.95 6.1h3.3l3.02 3.9 3-3.9h3.28Z" />
  </svg>
);

const QwenLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="9.4" fill="#615CED" />
    <path fill="#fff" d="M12 5.8a6.2 6.2 0 0 1 4.5 10.48l2.1 2.1-1.74 1.74-2.35-2.35A6.2 6.2 0 1 1 12 5.8Zm0 2.55a3.65 3.65 0 1 0 0 7.3 3.65 3.65 0 0 0 0-7.3Z" />
  </svg>
);

const CursorAgentLogo = () => (
  <svg viewBox="0 0 24 24" class="ash-runtime-logo" aria-hidden="true" focusable="false">
    <path fill="#111827" d="M4.2 2.8 20.5 12 4.2 21.2V2.8Z" />
    <path fill="#fff" d="m8.3 8.2 6.77 3.8-6.77 3.8V8.2Z" />
    <path fill="#111827" d="m10.15 11.4 2.15.6-2.15.6v-1.2Z" />
  </svg>
);

export const RUNTIME_LOGOS: Record<RuntimeLogoId, RuntimeLogoSvg> = {
  claude: ClaudeLogo,
  codex: CodexLogo,
  agy: AntigravityLogo,
  gemini: GeminiLogo,
  opencode: OpenCodeLogo,
  copilot: CopilotLogo,
  aider: AiderLogo,
  goose: GooseLogo,
  amp: AmpLogo,
  grok: GrokLogo,
  qwen: QwenLogo,
  "cursor-agent": CursorAgentLogo,
};

export function RuntimeLogo({ id }: { id: string }) {
  const Logo = RUNTIME_LOGOS[id as RuntimeLogoId];
  return Logo ? <Logo /> : null;
}
