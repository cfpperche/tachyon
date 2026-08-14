import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AgentManager } from "../../agents/AgentManager.js";
import { readPaneTranscript } from "../../agents/paneTranscript.js";
import { composerProfileFor } from "@tachyon/shared/runtime/composerRegion.js";
import { isEvidencedWorking } from "../../prompts/injectFlow.js";
import { agentSummaryRefusal, composeBoundedAgentNotice, prepareAgentSummary } from "../notifyAgent.js";
import { appendDoorbellEvent, findDoorbellDelivery, readDoorbellEventsFor, READ_NOTICES_MAX } from "../doorbell.js";
import { redactSecrets } from "../../utils/redactSecrets.js";
import { type BridgeDeps, AGENT_NAME, deliverNoticeFallback, fail, lifecycleScopeGuard, limitText, managedEntry, ok, resolveDeclaredActor } from "./shared.js";

export function registerCommunicationIoTools(mcp: McpServer, deps: BridgeDeps): void {

  mcp.registerTool(
    "read_output",
    {
      description:
        "Read another managed entry's terminal output. Live rows return the visible pane by default " +
        "(what a human looking at that entry's terminal sees); pass lines to reach into scrollback. " +
        "Stopped rows return bounded postmortem output when Tachyon retained it in memory, falling back to " +
        "the durable pipe-pane transcript (t-6a6a00, survives kill-session and an extension reload) when " +
        "nothing is retained; otherwise the error distinguishes stopped-without-output from unknown.",
      inputSchema: {
        name: AGENT_NAME,
        lines: z.number().int().min(1).max(10000).optional().describe("how many lines of scrollback to include"),
      },
    },
    async ({ name, lines }) => {
      try {
        const session = deps.manager.session(name);
        const info = await managedEntry(deps, name);
        if (await deps.tmux.hasSession(session)) {
          if (info?.dead) {
            const output = redactSecrets(await deps.tmux.capturePane(session, lines ?? AgentManager.POSTMORTEM_MAX_LINES), deps.knownSecrets?.());
            const limited = limitText(output, lines ?? AgentManager.POSTMORTEM_MAX_LINES, AgentManager.POSTMORTEM_MAX_BYTES);
            return ok(JSON.stringify({ output: limited.output, postmortem: true, truncated: limited.truncated, source: "tmux", maxLines: limited.maxLines, maxBytes: limited.maxBytes }, null, 2));
          }
          // Live read_output: join soft wraps so consumers see logical lines (t-24e0f8).
          const output = redactSecrets(
            await deps.tmux.capturePane(session, { lines, joinWrapped: true }),
            deps.knownSecrets?.(),
          );
          return ok(output);
        }
        if (!info) return fail(new Error(`agent '${name}' not found`));
        const retained = deps.manager.postmortemTail(name, lines);
        if (retained) {
          return ok(
            JSON.stringify(
              { output: retained.text, postmortem: true, truncated: retained.truncated, source: "retained", maxLines: retained.maxLines, maxBytes: retained.maxBytes },
              null,
              2,
            ),
          );
        }
        // t-6a6a00 — no live session and nothing retained in memory: the durable pipe-pane transcript
        // survives both kill-session and an extension reload, unlike the in-memory postmortem cache.
        const durable = readPaneTranscript(deps.workspaceRoot, name, {
          knownSecrets: deps.knownSecrets?.(),
          maxLines: lines ?? AgentManager.POSTMORTEM_MAX_LINES,
          maxBytes: AgentManager.POSTMORTEM_MAX_BYTES,
        });
        if (durable) {
          return ok(
            JSON.stringify(
              { output: durable.text, postmortem: true, truncated: durable.truncated, source: "durable", maxLines: durable.maxLines, maxBytes: durable.maxBytes },
              null,
              2,
            ),
          );
        }
        return fail(new Error(`agent '${name}' is stopped and no postmortem output is available`));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "write_input",
    {
      description:
        "Type into another managed entry's terminal. Text is sent literally. submit=true (default) routes " +
        "through the same hardened submit path notify_agent uses and is REFUSED with a structured error " +
        "(receipt: refused-busy) if the recipient is working/throttled — write_input is a direct command " +
        "gesture, so a busy recipient is never queued silently; use notify_agent or wait for idle instead. " +
        "Also REFUSED (receipt: refused-not-ready, t-f87651) while a Codex-class agent is still bootstrapping " +
        "(runtime not ready) — except an explicit answering=true response that exactly matches a measured " +
        "Codex bootstrap screen and its closed input grammar (receipt: answered-bootstrap). A spawn receipt " +
        "is not proof the first contract landed; otherwise wait for ready or persist the contract to the task " +
        "journal and notify a short pointer after ready. Measured hook screens use submit=false with one literal " +
        "key (`t` or U+001B/Escape); ordinary raw pre-ready input remains refused. " +
        "A non-empty runtime composer draft is refused with receipt: refused-composer unless answering=true " +
        "and the recipient is needs-input. " +
        "needs-input is ALLOWED (t-8605be): that state means the recipient is blocked on an interactive prompt, " +
        "and answering it is write_input's most legitimate use — set answering=true to document that intent and " +
        "get a receipt: answered-prompt back. submit=false only types the text with no Enter — raw, unsubmitted " +
        "keystrokes can land in or concatenate with whatever the recipient's composer already holds, so the " +
        "caller should know the recipient's state. " +
        "GOVERNANCE (t-bec361/t-b5f896): as an agent you may type into only yourself, an agent below you in your own " +
        "lineage, or a Saved Agent you own in the roster — typing into someone else's terminal is a command gesture, not a message. To reach a sibling, " +
        "a parent or any other agent, use notify_agent, which is not lineage-scoped.",
      inputSchema: {
        name: AGENT_NAME,
        text: z.string().describe("text to type into the agent's terminal"),
        submit: z.boolean().default(true).describe("press Enter after the text"),
        answering: z
          .boolean()
          .optional()
          .describe("set true when this text answers the recipient's needs-input or measured bootstrap prompt — documents intent and yields an answer receipt"),
      },
    },
    async ({ name, text, submit, answering }) => {
      try {
        const denied = lifecycleScopeGuard(deps, "write_input", name);
        if (denied) return fail(new Error(denied));
        const session = deps.manager.session(name);
        if (!(await deps.tmux.hasSession(session))) {
          return fail(new Error(`agent '${name}' is not running`));
        }
        // t-f87651 — first-contract bootstrap gate: spawn/restart success and tmux submit receipts
        // are not proof the runtime has finished booting. SDD 370 admits only an explicit answer
        // matching a measured Codex bootstrap screen; arbitrary text still cannot cross this gate.
        if (deps.manager.kindOf(name) === "agent" && !(await deps.manager.isReady(name))) {
          const bootstrap = answering ? await deps.manager.matchBootstrapInput(name, text, submit) : undefined;
          if (bootstrap) {
            if (bootstrap.delivery === "literal-key") {
              await deps.tmux.sendKeys(session, text, false);
            } else if (typeof deps.tmux.sendSubmittedLine === "function") {
              await deps.tmux.sendSubmittedLine(session, text);
            } else {
              await deps.tmux.sendKeys(session, text, true);
            }
            return ok(`bootstrap input delivered to '${name}' (receipt: answered-bootstrap; prompt: ${bootstrap.kind})`);
          }
          return fail(
            new Error(
              `recipient '${name}' is still bootstrapping (runtime not ready) — refused-not-ready: wait for the runtime prompt, or persist the contract to the task journal and notify a short pointer after ready`,
            ),
          );
        }
        if (!submit) {
          await deps.tmux.sendKeys(session, text, false);
          return ok(`input typed into '${name}' without submitting (receipt: typed-unsubmitted)`);
        }
        // t-12ec8a — same busy gate as notify_agent's queue check, but write_input REFUSES instead of
        // queueing: it is a direct command gesture, so silently changing when it lands would be worse
        // than today's blind paste (spec 348). Untracked (`undefined`) is treated as safe, matching
        // Workspace.deliverNotice's own idle/untracked branch.
        // t-8605be — needs-input dropped from this gate: it's the recipient waiting on a prompt, and
        // answering it is the legitimate case 348 over-restricted (a parent answering its child's
        // AskUserQuestion was itself refused, with notify_agent ALSO refusing needs-input per 341 —
        // the child became unreachable by any agent). working/throttled still refuse outright.
        const state = deps.attentionOf?.(name);
        const evidencedWorking = isEvidencedWorking(state, deps.hasStartedTurn?.(name));
        if (evidencedWorking || state === "throttled") {
          return fail(new Error(`recipient '${name}' is busy (${state}) — refused-busy: use notify_agent or wait for idle`));
        }
        // t-a53dd9 — write_input is the OTHER door onto the same pane, and it was reading the same
        // stale poll that let a notice land on top of the owner's half-typed message. It keeps
        // refusing rather than queueing (a direct command gesture must not silently change when it
        // lands), but it now refuses on what the pane says now.
        const composerOccupied = (await deps.composerDraftNow?.(name)) ?? deps.composerOccupiedOf?.(name);
        if (composerOccupied && !(answering && state === "needs-input")) {
          return fail(new Error(`recipient '${name}' has a non-empty composer draft — refused-composer: use notify_agent or wait for the composer to clear`));
        }
        if (typeof deps.tmux.sendSubmittedLine === "function") {
          const receipt = await deps.tmux.sendSubmittedLine(session, text, {
            composer: composerProfileFor(deps.manager.defOf(name)?.cmd),
          });
          // t-8d190f — the text is in the recipient's composer but Tachyon never saw it leave. Say so
          // and name the way out, instead of returning a `submitted` receipt the pane contradicts.
          if (receipt.status === "submit-unconfirmed") {
            return ok(
              `input typed into '${name}' but submission was NOT confirmed after ${receipt.attempts} Enter attempt(s) ` +
                `(receipt: submit-unconfirmed; reason: ${receipt.reason}) — the text may be staged in the composer ` +
                `unsent; check with read_output and re-send if it is still there`,
            );
          }
        } else {
          await deps.tmux.sendKeys(session, text, true);
        }
        if (answering && state === "needs-input") {
          return ok(`input submitted to '${name}' (receipt: answered-prompt)`);
        }
        return ok(`input submitted to '${name}' (receipt: submitted)`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "notify_agent",
    {
      description:
        "Wake another agent with a one-line message — the completion signal for delegation " +
        '(call notify_agent(to: "<parent>", summary: ...) when a delegated task is done — the spawn brief ' +
        "already teaches this to a child spawned with parent set), or any agent→agent nudge by name (parent, " +
        "sibling, anyone in the fleet). NOT a chat channel: it types ONE sanitized, single-line, provenance-" +
        "prefixed message into the recipient's terminal and submits it when the recipient appears idle — a waiting agent " +
        "only wakes on input that starts a turn. Busy recipients may be queued until idle. Also REFUSED " +
        "(receipt: refused-not-ready, t-f87651) while the recipient is still bootstrapping (runtime not ready). " +
        "Targets must be running AGENTS " +
        "(not terminals) and not yourself. Best-effort pane input, not durable history. " +
        "A recipient whose composer holds a human draft is HELD, not written over (t-a53dd9, receipt: held-human-draft): " +
        "the check is taken against the pane at the moment of delivery, not from the attention poll, and the notice is " +
        "delivered when the draft clears — or expires with the loss reported to the human. Two residues remain, both " +
        "measured rather than assumed: a keystroke landing between that read and the write is still possible (tmux has no " +
        "compare-and-write), and a runtime with no declared composer region offers no draft signal at all, so for those " +
        "the delivery is as unguarded as it ever was — see docs/runtimes/parity.md for which runtimes those are.",
      inputSchema: {
        to: AGENT_NAME.describe("the recipient agent's name"),
        summary: z.string().min(1).max(4000).describe(
          "one-line completion/status message, at most 500 chars after sanitizing. OVER THAT IT IS REFUSED, "
            + "never truncated: write the detail where it survives (append_task_note / attach_evidence) and send a "
            + "short summary instead. A completion should carry task id, state, commit/tree or blocker, and `pointer`.",
        ),
        pointer: z.string().min(1).max(200).optional().describe(
          "durable record holding the full detail — a task id (t-abc123), an artifact ref or a path. Appended to the "
            + "delivered line and stored with the notice, so the recipient can open it from Attention/Activity "
            + "instead of reading your pane.",
        ),
        deliveryId: z.string().min(1).max(128).optional().describe(
          "caller-minted stable identity for this logical notice. Generate it BEFORE the first call and reuse the "
            + "same value after a timeout or closed socket. The Bridge then returns the first durable receipt "
            + "without appending or delivering the notice twice. A reused id with different content is refused.",
        ),
        // t-bec361 — this used to say, unconditionally, that the name is "self-declared, NOT verified by
        // the Bridge (auth is one shared token; the Bridge cannot tell callers apart)". That describes ONE
        // configuration (settings.auth: false, where there is no bearer to resolve at all); with auth on —
        // the default — spec 351 mints a per-agent token and resolves it before any fallback. Stated as
        // fact, the old sentence talked a reader out of checking, and did exactly that to the agent that
        // wrote this task.
        agent: AGENT_NAME.describe(
          "YOUR agent name — resolved against the Bridge-authenticated caller, not trusted verbatim: with auth ON " +
            "(the default) your own per-agent token identifies you, and declaring a different agent's name is refused " +
            "as caller_mismatch. Only on a workspace running settings.auth: false is there no identity to resolve, and " +
            "there the name passes through unverified. It's the value of your $TACHYON_AGENT_NAME env var; never guess it.",
        ),
      },
    },
    async ({ to, summary, agent, pointer, deliveryId }) => {
      try {
        // spec 351 — resolved caller wins for the sender identity (closes t-d7b3a9's "a reviewer
        // self-naming 'codex'" damage: the "From" line is now the AUTHENTICATED sender, not self-declared).
        const senderActor = resolveDeclaredActor(deps, agent);
        if (!senderActor.ok) return fail(new Error(senderActor.message));
        agent = senderActor.name ?? agent;
        if (to === agent) return fail(new Error("cannot notify_agent yourself — self-notify is rejected"));
        // t-3cccef — the runtime can lose the HTTP response after this handler committed its effect.
        // A caller-generated identity closes that ambiguity: its retry observes the durable append and
        // never re-enters the pane-delivery path. Check before current target liveness so a retry still
        // converges when the recipient was dismissed after accepting the first call.
        if (deliveryId) {
          const prior = findDoorbellDelivery(deps.workspaceRoot, agent, deliveryId);
          if (prior) {
            if (prior.to !== to || prior.summary !== summary || prior.pointer !== pointer) {
              return fail(new Error(`deliveryId '${deliveryId}' was already used for different notify_agent content`));
            }
            return ok(`notice '${deliveryId}' was already durably accepted at ${prior.at} (receipt: already-accepted)`);
          }
        }
        if (deps.manager.kindOf(to) !== "agent") {
          return fail(new Error(`'${to}' is not an agent — notify_agent targets running agents only, not terminals`));
        }
        // t-f87651 — bootstrap gate BEFORE the doorbell: a parent→child first-contract notify while
        // the child is still launching must not count as a witnessed doorbell and must not report
        // notified. Session existence alone is not readiness.
        const session = deps.manager.session(to);
        let sessionAlive: boolean;
        try {
          sessionAlive = await deps.tmux.hasSession(session);
        } catch (err) {
          // A resolved agent that reached notify_agent is still witnessed when the hangable
          // preflight itself fails (for example, tmux timing out while checking the session).
          appendDoorbellEvent(deps.workspaceRoot, { from: agent, to, at: new Date().toISOString(), summary, pointer, deliveryId });
          throw err;
        }
        if (!sessionAlive) {
          // Still witness doorbell for a child→parent attempt at a not-running parent? Spec 363/t-5f80c6
          // wants the ring when static checks pass and only hangable preflight fails. Ghost targets
          // are not kind:agent in our roster unless declared — keep prior path for unknown names:
          // only append when we would have reached the hangable preflight with a resolved agent.
          appendDoorbellEvent(deps.workspaceRoot, { from: agent, to, at: new Date().toISOString(), summary, pointer, deliveryId });
          return fail(new Error(`agent '${to}' is not running`));
        }
        if (!(await deps.manager.isReady(to))) {
          return fail(
            new Error(
              `agent '${to}' is still bootstrapping (runtime not ready) — refused-not-ready: wait for the runtime prompt, then retry (or use a short journal-pointer notify after ready)`,
            ),
          );
        }
        // spec 363 T1 / t-5f80c6 — witness the doorbell after readiness so a bootstrap refuse does not
        // inflate doorbell counts; a child that reached a ready parent still gets credit before any
        // later hangable delivery failure.
        // spec 493 — carry the content, not just from/to/at: this witness record is now also the
        // durable read door (`read_notices`), so a recipient that never opens the one drain window
        // (the working→idle attention edge) can still read what rang for it afterward.
        appendDoorbellEvent(deps.workspaceRoot, { from: agent, to, at: new Date().toISOString(), summary, pointer, deliveryId });
        if (!prepareAgentSummary(summary)) {
          return fail(new Error("summary must not be empty after sanitizing"));
        }
        // t-b15872 — refuse rather than truncate. The doorbell above is already witnessed, so a
        // sender that rewrites and retries is not penalised for having been too verbose once.
        const tooLong = agentSummaryRefusal(summary);
        if (tooLong) return fail(new Error(tooLong));
        // t-9552f3 — after a witnessed, non-empty completion doorbell: latch sender so attention/backstop
        // stop treating a finished turn with an open pane as active "working" work.
        deps.markCompletionHint?.(agent);
        const line = composeBoundedAgentNotice(agent, to, summary, pointer);
        const result = deps.deliverNotice
          ? await deps.deliverNotice(to, line, deps.authoredNoticeMetadata?.(agent))
          : await deliverNoticeFallback(deps, session, line, to);
        const suffix = result.dropped ? ` (${result.dropped} older notice${result.dropped === 1 ? "" : "s"} dropped)` : "";
        // t-44ae02 — depth + oldest age are the only numbers a still-working sender can see.
        // The receipt is the channel; do not write into their pane mid-turn.
        const queueHint = formatQueuedReceiptHint(result);
        // t-8d190f — never report a delivery that was not observed. The doorbell stays actionable:
        // the sender is told the line is staged unsent and how to check, rather than being told it
        // landed and finding out later that the recipient never took a turn.
        if (result.status === "submit-unconfirmed") {
          return ok(
            `typed '${to}' but submission was NOT confirmed (receipt: submit-unconfirmed; reason: ${result.submitReason ?? "unknown"})${suffix}` +
              ` — the notice may be staged in their composer unsent; verify with read_output('${to}') and re-send if it is still there`,
          );
        }
        if (result.status === "queued") {
          // t-a53dd9 — name the human when the human is the reason. This wait ends on a person, not
          // on a turn, so the sender is told what it is waiting for and what happens if it never
          // clears; the alternative is the silent variant of this bug, where the doorbell simply
          // never arrives and nothing anywhere says so.
          return ok(
            result.heldFor === "human-draft"
              ? `queued '${to}'${queueHint}: a human is typing in that pane — the notice is held (receipt: held-human-draft) and delivered when the draft clears, or it expires and the loss is reported to the human${suffix}`
              // spec 493 — this used to promise only "for idle delivery", which is exactly the promise
              // that doesn't hold for a coordinator that rarely goes idle (t-167b5c: ten of ten arrived
              // after the recipient had already acted on the fact some other way). The summary is now
              // durably recorded regardless of whether the pane flush ever lands.
              : `queued '${to}' for idle delivery${queueHint}${suffix} — durably recorded; '${to}' can read it with read_notices even if the pane delivery never lands or lands late`,
          );
        }
        return ok(`notified '${to}'${suffix}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "read_notices",
    {
      description:
        "spec 493 — read the durable record of notify_agent doorbells rung FOR you, independent of whether the pane " +
        "delivery ever landed. `notify_agent`'s one drain window is your working→idle attention edge; a coordinator " +
        "that stays busy (or that restarted since the notice rang) never opens it and would otherwise never know a " +
        "doorbell rang. This reads `.tachyon/doorbells.jsonl`, which witnesses every notify_agent call regardless of " +
        "delivery outcome — self-only (no parameter can target another agent's notices), oldest-first, capped at " +
        `${READ_NOTICES_MAX} per call. Pass the highest \`at\` you've already seen as \`since\` to page forward — ` +
        "there is no server-side read-receipt; you own the cursor. Out of scope (unchanged, still best-effort/in-" +
        "memory-only): Tachyon's own backstop pokes (child-death, needs-input, rate-limited, auth-required) are " +
        "claims about live state and are deliberately NOT witnessed here — durably replaying one after the child it " +
        "describes is gone would be wrong, not just incomplete.",
      inputSchema: {
        agent: AGENT_NAME.describe(
          "YOUR agent name — resolved against the Bridge-authenticated caller, same as notify_agent's `agent` param. " +
            "It's the value of your $TACHYON_AGENT_NAME env var; never guess it.",
        ),
        since: z.string().min(1).max(64).optional().describe(
          "ISO 8601 timestamp cursor — only notices strictly AFTER this `at` are returned. Omit to start from the " +
            `oldest matching notice (capped at ${READ_NOTICES_MAX}; \`truncated\` says if more remain). Use the ` +
            "highest `at` from a previous call as `since` to page forward without re-reading old notices.",
        ),
      },
    },
    async ({ agent, since }) => {
      try {
        const senderActor = resolveDeclaredActor(deps, agent);
        if (!senderActor.ok) return fail(new Error(senderActor.message));
        agent = senderActor.name ?? agent;
        const result = readDoorbellEventsFor(deps.workspaceRoot, agent, since);
        return ok(JSON.stringify({
          notices: result.notices.map(({ from, at, summary, pointer }) => ({ from, at, summary, pointer })),
          returned: result.returned,
          truncated: result.truncated,
        }));
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/** t-44ae02 — mid-turn sender hint: how deep the wait already is, and how old the oldest item is. */
function formatQueuedReceiptHint(
  result: { queued?: number; oldestCreatedAt?: number },
  now = Date.now(),
): string {
  const parts: string[] = [];
  if (typeof result.queued === "number") parts.push(`depth ${result.queued}`);
  if (typeof result.oldestCreatedAt === "number") {
    parts.push(`oldest ${formatQueuedReceiptAge(now - result.oldestCreatedAt)}`);
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function formatQueuedReceiptAge(ageMs: number): string {
  const ms = Math.max(0, ageMs);
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
