// Smoke test for the Orchestrator — verifies scheduling, consensus detection,
// max-rounds termination, and turn persistence WITHOUT hitting a real model.
//
// Run: node packages/core/dist/__tests__/orchestrator.smoke.js

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Blackboard,
  Orchestrator,
  SessionLayout,
  loadGroupConfig,
  type AgentRuntimeLike,
  type LoadedAgentConfig,
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

function makeAgentJson(id: string, name: string) {
  return {
    id,
    name,
    role: name,
    providerId: "fake",
    model: "claude-opus-4-7",
    systemPromptText: `You are ${name}. Be concise.`,
    allowedTools: [],
    disallowedTools: [],
    maxTurns: 2,
  };
}

function makeProvider(): Provider {
  return {
    id: "fake",
    name: "Fake",
    source: "memory",
    env: {
      ANTHROPIC_BASE_URL: "https://example.test",
      ANTHROPIC_AUTH_TOKEN: "sk-fake",
      ANTHROPIC_MODEL: "claude-opus-4-7",
    },
    models: ["claude-opus-4-7"],
  };
}

const tmp = mkdtempSync(join(tmpdir(), "agents-orch-"));
console.log(`tmp root: ${tmp}`);

try {
  // --- Fixture: configs/agents/{recon,vuln,exploit,mod}.json + group.json ---
  const cfgRoot = join(tmp, "configs");
  const agentsCfg = join(cfgRoot, "agents");
  const groupsCfg = join(cfgRoot, "groups");
  mkdirSync(agentsCfg, { recursive: true });
  mkdirSync(groupsCfg, { recursive: true });

  for (const [id, name] of [
    ["recon", "Recon"],
    ["vuln", "Vuln"],
    ["exploit", "Exploit"],
    ["mod", "Moderator"],
  ] as const) {
    writeFileSync(
      join(agentsCfg, `${id}.json`),
      JSON.stringify(makeAgentJson(id, name), null, 2),
      "utf8",
    );
  }

  // --- Layout shared across the three groups ---
  const workspaces = join(tmp, "workspaces");
  mkdirSync(workspaces, { recursive: true });

  const provider = makeProvider();
  const providerResolver = async () => provider;

  // ============================================================
  // Case A: round-robin, max-rounds termination
  // ============================================================
  {
    const groupPath = join(groupsCfg, "rr.json");
    writeFileSync(
      groupPath,
      JSON.stringify(
        {
          id: "rr",
          name: "Round Robin Group",
          agents: ["recon", "vuln", "exploit"],
          mode: "round-robin",
          maxRounds: 5,
          meta: "## Group Background\nNo consensus needed.",
        },
        null,
        2,
      ),
      "utf8",
    );

    const group = await loadGroupConfig(groupPath);
    check("rr: group loaded", group.id === "rr");
    check("rr: 3 agents loaded", group.agents.length === 3);
    check("rr: meta inline kept", group.metaText.includes("Group Background"));

    const layout = new SessionLayout(workspaces, "sess-rr");

    const seen: { round: number; agentId: string; promptStart: string }[] = [];
    const runtimeFactory: RuntimeFactory = ({ agent }) => ({
      run: async ({ prompt }) => {
        // record the prompt start
        seen.push({ round: 0, agentId: agent.id, promptStart: prompt.slice(0, 40) });
        return { text: `Hello from ${agent.id}.` };
      },
    } as AgentRuntimeLike);

    const orch = new Orchestrator({ group, layout, providerResolver, runtimeFactory });
    const events: string[] = [];
    const res = await orch.run({
      initialPrompt: "Investigate the target.",
      onEvent: (e) => events.push(`${e.type}:${e.round ?? ""}:${e.agentId ?? ""}`),
    });

    check("rr: ended by max-rounds", res.reason === "max-rounds");
    check("rr: 5 rounds executed", res.rounds === 5);
    check(
      "rr: order is recon,vuln,exploit,recon,vuln",
      JSON.stringify(res.history.map((h) => h.agentId)) ===
        JSON.stringify(["recon", "vuln", "exploit", "recon", "vuln"]),
    );
    check("rr: emitted run-start", events[0] === "run-start::");
    check("rr: emitted run-finished", events[events.length - 1].startsWith("run-finished:"));

    const bb = new Blackboard(layout);
    const turns = await bb.listTurnFiles();
    check("rr: 5 turn files written", turns.length === 5);
    check(
      "rr: first turn file naming",
      turns[0] === "0001-recon.md" && turns[4] === "0005-vuln.md",
    );
    const reconArea = await bb.readAgentArea("recon");
    check("rr: recon area has both rounds", reconArea.includes("Round 1") && reconArea.includes("Round 4"));
    const meta = await bb.readMeta();
    check("rr: meta written", meta.includes("Group Background"));
  }

  // ============================================================
  // Case B: free mode @-mention scheduling + consensus stop
  // ============================================================
  {
    const groupPath = join(groupsCfg, "free.json");
    writeFileSync(
      groupPath,
      JSON.stringify(
        {
          id: "free",
          name: "Free Group",
          agents: ["recon", "vuln", "exploit"],
          mode: "free",
          maxRounds: 10,
        },
        null,
        2,
      ),
      "utf8",
    );

    const group = await loadGroupConfig(groupPath);
    const layout = new SessionLayout(workspaces, "sess-free");

    // Scripted answers: round 1 recon @vuln, round 2 vuln @exploit,
    // round 3 exploit emits consensus marker.
    const replies = new Map<string, string[]>([
      ["recon", ["Looks suspicious. @vuln your turn."]],
      ["vuln", ["Confirming injection. @exploit go."]],
      ["exploit", ["Done. [CONSENSUS:final] all good."]],
    ]);
    const runtimeFactory: RuntimeFactory = ({ agent }) =>
      ({
        run: async () => ({ text: replies.get(agent.id)!.shift() ?? "(no script)" }),
      }) as AgentRuntimeLike;

    const orch = new Orchestrator({ group, layout, providerResolver, runtimeFactory });
    const res = await orch.run({ initialPrompt: "Talk." });

    check("free: ended by consensus", res.reason === "consensus");
    check("free: consensusAgentId is exploit", res.consensusAgentId === "exploit");
    check(
      "free: order is recon,vuln,exploit",
      JSON.stringify(res.history.map((h) => h.agentId)) ===
        JSON.stringify(["recon", "vuln", "exploit"]),
    );
    check("free: 3 rounds reported", res.rounds === 3);
  }

  // ============================================================
  // Case C: moderator mode picks next speaker
  // ============================================================
  {
    const groupPath = join(groupsCfg, "mod.json");
    writeFileSync(
      groupPath,
      JSON.stringify(
        {
          id: "mod",
          name: "Moderated Group",
          agents: ["mod", "recon", "vuln", "exploit"],
          mode: "moderator",
          moderatorId: "mod",
          maxRounds: 3,
        },
        null,
        2,
      ),
      "utf8",
    );

    const group = await loadGroupConfig(groupPath);
    const layout = new SessionLayout(workspaces, "sess-mod");

    // Moderator script: pick exploit, then vuln, then recon.
    // Speakers reply with simple text. After 3 speakers, max-rounds hits.
    const modPicks = ["exploit", "vuln", "recon"];
    const runtimeFactory: RuntimeFactory = ({ agent }) =>
      ({
        run: async ({ prompt }) => {
          if (agent.id === "mod") {
            // moderator turn — return next pick
            const pick = modPicks.shift() ?? "recon";
            return { text: `${pick}` };
          }
          return { text: `${agent.id} reporting (round prompt: ${prompt.slice(0, 20)}).` };
        },
      }) as AgentRuntimeLike;

    const orch = new Orchestrator({ group, layout, providerResolver, runtimeFactory });
    const res = await orch.run({ initialPrompt: "Begin." });

    check("mod: 3 history entries (mod itself doesn't enter history)", res.rounds === 3);
    check(
      "mod: order driven by moderator picks",
      JSON.stringify(res.history.map((h) => h.agentId)) ===
        JSON.stringify(["exploit", "vuln", "recon"]),
    );
    check("mod: ended by max-rounds (consensus marker absent)", res.reason === "max-rounds");

    // Confirm only non-moderator speakers got turn files written.
    const bb = new Blackboard(layout);
    const turns = await bb.listTurnFiles();
    check("mod: 3 turn files written", turns.length === 3);
    check("mod: no turn file for moderator", !turns.some((n) => n.endsWith("-mod.md")));
  }

  // ============================================================
  // Case D: custom moderatorPicker overrides the default
  // ============================================================
  {
    const groupPath = join(groupsCfg, "mod-custom.json");
    writeFileSync(
      groupPath,
      JSON.stringify(
        {
          id: "modc",
          name: "Custom Moderated",
          agents: ["mod", "recon", "vuln"],
          mode: "moderator",
          moderatorId: "mod",
          maxRounds: 2,
        },
        null,
        2,
      ),
      "utf8",
    );

    const group = await loadGroupConfig(groupPath);
    const layout = new SessionLayout(workspaces, "sess-modc");

    let pickerCalls = 0;
    const runtimeFactory: RuntimeFactory = ({ agent }) =>
      ({ run: async () => ({ text: `${agent.id} ack` }) }) as AgentRuntimeLike;

    const orch = new Orchestrator({
      group,
      layout,
      providerResolver,
      runtimeFactory,
      moderatorPicker: async ({ state }) => {
        pickerCalls++;
        return state.round % 2 === 1 ? "vuln" : "recon";
      },
    });

    const res = await orch.run({ initialPrompt: "Go." });
    check("modc: picker called twice", pickerCalls === 2);
    check(
      "modc: speakers were vuln then recon",
      JSON.stringify(res.history.map((h) => h.agentId)) === JSON.stringify(["vuln", "recon"]),
    );
  }

  console.log(`\n${failures === 0 ? "ALL OK" : `FAILED (${failures})`}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) process.exit(1);
