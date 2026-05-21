// Smoke test for AgentRuntime — verifies config loading, system-prompt
// layering, env merging, and the canUseTool permission bridge WITHOUT hitting
// a real model. Uses runtime.buildOptions() and exercises the canUseTool
// function directly with synthesized tool calls.
//
// Run: node packages/core/dist/__tests__/agent.smoke.js

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AgentRuntime,
  ensureSessionSkeleton,
  loadAgentConfig,
  SessionLayout,
} from "../index.js";
import type { Provider } from "../index.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "agents-rt-"));
console.log(`tmp root: ${tmp}`);

try {
  // --- Fixture: agent config + persona file ---
  const cfgDir = join(tmp, "configs", "agents");
  const personaDir = join(tmp, "claudemd");
  mkdirSync(cfgDir, { recursive: true });
  mkdirSync(personaDir, { recursive: true });

  writeFileSync(
    join(personaDir, "recon.md"),
    "You are the Recon agent. Be terse.",
    "utf8",
  );

  const agentJson = {
    id: "recon",
    name: "Recon Specialist",
    role: "Reconnaissance",
    providerId: "fake",
    model: "claude-opus-4-7",
    systemPromptFile: "../../claudemd/recon.md",
    allowedTools: ["Read", "Grep", "Glob", "Bash"],
    disallowedTools: ["WebSearch"],
    maxTurns: 5,
  };
  const cfgPath = join(cfgDir, "recon.json");
  writeFileSync(cfgPath, JSON.stringify(agentJson, null, 2), "utf8");

  // --- Layout ---
  const workspaces = join(tmp, "workspaces");
  mkdirSync(workspaces, { recursive: true });
  const layout = new SessionLayout(workspaces, "session-1");
  await ensureSessionSkeleton(layout);

  // --- Loaded config ---
  const loaded = await loadAgentConfig(cfgPath);
  check("loaded id", loaded.id === "recon");
  check(
    "systemPromptText loaded from file",
    !!loaded.systemPromptText && loaded.systemPromptText.includes("Recon agent"),
  );
  check("sourcePath absolute", resolve(cfgPath) === loaded.sourcePath);

  // --- Provider stub ---
  const provider: Provider = {
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

  // --- Build runtime ---
  const calls: { req: unknown }[] = [];
  const rt = new AgentRuntime({
    agent: loaded,
    provider,
    layout,
    extraSystemPromptLayers: [
      "## Group rules\nFollow the project's red-line list.",
      "## Blackboard contract\nWrite to your own area only.",
    ],
    approvalHandler: async (req) => {
      calls.push({ req });
      return { decision: "allow" };
    },
  });

  // --- buildSystemPrompt ---
  const sp = rt.buildSystemPrompt();
  check("system prompt has persona", sp.includes("Recon agent"));
  check("system prompt has group layer", sp.includes("Group rules"));
  check("system prompt has blackboard layer", sp.includes("Blackboard contract"));
  check("system prompt uses --- separator", sp.split("---").length >= 3);

  // --- buildEnv ---
  const env = rt.buildEnv();
  check("env has BASE_URL from provider", env.ANTHROPIC_BASE_URL === "https://example.test");
  check("env has token", env.ANTHROPIC_AUTH_TOKEN === "sk-fake");
  check("env has model from agent override", env.ANTHROPIC_MODEL === "claude-opus-4-7");

  // --- buildOptions / canUseTool ---
  const opts = await rt.buildOptions();
  check(
    "cwd is agent private dir",
    opts.cwd === layout.agentPrivateDir("recon"),
  );
  check(
    "additionalDirectories includes session root",
    Array.isArray(opts.additionalDirectories) &&
      opts.additionalDirectories.includes(resolve(layout.root)),
  );
  check(
    "allowedTools wired through",
    JSON.stringify(opts.allowedTools) === JSON.stringify(["Read", "Grep", "Glob", "Bash"]),
  );
  check(
    "disallowedTools wired through",
    JSON.stringify(opts.disallowedTools) === JSON.stringify(["WebSearch"]),
  );
  check("maxTurns honored", opts.maxTurns === 5);
  check("settingSources is empty (no auto-load)", JSON.stringify(opts.settingSources) === "[]");
  check("canUseTool present", typeof opts.canUseTool === "function");

  // --- Permission bridge: real calls ---
  const cut = opts.canUseTool!;
  const baseCtx = {
    signal: new AbortController().signal,
    toolUseID: "tu_1",
    suggestions: [],
  };

  // 1. Read — non-write tool, allow without consulting blackboard.
  const r1 = await cut("Read", { file_path: "anywhere/whatever" }, baseCtx);
  check("Read auto-allowed", r1.behavior === "allow");

  // 2. Write to own private dir — allow.
  const ownPath = join(layout.agentPrivateDir("recon"), "scan.json");
  const r2 = await cut("Write", { file_path: ownPath, content: "{}" }, baseCtx);
  check("Write own private dir allowed", r2.behavior === "allow");

  // 3. Write to other agent's area — approval handler triggered, then allow.
  const otherArea = layout.agentAreaFile("vuln");
  const r3 = await cut("Edit", { file_path: otherArea, old_string: "a", new_string: "b" }, baseCtx);
  check("Edit other agent area went via approval", calls.length === 1);
  check("Edit other agent area returned allow", r3.behavior === "allow");

  // 4. Write to _meta.md — hard deny without prompting.
  const r4 = await cut("Write", { file_path: layout.metaFile, content: "x" }, baseCtx);
  check("Write _meta.md denied", r4.behavior === "deny");
  check("approval handler NOT called for hard deny", calls.length === 1);

  // 5. Write outside session root — hard deny.
  const r5 = await cut("Write", { file_path: join(tmp, "outside.txt"), content: "x" }, baseCtx);
  check("Write outside session denied", r5.behavior === "deny");

  // 6. Approval handler returns deny.
  const rtDeny = new AgentRuntime({
    agent: loaded,
    provider,
    layout,
    approvalHandler: async () => ({ decision: "deny", message: "user said no" }),
  });
  const denyOpts = await rtDeny.buildOptions();
  const r6 = await denyOpts.canUseTool!(
    "Edit",
    { file_path: layout.agentAreaFile("vuln"), old_string: "a", new_string: "b" },
    baseCtx,
  );
  check("Approval-deny propagates to SDK deny", r6.behavior === "deny");
  check(
    "Approval-deny message preserved",
    r6.behavior === "deny" && r6.message === "user said no",
  );

  console.log(`\n${failures === 0 ? "ALL OK" : `FAILED (${failures})`}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) process.exit(1);
