#!/usr/bin/env node
/**
 * t-48dd8d — nobody adds a `settings:` key whose ABSENCE is the permissive state without saying so.
 *
 * The loader stopped refusing tachyon.yml over a bad key: the key is discarded and the rest of the
 * file loads. That is only safe while absence lands on the closed side, and it does not always —
 * `tabSafety.ts` permits every host when the allowlist is missing, and a delegated codex agent with
 * nothing projected is launched with `sandbox_mode="danger-full-access"`. Both of those are keys
 * somebody added later, to a loader whose fail-closed return made the question invisible.
 *
 * So this guard makes the question mandatory rather than remembered. `src/config/settingsSafeSide.ts`
 * declares, for every settings key, which way the product falls when the key is discarded; this
 * cross-checks that table against the config type and the parser and fails on any gap — most of all
 * an `opens` key with neither a closure nor a written-down accepted risk.
 *
 * It is an AST guard on purpose. A regex over `loadConfig.ts` would be reading a file that is close
 * to half comment, and a regex guard in this repository has twice broken main by matching an
 * identifier inside a comment. Every fact below comes from a parsed node.
 *
 * Run directly: `node scripts/check-settings-fallbacks.mjs` (exit 1 and a report on any gap).
 * `test/unit/settingsFallbackGuard.test.ts` imports these same functions rather than restating them.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LOAD_CONFIG = path.join(ROOT, "src/config/loadConfig.ts");
export const SAFE_SIDE = path.join(ROOT, "src/config/settingsSafeSide.ts");

function sourceFile(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function propertyName(member) {
  const name = member.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/** The object-literal type nodes inside `node`: the node itself, or the literal arms of a union. */
function typeLiterals(node) {
  if (!node) return [];
  if (ts.isTypeLiteralNode(node)) return [node];
  if (ts.isUnionTypeNode(node)) return node.types.flatMap(typeLiterals);
  if (ts.isParenthesizedTypeNode(node)) return typeLiterals(node.type);
  return [];
}

/**
 * Every leaf path under `TachyonConfig["settings"]`, dotted. A member whose type is written as an
 * inline object literal is walked into; a member typed by NAME (`Record<…>`, `ProjectGuidanceSettings`)
 * is a leaf, because its shape is owned by another module and the door is the key itself.
 */
export function settingsTypeLeaves(loadConfigText) {
  const source = sourceFile("loadConfig.ts", loadConfigText);
  let settingsType;
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== "TachyonConfig") continue;
    for (const member of statement.members) {
      if (ts.isPropertySignature(member) && propertyName(member) === "settings") settingsType = member.type;
    }
  }
  if (!settingsType) throw new Error("could not find TachyonConfig['settings'] — the guard cannot answer without it");

  const leaves = [];
  const walk = (typeNode, prefix) => {
    const literals = typeLiterals(typeNode);
    if (literals.length === 0) {
      leaves.push(prefix);
      return;
    }
    for (const literal of literals) {
      for (const member of literal.members) {
        if (!ts.isPropertySignature(member)) continue;
        const name = propertyName(member);
        if (name === undefined) continue;
        walk(member.type, prefix ? `${prefix}.${name}` : name);
      }
    }
  };
  for (const literal of typeLiterals(settingsType)) {
    for (const member of literal.members) {
      if (!ts.isPropertySignature(member)) continue;
      const name = propertyName(member);
      if (name === undefined) continue;
      walk(member.type, name);
    }
  }
  return leaves;
}

function stringOf(node) {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  // A message assembled with `+` is still a constant; only its VALUE is irrelevant here, so any
  // non-literal simply reads as "present but not a plain string".
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = stringOf(node.left);
    const right = stringOf(node.right);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  return undefined;
}

function arrayLiteralInitializer(source, name) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      let initializer = declaration.initializer;
      while (
        initializer &&
        (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer) || ts.isParenthesizedExpression(initializer))
      ) {
        initializer = initializer.expression;
      }
      if (initializer && ts.isArrayLiteralExpression(initializer)) return initializer;
    }
  }
  return undefined;
}

function objectProperties(node) {
  const out = new Map();
  if (!ts.isObjectLiteralExpression(node)) return out;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property);
    if (name !== undefined) out.set(name, property.initializer);
  }
  return out;
}

/** The declared table: `{ path, kind, direction, acceptedRisk }` rows plus the closures. */
export function safeSideRegistry(safeSideText) {
  const source = sourceFile("settingsSafeSide.ts", safeSideText);

  const fallbacksNode = arrayLiteralInitializer(source, "SETTINGS_KEY_FALLBACKS");
  if (!fallbacksNode) throw new Error("could not find SETTINGS_KEY_FALLBACKS as an array literal");
  const entries = fallbacksNode.elements.map((element) => {
    const properties = objectProperties(element);
    return {
      path: stringOf(properties.get("path")),
      kind: stringOf(properties.get("kind")),
      direction: stringOf(properties.get("direction")),
      why: stringOf(properties.get("why")),
      acceptedRisk: stringOf(properties.get("acceptedRisk")),
    };
  });

  const closuresNode = arrayLiteralInitializer(source, "SETTINGS_DOOR_CLOSURES");
  if (!closuresNode) throw new Error("could not find SETTINGS_DOOR_CLOSURES as an array literal");
  const closures = closuresNode.elements.map((element) => {
    const properties = objectProperties(element);
    const covers = properties.get("covers");
    return {
      domain: stringOf(properties.get("domain")),
      covers: covers && ts.isArrayLiteralExpression(covers) ? covers.elements.map(stringOf) : undefined,
    };
  });

  return { entries, closures };
}

/**
 * What the PARSER does, read from its own nodes:
 *  - `reads`: every `raw.settings.<name>` it touches, i.e. every key it can actually act on.
 *  - `tracked`: every door it records as warned, via `markSettingsWarned("x", …)` or
 *    `warnedSettingsPaths.add("x")` / a template starting `x.`. A closure whose domain is never
 *    tracked can never fire, which is the silent way this whole mechanism would die.
 */
export function parserSettingsUse(loadConfigText) {
  const source = sourceFile("loadConfig.ts", loadConfigText);
  const reads = new Set();
  const tracked = new Set();

  const visit = (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "raw" &&
      node.expression.name.text === "settings"
    ) {
      reads.add(node.name.text);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isMark = ts.isIdentifier(callee) && callee.text === "markSettingsWarned";
      const isAdd =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "warnedSettingsPaths" &&
        callee.name.text === "add";
      if (isMark || isAdd) {
        const first = node.arguments[0];
        const literal = stringOf(first);
        if (literal !== undefined) tracked.add(literal);
        else if (first && ts.isTemplateExpression(first)) {
          // `agentPermissionProjection.${name}` — the constant head names the domain.
          tracked.add(first.head.text.replace(/\.$/, ""));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { reads, tracked };
}

const KINDS = new Set(["stored", "ignored", "internal"]);
const DIRECTIONS = new Set(["closes", "same", "opens"]);

/** Every gap, as a human-readable line. Empty means the table, the type and the parser agree. */
export function auditSettingsFallbacks({ loadConfigText, safeSideText }) {
  const problems = [];
  const leaves = settingsTypeLeaves(loadConfigText);
  const { entries, closures } = safeSideRegistry(safeSideText);
  const { reads, tracked } = parserSettingsUse(loadConfigText);

  const byPath = new Map();
  for (const entry of entries) {
    if (!entry.path) {
      problems.push("settingsSafeSide: an entry has no literal 'path'");
      continue;
    }
    if (byPath.has(entry.path)) problems.push(`settingsSafeSide: duplicate entry for '${entry.path}'`);
    byPath.set(entry.path, entry);
    if (!KINDS.has(entry.kind)) problems.push(`settingsSafeSide.${entry.path}: kind must be one of ${[...KINDS].join(", ")}`);
    if (!DIRECTIONS.has(entry.direction)) {
      problems.push(`settingsSafeSide.${entry.path}: direction must be one of ${[...DIRECTIONS].join(", ")}`);
    }
    if (!entry.why) problems.push(`settingsSafeSide.${entry.path}: 'why' must say what the product does with the key absent`);
  }

  const covered = new Set();
  for (const closure of closures) {
    if (!closure.domain) {
      problems.push("settingsSafeSide: a closure has no literal 'domain'");
      continue;
    }
    if (!closure.covers || closure.covers.some((entry) => entry === undefined)) {
      problems.push(`settingsSafeSide closure '${closure.domain}': 'covers' must be an array of literal key paths`);
      continue;
    }
    for (const path of closure.covers) {
      covered.add(path);
      const entry = byPath.get(path);
      if (!entry) problems.push(`settingsSafeSide closure '${closure.domain}': covers unknown key '${path}'`);
      else if (entry.direction !== "opens") {
        problems.push(
          `settingsSafeSide closure '${closure.domain}': covers '${path}', which is declared '${entry.direction}' — ` +
          `a closure that shuts a door nobody said was open is a claim the table does not support`,
        );
      }
    }
    if (!tracked.has(closure.domain)) {
      problems.push(
        `settingsSafeSide closure '${closure.domain}': loadConfig never records this door as warned ` +
        `(no markSettingsWarned("${closure.domain}", …) and no warnedSettingsPaths.add), so the closure can never fire`,
      );
    }
  }

  // The point of the whole guard: a permissive-default key must be closed or its risk written down.
  for (const entry of entries) {
    if (entry.direction !== "opens" || covered.has(entry.path)) continue;
    if (!entry.acceptedRisk) {
      problems.push(
        `settingsSafeSide.${entry.path}: declared 'opens' with no closure covering it and no 'acceptedRisk' — ` +
        `discarding this key widens what the product permits, so either close the door in SETTINGS_DOOR_CLOSURES ` +
        `or write down why no safe value can be installed`,
      );
    }
  }

  const leafSet = new Set(leaves);
  for (const leaf of leaves) {
    const entry = byPath.get(leaf);
    if (!entry) {
      problems.push(
        `TachyonConfig.settings.${leaf} has no row in SETTINGS_KEY_FALLBACKS — say which way the product falls ` +
        `when it is discarded (closes / same / opens) before shipping it`,
      );
    } else if (entry.kind === "ignored") {
      problems.push(`settingsSafeSide.${leaf}: declared 'ignored' but it IS a property of TachyonConfig['settings']`);
    }
  }
  for (const entry of entries) {
    if (entry.kind === "stored" && !leafSet.has(entry.path)) {
      problems.push(`settingsSafeSide.${entry.path}: declared 'stored' but there is no such property on TachyonConfig['settings']`);
    }
  }

  // A key the parser can act on but the table never declared: the exact hole this guard exists for,
  // reachable by adding an `if (raw.settings.newKey …)` branch and nothing else.
  const authoredTopLevel = new Set(
    entries.filter((entry) => entry.kind !== "internal" && entry.path).map((entry) => entry.path.split(".")[0]),
  );
  for (const key of reads) {
    if (!authoredTopLevel.has(key)) {
      problems.push(
        `loadConfig reads raw.settings.${key}, which has no row in SETTINGS_KEY_FALLBACKS — a key the parser acts on ` +
        `must declare its discard direction, or it is not an accepted key at all`,
      );
    }
  }

  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = auditSettingsFallbacks({
    loadConfigText: fs.readFileSync(LOAD_CONFIG, "utf8"),
    safeSideText: fs.readFileSync(SAFE_SIDE, "utf8"),
  });
  if (problems.length > 0) {
    process.stderr.write(`settings fallback declaration is incomplete:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("settings fallback declaration is complete\n");
}
