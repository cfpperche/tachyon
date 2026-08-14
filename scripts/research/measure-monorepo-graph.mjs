import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const srcRoot = path.join(root, "src");
const sharedRoot = path.join(root, "shared");
const srcFiles = walk(srcRoot).filter((file) => /\.tsx?$/.test(file)).sort();
const sharedRuntimeFiles = walk(sharedRoot).filter((file) => /\.cjs$/.test(file)).sort();
const files = [...srcFiles, ...sharedRuntimeFiles].sort();
const fileSet = new Set(files);
const nodes = new Map();
const relativeSpecifiers = new Map();
const unresolvedRelative = new Map();
let relativeSpecifierOccurrences = 0;
const rel = (file) => path.relative(root, file).replaceAll(path.sep, "/");

for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  relativeSpecifierOccurrences += countRelativeSpecifierOccurrences(source);
  const value = new Set();
  const type = new Set();
  visitSpecifiers(source, (specifier, kind) => {
    const bucket = kind === "type" ? type : value;
    if (specifier === "vscode") bucket.add("vscode");
    if (specifier.startsWith(".")) {
      const specifierKey = `${file}\0${specifier}`;
      const observedKinds = relativeSpecifiers.get(specifierKey) ?? new Set();
      observedKinds.add(kind);
      relativeSpecifiers.set(specifierKey, observedKinds);
      const resolved = resolveSource(file, specifier);
      if (resolved) bucket.add(resolved);
      else unresolvedRelative.set(specifierKey, {
        importer: rel(file),
        specifier,
        kinds: [...observedKinds].sort(),
        reason: unresolvedReason(file, specifier),
      });
    }
  });
  nodes.set(file, { value, type });
}

const valueCoupled = closureToVscode("value");
const typeAwareCoupled = closureToVscode("both");
const directValue = srcFiles.filter((file) => nodes.get(file).value.has("vscode"));
const directType = srcFiles.filter((file) => nodes.get(file).type.has("vscode"));
const surprising = srcFiles.filter((file) => valueCoupled.has(file) && !nodes.get(file).value.has("vscode"));

const webviewRoot = files.filter((file) => path.dirname(file) === path.join(srcRoot, "webview"));
const webviewBrowser = files.filter((file) => file.startsWith(path.join(srcRoot, "webview") + path.sep)
  && path.dirname(file) !== path.join(srcRoot, "webview"));
const browserEntries = webviewBrowser.filter((file) => path.basename(file) === "main.tsx");
const browserProgram = forwardClosure(browserEntries, "value");
const engineEntries = ["engineService.ts", "daemonMain.ts"].map((name) => path.join(srcRoot, "engine-service", name));
const engineProgram = forwardClosure(engineEntries, "value");
const engineBrowserShared = new Set([...engineProgram].filter((file) => browserProgram.has(file)));
const boundary = [];
for (const importer of [...webviewRoot, ...webviewBrowser]) {
  for (const kind of ["value", "type"]) {
    for (const target of nodes.get(importer)[kind]) {
      if (target === "vscode" || !target.startsWith(path.join(srcRoot, "webview") + path.sep)) continue;
      const importerSide = webviewRoot.includes(importer) ? "host" : "browser";
      const targetSide = webviewRoot.includes(target) ? "host" : "browser";
      if (importerSide !== targetSide) boundary.push({ kind, importer: rel(importer), target: rel(target), direction: `${importerSide}->${targetSide}` });
    }
  }
}

const top = (file) => {
  const parts = rel(file).split("/");
  return parts.length === 2 ? parts[1] : parts[1];
};
const dirs = {};
for (const file of files) {
  const key = top(file);
  const row = dirs[key] ??= { files: 0, portable: 0, coupled: 0, directValue: 0, directType: 0 };
  row.files++;
  if (valueCoupled.has(file)) row.coupled++; else row.portable++;
  if (nodes.get(file).value.has("vscode")) row.directValue++;
  if (nodes.get(file).type.has("vscode")) row.directType++;
}

const cross = {};
for (const file of files) {
  for (const kind of ["value", "type"]) {
    for (const target of nodes.get(file)[kind]) {
      if (target === "vscode" || top(file) === top(target)) continue;
      const key = `${top(file)} -> ${top(target)}`;
      const row = cross[key] ??= { value: 0, type: 0, importers: new Set() };
      row[kind]++;
      row.importers.add(rel(file));
    }
  }
}

const output = {
  generatedAt: new Date().toISOString(),
  git: process.env.MEASURE_GIT ?? "",
  totals: {
    files: files.length,
    srcFiles: srcFiles.length,
    sharedRuntimeFiles: sharedRuntimeFiles.length,
    runtimePortable: files.length - valueCoupled.size,
    runtimeCoupled: valueCoupled.size,
    typeAwareCoupled: typeAwareCoupled.size,
    directValue: directValue.length,
    directType: directType.length,
    surprising: surprising.length,
  },
  resolution: {
    relativeSpecifierOccurrences,
    relativeSpecifiers: relativeSpecifiers.size,
    resolved: relativeSpecifiers.size - unresolvedRelative.size,
    unresolved: unresolvedRelative.size,
    unresolvedEdges: [...unresolvedRelative.values()].sort((a, b) => a.importer.localeCompare(b.importer) || a.specifier.localeCompare(b.specifier)),
  },
  rootShared: {
    runtime: sharedRuntimeFiles.map((file) => ({ file: rel(file), runtime: valueCoupled.has(file) ? "coupled" : "portable" })),
    declarations: walk(sharedRoot).filter((file) => /\.d\.cts$/.test(file)).map(rel).sort(),
    consumers: sharedConsumers(),
    internalEdges: sharedRuntimeFiles.flatMap((importer) => [...nodes.get(importer).value]
      .filter((target) => target !== "vscode" && sharedRuntimeFiles.includes(target))
      .map((target) => ({ importer: rel(importer), target: rel(target), kind: "value" }))),
  },
  webview: {
    host: summarize(webviewRoot),
    physicalSubfolders: summarize(webviewBrowser),
    browser: { ...summarize([...browserProgram]), entries: browserEntries.length },
    boundary,
  },
  programs: {
    engine: { ...programSummary(engineProgram), members: [...engineProgram].map(rel).sort() },
    browser: { ...programSummary(browserProgram), members: [...browserProgram].map(rel).sort() },
    engineBrowserShared: { ...programSummary(engineBrowserShared), members: [...engineBrowserShared].map(rel).sort() },
    outsideEngineAndBrowser: (() => {
      const group = new Set(files.filter((file) => !engineProgram.has(file) && !browserProgram.has(file)));
      return { ...programSummary(group), members: [...group].map(rel).sort() };
    })(),
  },
  directories: Object.fromEntries(Object.entries(dirs).sort(([a], [b]) => a.localeCompare(b))),
  crossDirectoryEdges: Object.fromEntries(Object.entries(cross)
    .sort(([, a], [, b]) => (b.value + b.type) - (a.value + a.type))
    .map(([key, row]) => [key, { value: row.value, type: row.type, importers: row.importers.size }])),
  directValue: directValue.map(rel),
  directType: directType.map(rel),
  surprising: surprising.map(rel),
  classification: srcFiles.map((file) => ({
    file: rel(file),
    runtime: valueCoupled.has(file) ? "coupled" : "portable",
    typeAware: typeAwareCoupled.has(file) ? "coupled" : "portable",
    directVscode: nodes.get(file).value.has("vscode") ? "value" : nodes.get(file).type.has("vscode") ? "type" : "none",
  })),
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

function summarize(group) {
  return {
    files: group.length,
    runtimePortable: group.filter((file) => !valueCoupled.has(file)).length,
    runtimeCoupled: group.filter((file) => valueCoupled.has(file)).length,
    directValue: group.filter((file) => nodes.get(file).value.has("vscode")).length,
    directType: group.filter((file) => nodes.get(file).type.has("vscode")).length,
  };
}

function programSummary(group) {
  const byTopDirectory = {};
  for (const file of group) byTopDirectory[top(file)] = (byTopDirectory[top(file)] ?? 0) + 1;
  return { files: group.size, byTopDirectory: Object.fromEntries(Object.entries(byTopDirectory).sort(([, a], [, b]) => b - a)) };
}

function closureToVscode(mode) {
  const reverse = new Map();
  const coupled = new Set();
  for (const file of files) {
    const edges = mode === "value" ? nodes.get(file).value : new Set([...nodes.get(file).value, ...nodes.get(file).type]);
    for (const target of edges) {
      if (target === "vscode") coupled.add(file);
      else {
        const parents = reverse.get(target) ?? new Set();
        parents.add(file);
        reverse.set(target, parents);
      }
    }
  }
  const queue = [...coupled];
  while (queue.length) {
    const target = queue.shift();
    for (const parent of reverse.get(target) ?? []) {
      if (coupled.has(parent)) continue;
      coupled.add(parent);
      queue.push(parent);
    }
  }
  return coupled;
}

function forwardClosure(entries, mode) {
  const visited = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const edges = mode === "value" ? nodes.get(file).value : new Set([...nodes.get(file).value, ...nodes.get(file).type]);
    for (const target of edges) if (target !== "vscode" && fileSet.has(target)) queue.push(target);
  }
  return visited;
}

function visitSpecifiers(source, emit) {
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.isTypeOnly) emit(node.moduleSpecifier.text, "type");
      else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        const elements = clause.namedBindings.elements;
        const values = elements.filter((element) => !element.isTypeOnly);
        const types = elements.filter((element) => element.isTypeOnly);
        if (values.length || clause.name) emit(node.moduleSpecifier.text, "value");
        if (types.length) emit(node.moduleSpecifier.text, "type");
      } else emit(node.moduleSpecifier.text, "value");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      emit(node.moduleSpecifier.text, node.isTypeOnly ? "type" : "value");
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      emit(node.argument.literal.text, "type");
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        emit(node.arguments[0].text, "value");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function countRelativeSpecifierOccurrences(source) {
  let count = 0;
  const visit = (node) => {
    let specifier;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifier = node.moduleSpecifier.text;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      specifier = node.argument.literal.text;
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      specifier = node.arguments[0].text;
    }
    if (specifier?.startsWith(".")) count++;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function resolveSource(importer, specifier) {
  const raw = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    raw,
    raw.replace(/\.js$/, ".ts"),
    raw.replace(/\.js$/, ".tsx"),
    raw.replace(/\.jsx$/, ".tsx"),
    `${raw}.ts`,
    `${raw}.tsx`,
    path.join(raw, "index.ts"),
    path.join(raw, "index.tsx"),
  ];
  return candidates.find((candidate) => fileSet.has(candidate));
}

function unresolvedReason(importer, specifier) {
  const raw = path.resolve(path.dirname(importer), specifier);
  if (path.extname(raw) === ".json" && fs.existsSync(raw)) return "JSON asset intentionally outside the TS/CJS runtime graph";
  return "no matching TS/TSX/CJS runtime source";
}

function sharedConsumers() {
  const consumers = [];
  for (const scope of ["src", "scripts", "test"]) {
    for (const importer of walk(path.join(root, scope)).filter((file) => /\.(?:[cm]?js|tsx?)$/.test(file))) {
      const source = ts.createSourceFile(importer, fs.readFileSync(importer, "utf8"), ts.ScriptTarget.Latest, true);
      const seen = new Set();
      visitSpecifiers(source, (specifier, kind) => {
        if (!specifier.startsWith(".")) return;
        const target = path.resolve(path.dirname(importer), specifier);
        if (!sharedRuntimeFiles.includes(target)) return;
        const key = `${target}\0${kind}`;
        if (seen.has(key)) return;
        seen.add(key);
        consumers.push({ scope, importer: rel(importer), target: rel(target), kind });
      });
    }
  }
  return consumers.sort((a, b) => a.importer.localeCompare(b.importer) || a.target.localeCompare(b.target));
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
