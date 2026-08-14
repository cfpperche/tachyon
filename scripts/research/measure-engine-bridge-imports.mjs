import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { resolveSource, walk } from "./monorepo-imports.mjs";

/**
 * Reproducible ruler for the engine -> bridge boundary measured in t-69ae46.
 *
 * An edge is one statically named binding imported or re-exported by a TypeScript source outside
 * packages/engine/src/bridge from a source inside that directory. Both relative specifiers and the
 * package's @tachyon/engine/* self-imports count. Type-only bindings count because they still couple
 * the source trees. `imports` counts the matching static import/export declarations, and `consumers`
 * counts distinct source files containing them. Side-effect imports and `export *` declarations
 * therefore count as imports but contribute zero named bindings. Dynamic import(), require(), lexical
 * occurrences, imports internal to bridge, tests, generated files, and docs do not count. Resolution
 * is delegated to monorepo-imports.mjs, the same resolver used by the other graph measurements and
 * boundary checks.
 */

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, "../..");
const engineSourceRoot = path.join(root, "packages", "engine", "src");
const bridgeRoot = path.join(engineSourceRoot, "bridge");
const bridgePrefix = `${bridgeRoot}${path.sep}`;
const files = walk(engineSourceRoot).filter((file) => /\.tsx?$/.test(file)).sort();
const fileSet = new Set(files);
const rows = [];

for (const importer of files) {
  if (importer.startsWith(bridgePrefix)) continue;
  const source = ts.createSourceFile(importer, fs.readFileSync(importer, "utf8"), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (!isStaticImportOrExport(statement)) continue;
    const specifier = statement.moduleSpecifier.text;
    const target = resolveEngineSource(importer, specifier);
    if (!target?.startsWith(bridgePrefix)) continue;
    rows.push({
      importer: relative(importer),
      target: relative(target),
      bindings: bindingCount(statement),
      kind: ts.isImportDeclaration(statement) ? "import" : "re-export",
    });
  }
}

const output = {
  criterion: "named static import/re-export bindings (relative or @tachyon/engine self-import) from engine sources outside bridge to sources inside bridge; type-only bindings count",
  totals: {
    bindings: rows.reduce((sum, row) => sum + row.bindings, 0),
    imports: rows.length,
    consumers: new Set(rows.map((row) => row.importer)).size,
  },
  edges: rows,
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

function isStaticImportOrExport(statement) {
  return (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
    && statement.moduleSpecifier
    && ts.isStringLiteral(statement.moduleSpecifier);
}

function bindingCount(statement) {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause) return 0;
    const defaultBinding = clause.name ? 1 : 0;
    if (!clause.namedBindings) return defaultBinding;
    if (ts.isNamespaceImport(clause.namedBindings)) return defaultBinding + 1;
    return defaultBinding + clause.namedBindings.elements.length;
  }
  if (!statement.exportClause) return 0;
  if (ts.isNamespaceExport(statement.exportClause)) return 1;
  return statement.exportClause.elements.length;
}

function resolveEngineSource(importer, specifier) {
  if (specifier.startsWith(".")) return resolveSource(importer, specifier, fileSet);
  const prefix = "@tachyon/engine/";
  if (!specifier.startsWith(prefix)) return undefined;
  const packageTarget = path.join(engineSourceRoot, specifier.slice(prefix.length));
  let relativeSpecifier = path.relative(path.dirname(importer), packageTarget);
  if (!relativeSpecifier.startsWith(".")) relativeSpecifier = `./${relativeSpecifier}`;
  return resolveSource(importer, relativeSpecifier, fileSet);
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}
