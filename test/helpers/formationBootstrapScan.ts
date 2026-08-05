/**
 * SDD 490 Fatia A — the syntax-level scanner behind the "one door to `mutation: \"bootstrap\"`" guard.
 *
 * ## Why this is an AST walk and not a grep
 *
 * On 2026-08-03 this repository shipped a static guard written to close exactly this class of gap,
 * and the guard was blind: it compared line TEXT against a `switch` body, so an injected bypass
 * matched as a substring of the switch's own `case` and every violation passed. The fail-before
 * caught it; nothing else would have.
 *
 * Text matching cannot answer the question this guard is asking. "Does any production file call the
 * authority store with the bootstrap mutation?" is a question about call expressions and their
 * arguments — a comment that discusses bootstrap is not a door, and a call that reaches the mutation
 * through a variable is a door even though the word never appears near it. So this walks the parsed
 * program.
 *
 * ## What counts as a door
 *
 * The two store entry points that can carry a `FormationVectorMutation`: `replaceVector` and
 * `beginMutationBarrier`. For each call site, the `mutation:` property of the object argument is
 * classified:
 *
 * - **literal** — `mutation: "bootstrap"`. A direct door. There must be exactly one.
 * - **dynamic** — `mutation: something.else`. A door that cannot be seen by reading for the word, and
 *   the shape that actually caused C2's concern. These are enumerated, and each entry on the list is
 *   closed by a named behavioral test rather than by assertion.
 *
 * A literal that is any OTHER mutation is not a bootstrap door and is ignored.
 */

import ts from "typescript";

/** The single production module permitted to name the bootstrap mutation. */
export const BOOTSTRAP_DOOR_MODULE = "src/agents/formation/bootstrapTransaction.ts";

/**
 * Call sites that forward a mutation they did not choose. Each one is closed by a test in
 * `agentFormationBootstrap.test.ts`, not by this list — the list only makes a NEW one visible.
 *
 * - `humanLaneTransactions.ts` — `commit()` forwards `barrier.mutation` verbatim. Its `parseIntent`
 *   requires the barrier's mutation to be `profile-edit` or `retire`, so a bootstrap barrier throws
 *   before the forward. Covered by "closes the dynamic pass-through".
 */
export const DYNAMIC_MUTATION_CALL_SITES = ["src/agents/formation/humanLaneTransactions.ts"] as const;

const STORE_MUTATION_ENTRY_POINTS = new Set(["replaceVector", "beginMutationBarrier"]);

export interface BootstrapCallSites {
  /** Files containing a call site whose `mutation:` is the literal `"bootstrap"`, sorted, deduped. */
  literal: string[];
  /** Files containing a call site whose `mutation:` is not a string literal, sorted, deduped. */
  dynamic: string[];
}

export function bootstrapCallSites(files: ReadonlyArray<{ file: string; text: string }>): BootstrapCallSites {
  const literal = new Set<string>();
  const dynamic = new Set<string>();

  for (const { file, text } of files) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, /* setParentNodes */ true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) classify(node, file, literal, dynamic);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { literal: [...literal].sort(), dynamic: [...dynamic].sort() };
}

function classify(call: ts.CallExpression, file: string, literal: Set<string>, dynamic: Set<string>): void {
  if (!reachesStoreMutation(call.expression)) return;
  for (const argument of call.arguments) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      const name = property.name && ts.isIdentifier(property.name) ? property.name.text : undefined;
      if (name !== "mutation") continue;
      // Shorthand (`{ mutation }`) carries a value chosen elsewhere — dynamic by definition.
      if (!ts.isPropertyAssignment(property)) {
        dynamic.add(file);
        continue;
      }
      const value = property.initializer;
      if (ts.isStringLiteralLike(value)) {
        if (value.text === "bootstrap") literal.add(file);
        continue;
      }
      dynamic.add(file);
    }
  }
}

/**
 * True when the callee names one of the store's mutation entry points, however it is reached:
 * `store.replaceVector(...)`, `this.store.replaceVector(...)`, `obj?.beginMutationBarrier(...)`, or a
 * bare `replaceVector(...)` destructured off the store. Matching on the NAME rather than on a
 * particular receiver expression is deliberate — a guard that only recognised `this.store.x` would be
 * bypassed by pulling the method into a local, which is precisely the class of miss being defended
 * against.
 */
function reachesStoreMutation(callee: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(callee)) return STORE_MUTATION_ENTRY_POINTS.has(callee.name.text);
  if (ts.isElementAccessExpression(callee)) {
    const argument = callee.argumentExpression;
    return ts.isStringLiteralLike(argument) && STORE_MUTATION_ENTRY_POINTS.has(argument.text);
  }
  if (ts.isIdentifier(callee)) return STORE_MUTATION_ENTRY_POINTS.has(callee.text);
  if (ts.isParenthesizedExpression(callee)) return reachesStoreMutation(callee.expression);
  if (ts.isNonNullExpression(callee)) return reachesStoreMutation(callee.expression);
  return false;
}
