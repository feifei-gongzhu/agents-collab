// Smoke test for session persistence + resume.
//
// Run: node packages/core/dist/__tests__/resume.smoke.js

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Orchestrator,
  SessionLayout,
  SessionStore,
  loadGroupConfig,
  type AgentRuntimeLike,
  type Provider,
  type RuntimeFactory,
} from "../index.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeAgent(id: string, name: string) {
  return {
    id,
    name,
    role: name,
    providerId: "fake",
    model: "claude-opus-4-7",
    systemPromptText: `You are ${name}.`,
    allowedTools: [],
    disallowedTools: [],
    maxTurns: 2,
  };
}

const tmp = mkdtempSync(join(tmpdir(), "agents-resume-"));
console.log(`tmp root: ${tmp}`);

try {
  const cfgRoot = join(tmp, "configs");
  const agentsCfg = join(cfgRoot, "agents");
  const groupsCfg = join(cfgRoot, "groups");
  mkdirSync(agentsCfg, { recursive: true });
  mkdirSync(groupsCfg, { recursive: true });
  for (const [id, name] of [
    ["recon", "Recon"],
    ["vuln", "Vuln"],
    ["exploit", "Exploit"],
  ] as const) {
    writeFileSync(
      join(agentsCfg, `${id}.json`),
      JSON.stringify(makeAgent(id, name), null, 2),
      "utf8",
    );
  }
  const groupPath = join(groupsCfg, "team.json");
  writeFileSync(
    groupPath,
    JSON.stringify(
      {
        id: "team",
        name: "Team",
        agents: ["recon", "vuln", "exploit"],
        mode: "round-robin",
        maxRounds: 6,
      },
      null,
      2,
    ),
    "utf8",
  );

  const workspaces = join(tmp, "workspaces");
  mkdirSync(workspaces, { recursive: true });

  const provider: Provider = {
    id: "fake",
    name: "Fake",
    source: "memory",
    env: { ANTHROPIC_BASE_URL: "https://x", ANTHROPIC_AUTH_TOKEN: "k" },
    models: ["claude-opus-4-7"],
  };
  const providerResolver = async () => provider;

  // Counter we can inspect to be sure resume didn't re-run earlier rounds.
  let totalRunInvocations = 0;
  const factory = (label: string): RuntimeFactory =>
    ({ agent }) =>
      ({
        run: async () => {
          totalRunInvocations++;
          return { text: `${label}:${agent.id}` };
        },
      }) as AgentRuntimeLike;

  const sid = "sess-resume";
  const layout = new SessionLayout(workspaces, sid);
  const group = await loadGroupConfig(groupPath);

  // ---- Phase 1: run only 2 rounds by aborting the signal --------------------
  // We use maxRoundsOverride=2 to "stop" cleanly after 2 rounds, simulating an
  // intentional pause. This exercises the persist-each-round path.
  const orch1 = new Orchestrator({
    group,
    layout,
    providerResolver,
    runtimeFactory: factory("p1"),
    maxRoundsOverride: 2,
  });
  const r1 = await orch1.run({ initialPrompt: "Investigate the target." });

  check("phase1: 2 rounds ran", r1.rounds === 2);
  check("phase1: ended by max-rounds (intentional pause)", r1.reason === "max-rounds");
  check("phase1: invocation count == 2", totalRunInvocations === 2);

  const store = new SessionStore(layout);
  check("session.json exists after phase1", store.exists());

  const rec1 = await store.read();
  check("phase1: schemaVersion 1", rec1.schemaVersion === 1);
  check("phase1: groupId team", rec1.groupId === "team");
  check("phase1: status finished", rec1.status === "finished");
  check("phase1: history has 2 rows", rec1.history.length === 2);
  check(
    "phase1: history rows match",
    rec1.history[0].agentId === "recon" && rec1.history[1].agentId === "vuln",
  );
  check("phase1: lastSpeakerId = vuln", rec1.lastSpeakerId === "vuln");
  check("phase1: maxRounds reflected (override)", rec1.maxRounds === 2);

  // ---- Phase 2: resume with the original maxRounds=6 -----------------------
  // We have to mutate the disk record because it stored "finished"; in a real
  // pause-resume flow the orchestrator would write status="paused". For now we
  // toggle status manually to mimic resume semantics, then verify the run
  // continues from round 3.
  const patched = { ...rec1, status: "running" as const, finishReason: undefined };
  await store.write(patched);

  const orch2 = new Orchestrator({
    group,
    layout,
    providerResolver,
    runtimeFactory: factory("p2"),
  });
  const before = totalRunInvocations;
  const r2 = await orch2.run({
    initialPrompt: "Investigate the target.",
    resumeFrom: patched,
  });
  const phase2Calls = totalRunInvocations - before;

  check("phase2: continued for 4 more rounds (3..6)", r2.rounds === 6);
  check("phase2: only 4 new model invocations", phase2Calls === 4);
  check("phase2: reason max-rounds", r2.reason === "max-rounds");
  check(
    "phase2: order continues recon,vuln,exploit,recon,vuln,exploit",
    JSON.stringify(r2.history.map((h) => h.agentId)) ===
      JSON.stringify(["recon", "vuln", "exploit", "recon", "vuln", "exploit"]),
  );

  const rec2 = await store.read();
  check("phase2: history persisted (6)", rec2.history.length === 6);
  check("phase2: nextRound is 7 after finish (6 done)", rec2.nextRound === 7);
  check("phase2: status finished", rec2.status === "finished");

  // ---- Phase 3: resume an already-finished record is a no-op --------------
  const orch3 = new Orchestrator({
    group,
    layout,
    providerResolver,
    runtimeFactory: factory("p3"),
  });
  const before3 = totalRunInvocations;
  const r3 = await orch3.run({
    initialPrompt: "Investigate the target.",
    resumeFrom: rec2,
  });
  check("phase3: zero new invocations on finished resume", totalRunInvocations === before3);
  check("phase3: history reported (6)", r3.rounds === 6);

  // ---- Phase 4: group id mismatch should reject ----------------------------
  let threw = false;
  const badRec = { ...rec2, groupId: "different" };
  try {
    await new Orchestrator({
      group,
      layout,
      providerResolver,
      runtimeFactory: factory("p4"),
    }).run({ initialPrompt: "x", resumeFrom: badRec });
  } catch (err) {
    threw = (err as Error).message.includes("session.json group");
  }
  check("phase4: groupId mismatch rejected", threw);

  console.log(`\n${failures === 0 ? "ALL OK" : `FAILED (${failures})`}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) process.exit(1);
