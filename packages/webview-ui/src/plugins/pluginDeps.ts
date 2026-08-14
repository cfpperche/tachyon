export type DependencyStatus = "satisfied" | "out-of-range" | "missing";

export interface DependencyState {
  name: string;
  range: string;
  status: DependencyStatus;
  /** the installed version (when present), for the drawer to show "have X, want <range>". */
  installedVersion?: string;
}
