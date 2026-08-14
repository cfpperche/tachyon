/**
 * t-86e59a — the guard: NO resolution path records a value that asserts an ACTOR.
 *
 * `resolvedBy` used to hold `"vscode"` or `"companion"`, server-side constants naming someone the host
 * has no way to observe. Three doors reach resolution with no human gesture (approvalRequest.ts,
 * invariant (3)), so a human auditing a record read their own name for a decision they never made. The
 * fix was not to close the doors — that is the capability fix, t-5313dc, still open — but to stop
 * claiming what is not proven. `resolvedBy` now names the CHANNEL.
 *
 * This file fails if that regresses, and it guards three different ways to regress, because no single
 * one of them covers the others:
 *
 *  (1) THE VALUE — a declared channel that reads like an actor. Caught by shape assertions below.
 *  (2) A NEW WRITE DOOR — someone wires a fourth door with `resolvedBy: "whatever"`. Caught by the
 *      source enumeration below. The TYPE (`ApprovalResolutionChannel`) already refuses an undeclared
 *      literal at compile time; the enumeration is what catches the cast that talks its way past the
 *      type, and the type is what catches a spelling this scan cannot see. They are deliberately
 *      redundant — a static scan that is the only guard is a guard nobody rechecks.
 *  (3) THE TWO DURABLE PLACES DRIFTING APART — the record and the `.tachyon/approvals.jsonl` ledger
 *      repeat the same claim, which is why the false trail was durable twice. Asserted behaviourally,
 *      through `resolveApproval` itself.
 *
 * What this file does NOT claim: that the doors are closed. They are open, on purpose, and the two
 * characterization tests (approvalResolveSocketReachability, companionPairApprovalReachability) still
 * walk through them end to end. This only proves that walking through one no longer forges a name.
 *
 * WHY THE SYNTAX TREE AND NOT A REGEX (t-45db7d). Enumeration (2) used to scan every line of src/ for
 * `/\bresolvedBy\s*:\s*([^,}]+)/` and call each hit a call site. `resolvedBy:` appears on BOTH sides of
 * this field's life: a door WRITES one, and a view model READING the stored value back to show it puts
 * the same text on the left of the same colon. So `src/humanInbox/model.ts` (t-cede16) projected the
 * already-recorded value onto three rows and turned `main` red, on lines that record nothing. The guard's
 * concern is the WRITE — a resolution must not be attributed to an actor — and reading the field cannot
 * violate it. This is the third time the repository has paid for a static guard comparing TEXT instead of
 * the construction it means: `cxWedgeBehavior.gen.test.ts` matching identifiers inside comments broke
 * `main` twice on 2026-08-06, and docs/project-guidance.md records the `switch`/`case` substring of
 * 2026-08-03. The fix is not an allowlist — forgiving one expression leaves the next differently-written
 * read broken and lets a write that resembles a read through. It is to name the construction:
 *
 *   NET A — THE DOORS. `resolveApproval` is the only function that persists a resolution: both durable
 *   places take their value from `input.resolvedBy` (approvalRequest.ts). So a write is a `resolvedBy`
 *   property in the argument of a call to THAT function, and the callee is matched through the IMPORT of
 *   the resolver module rather than by name — `packages/engine/src/companion/CompanionHttp.ts` calls `ops.resolveApproval`,
 *   a protocol port that persists nothing, and name-matching alone would have re-invented the false
 *   positive this task is fixing. Fails closed: an argument object the source cannot resolve, or a spread
 *   that could smuggle the field in, is a finding rather than a pass.
 *
 *   NET B — HARD-CODED VALUES, everywhere in src/, resolver module included. No property assignment named
 *   `resolvedBy` may take a string or template literal. A read never produces one; a write that invents an
 *   actor always does. This is what still covers a FIFTH door that never calls `resolveApproval` at all,
 *   which is the coverage Net A alone would have dropped, and it replaces the line-regex that used to
 *   police the resolver module.
 *
 * KNOWN RESIDUAL DOORS, reported rather than guarded. A resolver reached through `await import(...)`, or
 * re-exported under another name, is invisible to Net A's import anchor. A `resolvedBy` arriving through
 * an opaque spread is a finding, but one arriving through a spread of a NAMED seam below is accepted —
 * and the seam is asserted to really carry no such field, so the acceptance is measured, not faith.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import {
  APPROVAL_CHANNEL_COMPANION_HTTP,
  APPROVAL_CHANNEL_VSCODE_COMMAND,
  APPROVAL_RESOLUTION_CHANNELS,
  APPROVALS_WITNESS_REL_PATH,
  buildApprovalRequest,
  composeFixedApprovalResponse,
  readApprovalRequest,
  resolveApproval,
  writeApprovalRequest,
} from "@tachyon/engine/bridge/approvalRequest.js";
import { approvalResolutionPorts } from "@tachyon/engine/bridge/approvalResolutionPorts.js";

/** The values the product used to write. They are history in old records, and never legal again. */
const RETIRED_ACTOR_CLAIMS = ["vscode", "companion", "vscode-user", "human", "user"];

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-approval-channel-"));
  roots.push(root);
  return root;
}

const repoRoot = process.cwd();
/** The module that DECLARES the field and persists it. Net A excludes it; Net B does not. */
const RESOLVER_MODULE = "packages/engine/src/bridge/approvalRequest.ts";
/** The only values a write door may name. Identifiers, never literals — that is the whole rule. */
const ALLOWED_CHANNEL_CONSTANTS = ["APPROVAL_CHANNEL_VSCODE_COMMAND", "APPROVAL_CHANNEL_COMPANION_HTTP"];
/**
 * Spreads that may appear in a `resolveApproval` argument without hiding a `resolvedBy`. Accepting one
 * by name is only honest because "the named seams are real" below CALLS it and checks the field is absent.
 */
const SPREAD_SEAMS = new Set(["approvalResolutionPorts"]);

const LITERAL_ACTOR =
  "hands `resolveApproval` a `resolvedBy` that is not one of " +
  `${ALLOWED_CHANNEL_CONSTANTS.join(" / ")}. The field names the CHANNEL a resolution arrived through, ` +
  "never an actor: three doors reach resolution with no human gesture, so a literal here writes a claim " +
  "the host cannot observe into two durable places. Name a constant from APPROVAL_RESOLUTION_CHANNELS.";
const UNRESOLVED_INPUT =
  "calls `resolveApproval` with an argument this guard cannot resolve to an object literal, so it cannot " +
  "say whether a `resolvedBy` is written or what it says. Pass the input inline, or as a `const` in the " +
  "same file, so the write door stays readable.";
const OPAQUE_SPREAD =
  "spreads an expression into `resolveApproval`'s argument that could carry `resolvedBy`, and this guard " +
  `cannot see inside it. Set the field explicitly, or route the spread through a named seam (${[...SPREAD_SEAMS].join(", ")}).`;
const HARD_CODED =
  "assigns a string literal to `resolvedBy`. Reading the field back yields an expression; only a write " +
  "invents a value. Whatever persists this must name a channel constant, never spell one out.";

export interface ResolvedByFinding {
  readonly at: string;
  readonly code: string;
  readonly problem: string;
}
/** Every place a resolution is actually WRITTEN, with the expression that supplies the channel. */
export interface ResolutionWriteDoor {
  readonly at: string;
  readonly value: string;
}

function calleeName(call: ts.CallExpression): string {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return "";
}

function propertyName(prop: ts.ObjectLiteralElementLike): string | undefined {
  const name = prop.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

function firstConstInitializer(sf: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

/**
 * How this file names the resolver, if it imports it at all. A file that never imports it cannot call it,
 * which is exactly what keeps `ops.resolveApproval(...)` — the Companion protocol port, which persists
 * nothing — from being read as a write door.
 */
function resolverBindings(sf: ts.SourceFile): { direct: Set<string>; namespaces: Set<string> } {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    if (!/(^|\/)approvalRequest\.js$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === "resolveApproval") direct.add(element.name.text);
      }
    }
  }
  return { direct, namespaces };
}

function isResolverCall(call: ts.CallExpression, bindings: { direct: Set<string>; namespaces: Set<string> }): boolean {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) return bindings.direct.has(expr.text);
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    return expr.name.text === "resolveApproval" && bindings.namespaces.has(expr.expression.text);
  }
  return false;
}

/**
 * Net A + Net B over one file's syntax tree. `text` is a parameter so a test can inject a defect into a
 * real file's source without writing it to disk.
 */
export function scanResolvedBy(relPath: string, text: string): { doors: ResolutionWriteDoor[]; findings: ResolvedByFinding[] } {
  const doors: ResolutionWriteDoor[] = [];
  const findings: ResolvedByFinding[] = [];
  const sf = ts.createSourceFile(
    relPath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = resolverBindings(sf);
  const where = (node: ts.Node): string => `${relPath}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  const snippet = (node: ts.Node): string => node.getText(sf).replace(/\s+/g, " ").slice(0, 160);

  const judgeDoor = (call: ts.CallExpression): void => {
    let input = call.arguments[0];
    if (input && ts.isIdentifier(input)) input = firstConstInitializer(sf, input.text) ?? input;
    if (!input || !ts.isObjectLiteralExpression(input)) {
      findings.push({ at: where(call), code: snippet(call), problem: UNRESOLVED_INPUT });
      return;
    }
    const property = input.properties.find((p) => propertyName(p) === "resolvedBy");
    if (!property) {
      // No explicit field is legal — the argument is optional and omitting it attributes nothing. But a
      // spread could still be carrying one, so an unreadable spread is reported rather than assumed empty.
      for (const spread of input.properties.filter(ts.isSpreadAssignment)) {
        const seam = ts.isCallExpression(spread.expression) && SPREAD_SEAMS.has(calleeName(spread.expression));
        if (!seam) findings.push({ at: where(spread), code: snippet(spread), problem: OPAQUE_SPREAD });
      }
      return;
    }
    const value = ts.isPropertyAssignment(property) ? property.initializer : undefined;
    // A shorthand `{ resolvedBy }` names a local of that name, never an exported channel constant.
    const named = value && ts.isIdentifier(value) ? value.text : undefined;
    doors.push({ at: where(property), value: value ? snippet(value) : snippet(property) });
    if (!named || !ALLOWED_CHANNEL_CONSTANTS.includes(named)) {
      findings.push({ at: where(property), code: snippet(property), problem: LITERAL_ACTOR });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isResolverCall(node, bindings) && relPath !== RESOLVER_MODULE) judgeDoor(node);
    if (ts.isPropertyAssignment(node) && propertyName(node) === "resolvedBy") {
      const value = node.initializer;
      if (ts.isStringLiteralLike(value) || ts.isTemplateExpression(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
        findings.push({ at: where(node), code: snippet(node), problem: HARD_CODED });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return { doors, findings };
}

/** Every `.ts`/`.tsx` under src/, so a new write door cannot hide in a directory this test predates. */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx")) ? [full] : [];
  });
}

function scanSrc(textOverrides: Record<string, string> = {}): { doors: ResolutionWriteDoor[]; findings: ResolvedByFinding[] } {
  const relatives = new Set([
    ...sourceFiles(path.join(repoRoot, "src")).map((f) => path.relative(repoRoot, f).split(path.sep).join("/")),
    ...sourceFiles(path.join(repoRoot, "packages", "engine", "src")).map((f) => path.relative(repoRoot, f).split(path.sep).join("/")),
    ...Object.keys(textOverrides),
  ]);
  const doors: ResolutionWriteDoor[] = [];
  const findings: ResolvedByFinding[] = [];
  for (const relative of relatives) {
    const text = textOverrides[relative] ?? fs.readFileSync(path.join(repoRoot, relative), "utf8");
    if (!text.includes("resolvedBy") && !text.includes("resolveApproval")) continue;
    const result = scanResolvedBy(relative, text);
    doors.push(...result.doors);
    findings.push(...result.findings);
  }
  return { doors, findings };
}

/** Inject a defect into a real file, asserting the injection LANDED — a no-op edit proves nothing. */
function withInjection(relative: string, from: string, to: string): Record<string, string> {
  const original = fs.readFileSync(path.join(repoRoot, relative), "utf8");
  const injected = original.replace(from, to);
  expect(injected, `injection into ${relative} did not land — the anchor '${from}' is gone`).not.toBe(original);
  return { [relative]: injected };
}

describe("t-86e59a — `resolvedBy` names a channel, never an actor", () => {
  it("every declared channel names a door and cannot be read as a proven actor", () => {
    expect(APPROVAL_RESOLUTION_CHANNELS.length).toBeGreaterThan(0);
    for (const channel of APPROVAL_RESOLUTION_CHANNELS) {
      // The prefix is the whole point: the FIELD is still called `resolvedBy`, so the VALUE has to be
      // what stops a glance from reading it as a person.
      expect(channel, `channel '${channel}' must declare that no actor is attributed`).toMatch(
        /^unattributed:/,
      );
      // Distinguishable from the old values, so history stays legible as "written before we knew".
      expect(RETIRED_ACTOR_CLAIMS, `channel '${channel}' is a retired actor claim`).not.toContain(channel);
      // And not merely prefixed: `unattributed:vscode` would still hand an auditor a bare product name.
      expect(channel.slice("unattributed:".length).length).toBeGreaterThan(0);
    }
    // A regression that "fixes" this test by widening the allowed set is the regression.
    for (const retired of RETIRED_ACTOR_CLAIMS) {
      expect(APPROVAL_RESOLUTION_CHANNELS as readonly string[]).not.toContain(retired);
    }
  });

  /** t-9d76b1 — a finding's file, without the line: the claim is WHICH file holds a door, not where. */
  const doorFile = (at: string): string => at.replace(/:\d+$/, "");

  it("no write door in src/ passes a `resolvedBy` literal — every one names a declared channel constant", () => {
    const live = scanSrc();
    expect(
      live.findings,
      `resolvedBy must name a channel constant, not a literal:\n${live.findings.map((f) => `${f.at} -> ${f.code}\n  ${f.problem}`).join("\n")}`,
    ).toEqual([]);

    // Both known doors are still wired, each naming its own channel — an enumeration that silently
    // matches nothing proves nothing, and one that matched READS would prove the wrong thing.
    //
    // t-9d76b1 — compared by FILE and CHANNEL, with the line only in the failure text. The line number
    // used to be part of the expectation, so any edit ABOVE either door turned `main` red while the
    // guard's own claim still held: this went red at `Workspace.ts:3506 -> :3546` for forty inserted
    // lines in an unrelated lifecycle handler. That is a stale number reporting a deliberate change as
    // a defect — the same shape docs/project-guidance.md records for text-matching guards, and the same
    // correction `uiPatterns.test.ts` already made for its tile count.
    expect(
      live.doors.map((d) => `${doorFile(d.at)} -> ${d.value}`).sort(),
      `write doors found at: ${live.doors.map((d) => `${d.at} -> ${d.value}`).sort().join(", ")}`,
    ).toEqual([
      "packages/engine/src/engine-service/extensionOperationService.ts -> APPROVAL_CHANNEL_VSCODE_COMMAND",
      "packages/engine/src/workspace/Workspace.ts -> APPROVAL_CHANNEL_COMPANION_HTTP",
    ]);
  });

  it("RED at both write doors: an actor injected into either real call site is refused", () => {
    // t-45db7d — a green scan is only evidence if the same scan goes red on the real defect, in the real
    // files, at the real call sites. Both doors, because a guard proven on one is a guard that covers one.
    const door1 = scanSrc(
      withInjection(
        "packages/engine/src/engine-service/extensionOperationService.ts",
        "resolvedBy: APPROVAL_CHANNEL_VSCODE_COMMAND,",
        'resolvedBy: "alguem",',
      ),
    );
    expect(
      door1.findings.map((f) => ({ at: doorFile(f.at), problem: f.problem })),
      `door 1 findings at: ${door1.findings.map((f) => f.at).join(", ")}`,
    ).toEqual([
      { at: "packages/engine/src/engine-service/extensionOperationService.ts", problem: LITERAL_ACTOR },
      { at: "packages/engine/src/engine-service/extensionOperationService.ts", problem: HARD_CODED },
    ]);

    const door2 = scanSrc(
      withInjection(
        "packages/engine/src/workspace/Workspace.ts",
        "resolvedBy: APPROVAL_CHANNEL_COMPANION_HTTP,",
        'resolvedBy: "alguem",',
      ),
    );
    expect(
      door2.findings.map((f) => ({ at: doorFile(f.at), problem: f.problem })),
      `door 2 findings at: ${door2.findings.map((f) => f.at).join(", ")}`,
    ).toEqual([
      { at: "packages/engine/src/workspace/Workspace.ts", problem: LITERAL_ACTOR },
      { at: "packages/engine/src/workspace/Workspace.ts", problem: HARD_CODED },
    ]);

    // A cast is the thing the TYPE cannot stop and this scan exists for.
    const cast = scanSrc(
      withInjection(
        "packages/engine/src/workspace/Workspace.ts",
        "resolvedBy: APPROVAL_CHANNEL_COMPANION_HTTP,",
        'resolvedBy: "alguem" as ApprovalResolutionChannel,',
      ),
    );
    expect(cast.findings.map((f) => f.problem)).toEqual([LITERAL_ACTOR]);
  });

  it("GREEN on reads: projecting the stored value onto a screen is not a write door", () => {
    // The three lines t-cede16 added to the Human Inbox view model, which the old regex called call
    // sites. Asserted against the REAL file, so this cannot pass by describing a shape nobody ships.
    const model = "src/humanInbox/model.ts";
    const live = scanResolvedBy(model, fs.readFileSync(path.join(repoRoot, model), "utf8"));
    expect(live.findings).toEqual([]);
    expect(live.doors).toEqual([]);
    const source = fs.readFileSync(path.join(repoRoot, model), "utf8");
    for (const read of [
      'resolvedBy: approval.resolution.resolvedBy ?? "unattributed"',
      "resolvedBy: approval.cancellation.cancelledBy",
      "resolvedBy: validationResolvedBy(validation)",
    ]) {
      expect(source, `${model} no longer contains the read this test proves is legal: ${read}`).toContain(read);
    }

    const probe = (code: string): string[] => scanResolvedBy("src/probe.ts", code).findings.map((f) => f.problem);
    // Every way a read can be spelled — a fallback, a field, a call, a rename — none of them is a write.
    expect(probe('const row = { resolvedBy: record.resolution.resolvedBy ?? "unattributed" };')).toEqual([]);
    expect(probe("const row = { resolvedBy: record.cancellation.cancelledBy };")).toEqual([]);
    expect(probe("const row = { resolvedBy: channelOf(record) };")).toEqual([]);
    expect(probe("const row = { resolvedBy: record.resolvedBy };")).toEqual([]);
    // Prose about the field, and a type that declares it, are not writes either.
    expect(probe('// never write resolvedBy: "vscode" — it claims an actor\nconst x = 1;')).toEqual([]);
    expect(probe('/** @example resolvedBy: "companion" */\nexport const doc = 1;')).toEqual([]);
    expect(probe("export interface Row { resolvedBy?: string }")).toEqual([]);
    // And the port that merely SHARES the name persists nothing (packages/engine/src/companion/CompanionHttp.ts).
    expect(probe("await ops.resolveApproval(body.id, body.decision);")).toEqual([]);
  });

  it("fails closed where it cannot see: an unreadable input object or spread is a finding, not a pass", () => {
    const withImport = (code: string): string[] =>
      scanResolvedBy("src/probe.ts", `import { resolveApproval } from "../bridge/approvalRequest.js";\n${code}`)
        .findings.map((f) => f.problem);
    expect(withImport("await resolveApproval(input);")).toEqual([UNRESOLVED_INPUT]);
    expect(withImport("await resolveApproval(buildInput());")).toEqual([UNRESOLVED_INPUT]);
    expect(withImport("await resolveApproval({ id, decision, ...somewhereElse });")).toEqual([OPAQUE_SPREAD]);
    expect(withImport("await resolveApproval({ id, decision, resolvedBy });"), "a shorthand names a local, not a channel").toEqual([LITERAL_ACTOR]);
    // A const in the same file IS resolvable, so requiring inline objects is not the rule.
    expect(withImport("const input = { id, resolvedBy: APPROVAL_CHANNEL_VSCODE_COMMAND };\nawait resolveApproval(input);")).toEqual([]);
    // The named seam is accepted; omitting the optional field entirely attributes nothing and is legal.
    expect(withImport("await resolveApproval({ id, decision, ...approvalResolutionPorts(sources) });")).toEqual([]);
    // A namespace import is still the resolver.
    expect(
      scanResolvedBy("src/probe.ts", 'import * as approvals from "../bridge/approvalRequest.js";\napprovals.resolveApproval({ id, resolvedBy: "alguem" });')
        .findings.map((f) => f.problem),
    ).toEqual([LITERAL_ACTOR, HARD_CODED]);
  });

  it("the named spread seam is real, so accepting it by name is measurement and not faith", () => {
    const ports = approvalResolutionPorts({
      listEntries: async () => [],
      deliverNotice: async () => ({ status: "notified" }),
    });
    expect("resolvedBy" in ports, "approvalResolutionPorts is accepted by name only while it carries no resolvedBy").toBe(false);
    expect(Object.keys(ports).sort()).toEqual(["currentSessionOwner", "inject"]);
  });

  it("the resolver module never hard-codes a resolution actor of its own", () => {
    // Net B covers the resolver too — it is excluded from the DOOR enumeration (it declares and plumbs
    // the field) but never from the rule about inventing a value. The old line-regex here read raw text
    // and could be tripped by a doc comment that did not start with `*`; this reads the tree.
    const source = fs.readFileSync(path.join(repoRoot, RESOLVER_MODULE), "utf8");
    expect(scanResolvedBy(RESOLVER_MODULE, source).findings).toEqual([]);
    // RED on the real module: the pass-through replaced by an invented actor.
    const injected = source.replace(
      "...(input.resolvedBy ? { resolvedBy: input.resolvedBy } : {}),",
      '...(input.resolvedBy ? { resolvedBy: "vscode" } : {}),',
    );
    expect(injected, "the resolver's pass-through moved — re-anchor this injection").not.toBe(source);
    expect(scanResolvedBy(RESOLVER_MODULE, injected).findings.map((f) => f.problem)).toEqual([HARD_CODED]);
  });

  it("the injected line never asserts an actor, on any decision or channel — including none", () => {
    const request = buildApprovalRequest({
      requester: "requesteragent",
      session: "tachyon-requesteragent",
      reason: "r",
      proposedAction: "a",
      risk: "k",
      exactPrompt: "p",
      id: "a-eee555",
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    const channels = [...APPROVAL_RESOLUTION_CHANNELS, undefined] as const;
    for (const decision of ["approved", "denied"] as const) {
      for (const channel of channels) {
        const line = composeFixedApprovalResponse(request, decision, channel);
        // The claim that must never come back. `human` may appear ONLY inside the denial below.
        expect(line).not.toContain("[tachyon] human ");
        expect(line).not.toMatch(/\bhuman (approved|denied|resolved|closed)\b/);
        // The state is real and the agent needs it — refusing to state it would be a different dishonesty.
        expect(line).toContain(decision === "approved" ? "is APPROVED" : "is DENIED");
        // The non-provability is stated outright, never softened into "possibly" or "unverified".
        expect(line).toContain("Tachyon cannot prove a human made this decision");
        expect(line).not.toMatch(/\b(possibly|probably|may have|likely)\b/i);
        // An absent channel is declared absent rather than dropped, so silence never reads as certainty.
        expect(line).toContain(channel ? `via channel ${channel}` : "with no channel declared");
        // Single line — the pane parser and the sanitizer envelope both depend on it.
        expect(line).not.toMatch(/[\r\n]/);
      }
    }
  });

  it.each([
    ["door 1 — control-socket named action", APPROVAL_CHANNEL_VSCODE_COMMAND],
    ["door 2 — Companion HTTP", APPROVAL_CHANNEL_COMPANION_HTTP],
  ] as const)("%s: the record and the ledger record the CHANNEL, and record it identically", async (_door, channel) => {
    const workspaceRoot = tempWorkspace();
    const request = buildApprovalRequest({
      requester: "requesteragent",
      session: "tachyon-requesteragent",
      reason: "needs a human to authorize removing a safety guard",
      proposedAction: "remove the guard",
      risk: "high",
      exactPrompt: "may I remove it?",
      id: "a-ddd444",
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    writeApprovalRequest(workspaceRoot, request);

    await resolveApproval({
      workspaceRoot,
      id: "a-ddd444",
      decision: "approved",
      resolvedBy: channel,
      now: "2026-08-05T00:00:01.000Z",
      inject: async () => ({ receipt: "typed" }),
    });

    const record = readApprovalRequest(workspaceRoot, "a-ddd444");
    expect(record.resolution?.resolvedBy).toBe(channel);
    for (const retired of RETIRED_ACTOR_CLAIMS) {
      expect(record.resolution?.resolvedBy).not.toBe(retired);
    }

    // The line stored alongside it is the OPERATIVE claim — the requesting agent reads this one to
    // decide whether to proceed. `resolvedBy` had NO reader in src/ when t-86e59a measured it; since
    // t-cede16 the Human Inbox history projects it onto a screen a human reads, which makes the same
    // rule matter on both. (`packages/engine/src/bridge/approvalRequest.ts:535` still asserts the old "no reader".)
    const line = record.resolution?.injectedText ?? "";
    expect(line).toContain(`approval request a-ddd444 is APPROVED`);
    expect(line).toContain(channel);
    expect(line).toContain("Tachyon cannot prove a human made this decision");
    expect(line).not.toContain("[tachyon] human ");

    // The ledger is the second durable place, and it is why the old trail was false TWICE. It has to
    // carry the same value, and the assertion is on equality with the record rather than on the literal
    // so the two can never be updated apart.
    const witness = fs.readFileSync(path.join(workspaceRoot, APPROVALS_WITNESS_REL_PATH), "utf8");
    const resolvedLine = witness
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { kind: string; by?: string })
      .find((event) => event.kind === "resolved");
    expect(resolvedLine?.by).toBe(record.resolution?.resolvedBy);
  });
});
