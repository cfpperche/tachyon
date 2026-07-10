const DEV_ARTIFACTS = [
  /^dist\/webview-preview(?:\/|$)/,
  /^dist\/webview\/agent-studio-fixture(?:\.|\/|$)/,
  /\.map$/,
];

const SHIPPED_FILES = [
  /^dist\//,
  /^media\//,
  /^l10n\//,
  /^package\.json$/,
  /^package\.nls(?:\.[^/]+)?\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^provenance\.json$/,
];

export function classifyShipFile(relPath) {
  const normalized = relPath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (DEV_ARTIFACTS.some((pattern) => pattern.test(normalized))) return "dev-artifact";
  if (SHIPPED_FILES.some((pattern) => pattern.test(normalized))) return "allowed";
  return "forbidden";
}
