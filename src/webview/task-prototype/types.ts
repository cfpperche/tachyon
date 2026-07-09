export interface TaskPrototypeVM {
  id: string;
  sha256: string;
  state: "draft" | "approved" | "superseded" | "rejected";
  title: string;
  author: string;
  createdAt: string;
  available: boolean;
  integrity: "verified" | "missing" | "mismatch" | "policy-unknown";
  needsTaskReconciliation?: boolean;
  /** Host-assembled static document. It has a child CSP with script-src none and is rendered only in sandbox="". */
  staticSrcdoc?: string;
}

export interface TaskPrototypeListVM {
  updatedAt?: string;
  readOnly: boolean;
  error?: string;
  prototypes: TaskPrototypeVM[];
}
