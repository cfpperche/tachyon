/**
 * spec 342 dogfood round 2 (#4) — Task Detail fixtures for the dev preview harness. Provenance:
 * `synthetic-edge` — typed against the real TaskDetailVM. `default` covers the round 2 (#3) header-actions
 * move (Open in Studio / Refresh now render in `.td-head`, not floating at the page bottom).
 *
 * `t-5564b4` — the catalog used to hold ONLY `default`: short title, one-line body, one dep, and no
 * artifact refs, attention or journal. Every symptom in the human's report lives in content this fixture
 * did not have, which is why the route could look correct here and be broken on screen. The fixtures
 * below turn that report into something the preview can actually show.
 *
 * The `wsHash` is `b349073a` on purpose, and it is why this route never rendered in the harness at
 * all: `cockpit/main.tsx` accepts a TASK push only when `route.wsHash === vm.wsHash && route.taskId
 * === vm.id` (t-9993cc, so a delayed push cannot repopulate a route you navigated away from). The
 * cockpit fixtures route to `b349073a` while these VMs said `a1b2c3`, so every push was rejected and
 * the panel sat on "Loading task…" forever — including for the original `default` fixture.
 */

import type { TaskDetailVM } from "../../../src/webview/task-detail/messages";
import type { Fixture } from "../routes";

const detailTask: TaskDetailVM = {
  wsHash: "b349073a",
  id: "t-4f2c91",
  tombstone: false,
  task: {
    id: "t-4f2c91",
    title: "Fix KitSelect width parity on the Task Studio fields row",
    body: "Priority KitSelect rendered content-width next to the flexible-width Kind/Assignee inputs.",
    status: "active",
    priority: 1,
    kind: "bug",
    author: "claude",
    assignee: "codex",
    artifact_refs: [{ type: "spec", ref: "342" }],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
  },
  journal: [
    { id: "j-000000000001", ts: "2026-07-03T01:00:00.000Z", author: "codex", text: "Confirmed this stays in the task journal, not on the board card." },
  ],
  deps: [{ id: "t-1a2b3c", title: "Vendor shadcn/Radix components", status: "done", missing: false }],
};

/** The long-content case: every field carries the shape that used to escape the reading column. */
const heavyTask: TaskDetailVM = {
  wsHash: "b349073a",
  id: "t-067540",
  tombstone: false,
  task: {
    id: "t-067540",
    title: "Control Task Detail: refinamento completo de UI/UX e responsividade da rota de detalhe aberta pelo Board",
    body: [
      "A rota de detalhe aberta pelo Board está funcional, porém visualmente quebrada e difícil de ler.",
      "",
      "## O que a captura mostra",
      "",
      "- coluna principal sem largura ou ritmo coerente, com grande área vazia ao redor do conteúdo;",
      "- título longo quebra de forma pesada e perde hierarquia;",
      "- hashes e paths extensos não truncam nem oferecem leitura ou cópia adequada;",
      "- o corpo Markdown fica largo, denso e com hierarquia visual insuficiente.",
      "",
      "### Um bloco de código, que não pode empurrar a página",
      "",
      "```",
      "verified tree 286a1b777ee3f9f5f62005c1c1b1197263012441 --flag=/home/goat/.cache/tachyon/worktrees/b349073a/claude-opus5-4",
      "```",
      "",
      "1. Primeiro item de uma lista ordenada, para conferir o ritmo vertical.",
      "2. Segundo item, com um `trecho inline` no meio da frase.",
      "3. Terceiro item.",
    ].join("\n"),
    status: "active",
    priority: 1,
    kind: "feature",
    author: "codex-canonico",
    assignee: "claude-opus5-4",
    artifact_refs: [
      { type: "commit", ref: "76546c4d9ca35d925485e1800946d8516f0fe8a7" },
      { type: "path", ref: "/home/goat/.cache/tachyon/worktrees/b349073a/claude-opus5-4/src/webview/task-detail/task-detail.css" },
      { type: "sdd", ref: "docs/specs/479-sidebar-agent-card-templates" },
      { type: "url", ref: "https://github.com/architecture-decision-record/architecture-decision-record/blob/main/README.md" },
      { type: "task", ref: "t-50bbd4" },
      { type: "tree", ref: "286a1b777ee3f9f5f62005c1c1b1197263012441" },
    ],
    createdAt: "2026-07-27T21:02:43.401Z",
    updatedAt: "2026-07-27T21:02:51.334Z",
  },
  attention: [
    {
      code: "awaiting_human",
      message: "Esta task aguarda uma decisão humana antes de prosseguir: escolher entre rotear a superfície para a lane publicada ou aposentar a entrada inline obsoleta.",
      ref: "t-e81ec5",
    },
  ],
  journal: [
    // Low-entropy synthetic ids, like `default` above: a random-looking hex id in a long quoted
    // assignment trips the secret scanner's generic-api-key heuristic, and a fixture is not worth
    // teaching anyone to suppress that.
    {
      id: "j-000000000002",
      ts: "2026-07-27T21:05:23.132Z",
      author: "claude",
      text: "A long journal entry, so the entry card has to wrap rather than widen the column.",
    },
    { id: "j-000000000003", ts: "2026-07-27T21:06:00.000Z", author: "codex-canonico", text: "Escopo aceito." },
  ],
  deps: [
    { id: "t-1a2b3c", title: "Vendor shadcn/Radix components", status: "done", missing: false },
    { id: "t-9f9f9f", status: "inbox", missing: true },
  ],
};

/** Narrow-content case: nothing optional present, so the empty states carry the layout alone. */
const sparseTask: TaskDetailVM = {
  wsHash: "b349073a",
  id: "t-000001",
  tombstone: false,
  task: {
    id: "t-000001",
    title: "Short one",
    status: "inbox",
    author: "human",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  },
  journal: [],
  deps: [],
};

/** The task disappeared under an open tab: last-known state must stay readable, not blank. */
const tombstoneTask: TaskDetailVM = {
  ...heavyTask,
  id: "t-067541",
  task: { ...heavyTask.task!, id: "t-067541" },
  tombstone: true,
  attention: [{ code: "corrupt_task", message: "This task file disappeared or became unparseable; showing the last known state.", ref: "t-067540" }],
};

export const taskDetailFixtures: Record<string, Fixture<TaskDetailVM>> = {
  default: { provenance: "synthetic-edge", vm: detailTask },
  // t-5564b4 — the reported breakage, reproducible: long title, long body with a code block,
  // awaiting-human, six artifact refs carrying a sha256 / absolute path / long URL, journal, missing dep.
  heavy: { provenance: "synthetic-edge", vm: heavyTask },
  sparse: { provenance: "synthetic-edge", vm: sparseTask },
  tombstone: { provenance: "synthetic-edge", vm: tombstoneTask },
};
