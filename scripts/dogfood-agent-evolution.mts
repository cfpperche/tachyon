import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeAgentPrompt } from "../src/agents/promptLayers.js";
import { composeCommand, parseConfig, type TachyonConfig } from "../src/config/loadConfig.js";
import { EvolutionCoordinator } from "../src/evolution/EvolutionCoordinator.js";
import { EvolutionStore } from "../src/evolution/EvolutionStore.js";
import { resolveEvolutionStartupSnapshot } from "../src/evolution/startupSnapshot.js";
import { TaskStore } from "../src/tasks/TaskStore.js";

function configOf(runtime: string): TachyonConfig {
  const parsed = parseConfig(`agents:\n  reviewer:\n    cmd: ${runtime}\n    selfEvolution: {enabled: true}\n`);
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.config);
  return parsed.config;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-agent-evolution-dogfood-"));

try {
  let config = configOf("codex");
  const ids = ["profile-fixed", "empty-fixed", "proposal-fixed"];
  let tick = 0;
  const store = new EvolutionStore(root, {
    uuid: () => ids.shift() ?? `unexpected-${tick}`,
    now: () => new Date(Date.UTC(2026, 6, 21, 12, 0, tick++)).toISOString(),
  });
  const notices: string[] = [];
  const coordinator = new EvolutionCoordinator({
    store,
    declaredAgent: (name) => config.agents[name],
    sessionFor: (name) => `tachyon-dogfood-${name}`,
    activitySeq: () => 42,
    deliverNotice: async (_agent, notice) => {
      notices.push(notice);
      return { status: "notified" };
    },
  });
  let observed = Promise.resolve();
  const tasks = new TaskStore(root, {
    onMutation: (event) => {
      observed = observed.then(() => coordinator.onTaskMutation(event));
      return observed;
    },
  });

  const complete = async (id: string, title: string, minute: number): Promise<void> => {
    await tasks.create({ id, title, author: "human", now: `2026-07-21T13:${minute.toString().padStart(2, "0")}:00.000Z` });
    await tasks.update(id, { status: "triaged", assignee: "reviewer", now: `2026-07-21T13:${minute.toString().padStart(2, "0")}:01.000Z` });
    await tasks.update(id, { status: "active", now: `2026-07-21T13:${minute.toString().padStart(2, "0")}:02.000Z` });
    await tasks.update(id, { status: "done", now: `2026-07-21T13:${minute.toString().padStart(2, "0")}:03.000Z` });
    await observed;
  };

  await complete("t-a1b2c3", "No reusable learning", 0);
  const emptyReview = (await store.listReviews("reviewer"))[0]!;
  const empty = await store.submitReview("reviewer", emptyReview.id, []);
  assert.equal(empty.review.status, "no-proposal");
  assert.deepEqual(empty.candidates, []);

  await complete("t-d4e5f6", "Create a reusable repository check", 1);
  const proposalReview = (await store.listReviews("reviewer"))[1]!;
  const currentSession = await resolveEvolutionStartupSnapshot(root, "reviewer", store);
  assert.equal(currentSession.version, 0);
  const submitted = await store.submitReview("reviewer", proposalReview.id, [
    {
      kind: "learning",
      content: "Always retain this rejected sentence.",
      reason: "Dogfood proves rejected learning stays inactive.",
    },
    {
      kind: "skill",
      operation: "create",
      name: "repo-check",
      reason: "Dogfood proves a standard skill can carry a helper tool.",
      files: [
        {
          path: "SKILL.md",
          content: "---\nname: repo-check\ndescription: Run the deterministic repository check helper.\n---\n\nRun `scripts/check.sh` when a compact repository check is useful.\n",
        },
        {
          path: "scripts/check.sh",
          content: "#!/bin/sh\nprintf 'agent-evolution-helper-ok\\n'\nif [ -n \"${TACHYON_EVOLUTION_DOGFOOD_MARKER:-}\" ]; then printf 'agent-evolution-helper-ok\\n' > \"$TACHYON_EVOLUTION_DOGFOOD_MARKER\"; fi\n",
          executable: true,
        },
      ],
    },
  ]);
  assert.equal(submitted.review.status, "submitted");
  assert.equal(submitted.candidates.length, 2);

  const learning = submitted.candidates.find((candidate) => candidate.target.kind === "learning")!;
  const learningDetail = await store.candidateDetail("reviewer", learning.id);
  await store.rejectCandidate("reviewer", learning.id, {
    expectedActiveVersion: learningDetail.activeVersion,
    expectedTargetDigest: learningDetail.currentTargetDigest,
  });
  assert.equal((await store.readProfile("reviewer"))?.activeVersion, 0);

  const skill = submitted.candidates.find((candidate) => candidate.target.kind === "skill")!;
  const skillDetail = await store.candidateDetail("reviewer", skill.id);
  const profileBeforeRuntimeSwitch = await store.readProfile("reviewer");
  await store.approveCandidate("reviewer", skill.id, {
    expectedActiveVersion: skillDetail.activeVersion,
    expectedTargetDigest: skillDetail.currentTargetDigest,
  });

  assert.equal(currentSession.version, 0, "the running session snapshot must stay pinned");
  assert.deepEqual(currentSession.skills, []);
  const nextSession = await resolveEvolutionStartupSnapshot(root, "reviewer", store);
  assert.equal(nextSession.version, 1);
  assert.deepEqual(nextSession.skills.map((entry) => entry.name), ["repo-check"]);
  assert.ok(!nextSession.learnings.body.includes("rejected sentence"));

  const script = path.join(nextSession.skills[0]!.bundlePath, "scripts", "check.sh");
  assert.ok((fs.statSync(script).mode & 0o111) !== 0);
  assert.equal(execFileSync("/bin/sh", [script], { encoding: "utf8" }), "agent-evolution-helper-ok\n");

  const logicalPrompt = composeAgentPrompt({ evolution: nextSession, bridgeGuidance: false }).body!;
  const codexLaunch = composeCommand({ cmd: config.agents.reviewer!.cmd, instructions: logicalPrompt });
  config = configOf("grok");
  const grokSnapshot = await resolveEvolutionStartupSnapshot(root, "reviewer", store);
  const grokPrompt = composeAgentPrompt({ evolution: grokSnapshot, bridgeGuidance: false }).body!;
  const grokLaunch = composeCommand({ cmd: config.agents.reviewer!.cmd, instructions: grokPrompt });
  const profileAfterRuntimeSwitch = await store.readProfile("reviewer");
  assert.equal(grokPrompt, logicalPrompt);
  assert.ok(codexLaunch.includes("repo-check"));
  assert.ok(grokLaunch.includes("repo-check"));
  assert.equal(profileAfterRuntimeSwitch?.profileId, profileBeforeRuntimeSwitch?.profileId);
  assert.equal(profileAfterRuntimeSwitch?.activeVersion, 1);
  assert.equal(notices.length, 2);

  let liveRuntime: string | undefined;
  if (process.env.TACHYON_AGENT_EVOLUTION_LIVE_RUNTIME === "codex") {
    const marker = path.join(root, "runtime-skill-used.txt");
    const finalMessage = path.join(root, "runtime-final-message.txt");
    config = configOf("codex");
    const codexSnapshot = await resolveEvolutionStartupSnapshot(root, "reviewer", store);
    const codexPrompt = composeAgentPrompt({ evolution: codexSnapshot, bridgeGuidance: false }).body!;
    const prompt = [
      codexPrompt,
      "This is the fresh Codex session after the declared runtime switched from Grok to Codex.",
      `Read the approved repo-check SKILL.md at ${codexSnapshot.skills[0]!.skillMdPath}.`,
      "Follow that skill and run its scripts/check.sh helper through your normal read/bash tools.",
      "Reply with exactly EVOLUTION_RUNTIME_OK only after the helper succeeds.",
    ].join("\n\n");
    execFileSync("codex", [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox", "workspace-write",
      "--cd", root,
      "--output-last-message", finalMessage,
      prompt,
    ], {
      encoding: "utf8",
      timeout: 180_000,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, TACHYON_EVOLUTION_DOGFOOD_MARKER: marker },
    });
    const output = fs.readFileSync(finalMessage, "utf8");
    assert.equal(output.trim(), "EVOLUTION_RUNTIME_OK", `fresh Codex did not confirm skill use: ${output}`);
    assert.equal(fs.readFileSync(marker, "utf8"), "agent-evolution-helper-ok\n");
    liveRuntime = "codex";
  }

  console.log(JSON.stringify({
    tasksCompleted: 2,
    reviews: ["no-proposal", "submitted"],
    decisions: ["rejected-learning", "approved-skill"],
    currentSessionVersion: currentSession.version,
    nextSessionVersion: nextSession.version,
    helperOutput: "agent-evolution-helper-ok",
    runtimeSwitch: liveRuntime ? "codex->grok->codex" : "codex->grok",
    profilePreserved: true,
    liveRuntimeSkillUse: liveRuntime ?? "not-requested",
  }, null, 2));
  console.log("agent-evolution dogfood: PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
