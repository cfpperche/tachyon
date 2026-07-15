const STAGED_PAYLOAD_TOKEN_RE = /^[a-f0-9]{48}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export interface StagedPayloadRefV1 {
  schemaVersion: 1;
  token: string;
  sha256: string;
  byteSize: number;
}

export function isStagedPayloadRefV1(value: unknown): value is StagedPayloadRefV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<StagedPayloadRefV1>;
  const keys = Object.keys(value);
  return keys.length === 4
    && keys.every((key) => key === "schemaVersion" || key === "token" || key === "sha256" || key === "byteSize")
    && candidate.schemaVersion === 1
    && typeof candidate.token === "string"
    && STAGED_PAYLOAD_TOKEN_RE.test(candidate.token)
    && typeof candidate.sha256 === "string"
    && SHA256_RE.test(candidate.sha256)
    && Number.isSafeInteger(candidate.byteSize)
    && (candidate.byteSize ?? 0) > 0;
}
