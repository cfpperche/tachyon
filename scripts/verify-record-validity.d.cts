declare const validityContract: {
  DEFAULT_MAX_RECORD_AGE_MS: number;
  verificationRecordValidity(
    record: unknown,
    options?: {
      expectedFingerprint?: string;
      maxAgeMs?: number;
      now?: () => number;
    },
  ): { valid: true } | { valid: false; reason: string };
};

export = validityContract;
