import { HANDOFF_TEMPLATE, type ProjectHandoffStore } from "./ProjectHandoffStore.js";
import { projectHandoffRelativePath, resolveHandoffFilePath } from "./handoffPath.js";

export interface EnsureProjectHandoffFileResult {
  relativePath: string;
  created: boolean;
}

/** Idempotently materializes the canonical template and returns its safe workspace-relative identity. */
export function ensureProjectHandoffFile(
  workspaceRoot: string,
  store: ProjectHandoffStore,
): EnsureProjectHandoffFileResult {
  const relativePath = projectHandoffRelativePath(workspaceRoot, store.canonicalPath);
  const { created } = store.ensureCanonical(HANDOFF_TEMPLATE, "human");
  resolveHandoffFilePath(workspaceRoot, relativePath);
  return { relativePath, created };
}
