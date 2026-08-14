interface LockfileFingerprint {
  digest: string;
  files: string[];
}

declare const dependencyLockfileValidity: {
  LOCKFILES: readonly [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
  ];
  fingerprintLockfiles(read: (name: string) => Buffer | null): LockfileFingerprint;
  lockfileDivergenceReason(primary: LockfileFingerprint, worktree: LockfileFingerprint): string;
};

export = dependencyLockfileValidity;
