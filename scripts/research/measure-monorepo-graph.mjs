import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  countRelativeSpecifierOccurrences,
  resolveSource,
  resolveWorkspaceSource,
  unresolvedReason,
  visitSpecifiers,
  walk,
} from "./monorepo-imports.mjs";

const root = process.cwd();
const srcRoot = path.join(root, "src");
const sharedRoot = path.join(root, "packages", "shared");
const engineRoot = path.join(root, "packages", "engine");
const webviewUiRoot = path.join(root, "packages", "webview-ui");
const srcFiles = walk(srcRoot).filter((file) => /\.tsx?$/.test(file)).sort();
const packageSharedFiles = walk(path.join(sharedRoot, "src")).filter((file) => /\.tsx?$/.test(file)).sort();
const packageEngineFiles = walk(path.join(engineRoot, "src")).filter((file) => /\.tsx?$/.test(file)).sort();
const packageWebviewUiFiles = walk(path.join(webviewUiRoot, "src")).filter((file) => /\.tsx?$/.test(file)).sort();
const sharedRuntimeFiles = walk(sharedRoot).filter((file) => /\.cjs$/.test(file)).sort();
const files = [...srcFiles, ...packageSharedFiles, ...packageEngineFiles, ...packageWebviewUiFiles, ...sharedRuntimeFiles].sort();
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
    const workspaceTarget = resolveWorkspaceSource(root, specifier, fileSet);
    if (workspaceTarget) bucket.add(workspaceTarget);
    if (specifier.startsWith(".")) {
      const specifierKey = `${file}\0${specifier}`;
      const observedKinds = relativeSpecifiers.get(specifierKey) ?? new Set();
      observedKinds.add(kind);
      relativeSpecifiers.set(specifierKey, observedKinds);
      const resolved = resolveSource(file, specifier, fileSet);
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
const browserEntries = [...webviewBrowser, ...packageWebviewUiFiles]
  .filter((file) => path.basename(file) === "main.tsx");
const browserProgram = forwardClosure(browserEntries, "value");
const browserTypeProgram = forwardClosure(browserEntries, "both");
const engineEntries = ["engineService.ts", "daemonMain.ts"].map((name) => path.join(engineRoot, "src", "engine-service", name));
const engineProgram = forwardClosure(engineEntries, "value");
const engineTypeProgram = forwardClosure(engineEntries, "both");
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
    packageSharedRuntimeFiles: packageSharedFiles.length + sharedRuntimeFiles.length,
    packageEngineSourceFiles: packageEngineFiles.length,
    packageWebviewUiSourceFiles: packageWebviewUiFiles.length,
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
    package: summarize(packageWebviewUiFiles),
    browser: { ...summarize([...browserProgram]), entries: browserEntries.length },
    boundary,
  },
  programs: {
    engine: { ...programSummary(engineProgram), members: [...engineProgram].map(rel).sort() },
    engineTypeAware: { ...programSummary(engineTypeProgram), members: [...engineTypeProgram].map(rel).sort() },
    engineOwnedRuntime: (() => {
      const group = new Set([...engineProgram].filter((file) => packageEngineFiles.includes(file)));
      return { ...programSummary(group), members: [...group].map(rel).sort() };
    })(),
    browser: { ...programSummary(browserProgram), members: [...browserProgram].map(rel).sort() },
    browserTypeAware: { ...programSummary(browserTypeProgram), members: [...browserTypeProgram].map(rel).sort() },
    browserOwnedRuntime: (() => {
      const group = new Set([...browserProgram].filter((file) => packageWebviewUiFiles.includes(file)));
      return { ...programSummary(group), members: [...group].map(rel).sort() };
    })(),
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
