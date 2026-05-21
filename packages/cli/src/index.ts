#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { VERSION, createDefaultRegistry, ProviderNotFoundError, SessionLayout, decideWrite, AgentRuntime, resolveAgentConfig, allowAllApprovalHandler, ensureSessionSkeleton, Orchestrator, SessionStore, loadGroupConfig } from "@agents/core";
import type { LoadedAgentConfig, OrchestratorEvent } from "@agents/core";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
// packages/cli/dist/index.js -> project root is three levels up.
const PROJECT_ROOT = resolve(here, "..", "..", "..");

// Re-spawn with --disable-warning=ExperimentalWarning so the noisy node:sqlite
// banner doesn't appear on every CLI run. We only do this once per process.
if (!process.env.AGENTS_CLI_NOWARN) {
  const r = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, AGENTS_CLI_NOWARN: "1" } },
  );
  process.exit(r.status ?? 1);
}

const argv = process.argv.slice(2);
const cmd = argv[0];

async function main() {
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }

  if (cmd === "providers") {
    const sub = argv[1] ?? "list";
    if (sub === "list") return providersList(argv.slice(2));
    if (sub === "show") return providersShow(argv.slice(2));
    console.error(`unknown providers subcommand: ${sub}`);
    process.exit(2);
  }

  if (cmd === "agent") {
    const sub = argv[1];
    if (sub === "ping") return agentPing(argv.slice(2));
    console.error(`unknown agent subcommand: ${sub ?? "(none)"}`);
    process.exit(2);
  }

  if (cmd === "session") {
    const sub = argv[1];
    if (sub === "inspect") return sessionInspect(argv.slice(2));
    if (sub === "show") return sessionShow(argv.slice(2));
    console.error(`unknown session subcommand: ${sub ?? "(none)"}`);
    process.exit(2);
  }

  if (cmd === "groups") {
    const sub = argv[1] ?? "list";
    if (sub === "list") return groupsList();
    if (sub === "show") return groupsShow(argv.slice(2));
    console.error(`unknown groups subcommand: ${sub}`);
    process.exit(2);
  }

  if (cmd === "run") return groupRun(argv.slice(1), { resume: false });
  if (cmd === "resume") return groupRun(argv.slice(1), { resume: true });
  if (cmd === "tui") return tuiRun(argv.slice(1));

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  console.error(`unknown command: ${cmd}`);
  printHelp();
  process.exit(2);
}

function printHelp() {
  console.log(`agents ${VERSION}

usage:
  agents --version
  agents providers list [--json]
  agents providers show <id>
  agents session inspect <session-id> [--actor <id>]
  agents session show <session-id>
  agents groups list
  agents groups show <group-id>
  agents run --group <path|id> --prompt <text> [--session <id>] [--max-rounds N]
  agents resume <session-id> [--max-rounds N]
  agents tui --group <path|id> --prompt <text> [--session <id>] [--max-rounds N]
  agents agent ping --provider <id> [--model <name>] [--prompt <text>] [--dry]

more commands land as the orchestrator, blackboard and runtime tasks ship.`);
}

async function providersList(args: string[]) {
  const json = args.includes("--json");
  const reg = createDefaultRegistry({ projectRoot: PROJECT_ROOT });
  const providers = await reg.list();

  if (json) {
    // Mask secrets for safe printing.
    console.log(JSON.stringify(providers.map(maskProvider), null, 2));
    return;
  }

  if (providers.length === 0) {
    console.log("(no providers found — install CC-Switch or create configs/providers.json)");
    return;
  }

  for (const p of providers) {
    const cur = p.meta?.isCurrent ? " *" : "";
    const url = p.env.ANTHROPIC_BASE_URL ?? "?";
    const models = p.models.length ? p.models.join(", ") : "(no models declared)";
    console.log(`- [${p.source}] ${p.name}${cur}`);
    console.log(`    id:     ${p.id}`);
    console.log(`    url:    ${url}`);
    console.log(`    models: ${models}`);
  }
}

async function providersShow(args: string[]) {
  const id = args[0];
  if (!id) {
    console.error("usage: agents providers show <id>");
    process.exit(2);
  }
  const reg = createDefaultRegistry({ projectRoot: PROJECT_ROOT });
  try {
    const p = await reg.get(id);
    console.log(JSON.stringify(maskProvider(p), null, 2));
  } catch (err) {
    if (err instanceof ProviderNotFoundError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

function maskProvider<T extends { env: Record<string, string> }>(p: T): T {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.env)) {
    env[k] = /token|key|auth|secret/i.test(k) && v ? "***" : v;
  }
  return { ...p, env };
}

async function sessionInspect(args: string[]) {
  const sessionId = args[0];
  if (!sessionId) {
    console.error("usage: agents session inspect <session-id> [--actor <id>]");
    process.exit(2);
  }
  const actorIdx = args.indexOf("--actor");
  const actor = actorIdx >= 0 ? args[actorIdx + 1] : undefined;

  const workspaces = resolve(PROJECT_ROOT, "workspaces");
  const layout = new SessionLayout(workspaces, sessionId);

  if (!existsSync(layout.root)) {
    console.error(`session not found: ${layout.root}`);
    process.exit(1);
  }

  console.log(`session: ${layout.sessionId}`);
  console.log(`root:    ${layout.root}\n`);

  await walk(layout.root, async (abs) => {
    const cls = layout.classify(abs);
    const rel = cls.relativePath ?? abs;
    const owner = cls.ownerAgentId ? ` [owner=${cls.ownerAgentId}]` : "";
    if (actor) {
      const d = decideWrite(layout, { actor, targetPath: abs });
      const tag = d.kind.toUpperCase().padEnd(8);
      console.log(`${tag} ${cls.role.padEnd(12)} ${rel}${owner}`);
    } else {
      console.log(`${cls.role.padEnd(12)} ${rel}${owner}`);
    }
  });
}

async function walk(dir: string, visit: (abs: string) => Promise<void>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const child = resolve(dir, e.name);
    if (e.isDirectory()) await walk(child, visit);
    else await visit(child);
  }
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function agentPing(args: string[]) {
  const providerId = getFlag(args, "--provider");
  const model = getFlag(args, "--model");
  const prompt = getFlag(args, "--prompt") ?? "Reply with the single word: pong.";
  const dry = args.includes("--dry");

  if (!providerId) {
    console.error("usage: agents agent ping --provider <id> [--model <name>] [--prompt <text>] [--dry]");
    process.exit(2);
  }

  const reg = createDefaultRegistry({ projectRoot: PROJECT_ROOT });
  let provider;
  try {
    provider = await reg.get(providerId);
  } catch (err) {
    if (err instanceof ProviderNotFoundError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const sessionId = `ping-${Date.now()}`;
  const workspaces = resolve(PROJECT_ROOT, "workspaces");
  const layout = new SessionLayout(workspaces, sessionId);
  await ensureSessionSkeleton(layout);

  const agentCfg: LoadedAgentConfig = await resolveAgentConfig(
    {
      id: "ping",
      name: "Ping Agent",
      providerId,
      model: model ?? provider.env.ANTHROPIC_MODEL,
      systemPrompt: "You are a connectivity test agent. Reply concisely.",
      allowedTools: [],
      maxTurns: 2,
    },
    resolve(PROJECT_ROOT, "configs", "agents", "ping.json"),
  );

  const runtime = new AgentRuntime({
    agent: agentCfg,
    provider,
    layout,
    approvalHandler: allowAllApprovalHandler,
  });

  console.log(`session: ${sessionId}`);
  console.log(`provider: ${provider.name} (${provider.source}) -> ${provider.env.ANTHROPIC_BASE_URL}`);
  console.log(`model: ${agentCfg.model}`);
  console.log(`cwd: ${layout.agentPrivateDir("ping")}`);

  if (dry) {
    const opts = await runtime.buildOptions();
    console.log("\n--- dry-run SDK options ---");
    console.log(JSON.stringify({
      cwd: opts.cwd,
      additionalDirectories: opts.additionalDirectories,
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      maxTurns: opts.maxTurns,
      model: opts.model,
      systemPrompt: typeof opts.systemPrompt === "string" ? opts.systemPrompt.slice(0, 200) : opts.systemPrompt,
      settingSources: opts.settingSources,
      envSubset: {
        ANTHROPIC_BASE_URL: opts.env?.ANTHROPIC_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: opts.env?.ANTHROPIC_AUTH_TOKEN ? "***" : undefined,
        ANTHROPIC_MODEL: opts.env?.ANTHROPIC_MODEL,
      },
    }, null, 2));
    return;
  }

  console.log(`\n> ${prompt}\n`);
  try {
    const res = await runtime.run({ prompt });
    console.log("--- response ---");
    console.log(res.text || "(no text)");
    console.log(`\n[turns=${res.numTurns} cost_usd=${res.totalCostUsd ?? 0} success=${res.success}]`);
  } catch (err) {
    console.error("agent run failed:", (err as Error).message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function sessionShow(args: string[]) {
  const sessionId = args[0];
  if (!sessionId) {
    console.error("usage: agents session show <session-id>");
    process.exit(2);
  }
  const workspaces = resolve(PROJECT_ROOT, "workspaces");
  const layout = new SessionLayout(workspaces, sessionId);
  if (!existsSync(layout.sessionMetaFile)) {
    console.error(`session.json not found: ${layout.sessionMetaFile}`);
    process.exit(1);
  }
  const store = new SessionStore(layout);
  const rec = await store.read();
  console.log(JSON.stringify(rec, null, 2));
}

async function groupRun(args: string[], mode: { resume: boolean }) {
  const groupFlag = getFlag(args, "--group");
  const prompt = getFlag(args, "--prompt");
  const sessionFlag = getFlag(args, "--session");
  const maxRoundsStr = getFlag(args, "--max-rounds");
  const maxRoundsOverride = maxRoundsStr ? Number(maxRoundsStr) : undefined;

  const workspaces = resolve(PROJECT_ROOT, "workspaces");
  const reg = createDefaultRegistry({ projectRoot: PROJECT_ROOT });

  let sessionId: string;
  let groupPath: string;
  let initialPrompt: string;
  let resumeRecord: Awaited<ReturnType<SessionStore["read"]>> | undefined;

  if (mode.resume) {
    sessionId = args.find((a) => !a.startsWith("--")) ?? "";
    if (!sessionId) {
      console.error("usage: agents resume <session-id> [--max-rounds N]");
      process.exit(2);
    }
    const layout0 = new SessionLayout(workspaces, sessionId);
    if (!existsSync(layout0.sessionMetaFile)) {
      console.error(`session.json not found: ${layout0.sessionMetaFile}`);
      process.exit(1);
    }
    resumeRecord = await new SessionStore(layout0).read();
    groupPath = resumeRecord.groupSourcePath;
    initialPrompt = resumeRecord.initialPrompt;
    if (resumeRecord.status === "finished" || resumeRecord.status === "aborted") {
      console.log(`session already ${resumeRecord.status}; nothing to resume.`);
      return;
    }
    // Flip status to "running" so the orchestrator continues.
    resumeRecord = { ...resumeRecord, status: "running", finishReason: undefined };
  } else {
    if (!groupFlag || !prompt) {
      console.error("usage: agents run --group <path|id> --prompt <text> [--session <id>]");
      process.exit(2);
    }
    groupPath = resolveGroupSpec(groupFlag);
    initialPrompt = prompt;
    sessionId = sessionFlag ?? `${baseName(groupPath)}-${Date.now()}`;
  }

  const group = await loadGroupConfig(groupPath);
  const layout = new SessionLayout(workspaces, sessionId);

  const orch = new Orchestrator({
    group,
    layout,
    providerResolver: (id) => reg.get(id),
    approvalHandler: allowAllApprovalHandler,
    maxRoundsOverride,
  });

  console.log(`session: ${sessionId}`);
  console.log(`group:   ${group.id} (${group.name})`);
  console.log(`mode:    ${group.mode} | maxRounds: ${maxRoundsOverride ?? group.maxRounds}`);
  console.log(`agents:  ${group.agents.map((a) => a.id).join(", ")}`);
  if (resumeRecord) {
    console.log(`resume:  round ${resumeRecord.nextRound} (history len ${resumeRecord.history.length})`);
  }
  console.log("");

  const onEvent = (e: OrchestratorEvent) => {
    if (e.type === "agent-speaking") {
      process.stdout.write(`[round ${e.round}] ${e.agentId} … `);
    } else if (e.type === "agent-spoke") {
      const preview = (e.text ?? "").replace(/\s+/g, " ").slice(0, 80);
      process.stdout.write(`done (${preview}${(e.text ?? "").length > 80 ? "…" : ""})\n`);
    } else if (e.type === "consensus-reached") {
      console.log(`[consensus] ${e.agentId} signalled.`);
    } else if (e.type === "run-finished") {
      console.log(`[finished] reason=${e.reason}`);
    }
  };

  const res = await orch.run({ initialPrompt, onEvent, resumeFrom: resumeRecord });
  console.log("");
  console.log(`rounds: ${res.rounds}, reason: ${res.reason}`);
  if (res.consensusAgentId) console.log(`consensus by: ${res.consensusAgentId}`);
}

function baseName(p: string): string {
  const m = /([^\\/]+?)(?:\.[^.]+)?$/.exec(p);
  return m?.[1] ?? "session";
}

async function tuiRun(args: string[]) {
  const groupFlag = getFlag(args, "--group");
  const prompt = getFlag(args, "--prompt");
  const sessionFlag = getFlag(args, "--session");
  const maxRoundsStr = getFlag(args, "--max-rounds");
  const maxRoundsOverride = maxRoundsStr ? Number(maxRoundsStr) : undefined;

  if (!groupFlag || !prompt) {
    console.error("usage: agents tui --group <path|id> --prompt <text> [--session <id>] [--max-rounds N]");
    process.exit(2);
  }
  const groupPath = resolveGroupSpec(groupFlag);
  const sessionId = sessionFlag ?? `${baseName(groupPath)}-${Date.now()}`;
  const workspacesRoot = resolve(PROJECT_ROOT, "workspaces");
  const reg = createDefaultRegistry({ projectRoot: PROJECT_ROOT });

  const { mountTui } = await import("./tui/mount.js");
  await mountTui({
    groupPath,
    initialPrompt: prompt,
    sessionId,
    workspacesRoot,
    providerResolver: (id) => reg.get(id),
    maxRoundsOverride,
  });
}

function presetGroupsDir(): string {
  return resolve(PROJECT_ROOT, "configs", "groups");
}

/** Resolve --group flag: try literal path first, then configs/groups/<id>.json. */
function resolveGroupSpec(spec: string): string {
  if (existsSync(spec)) return resolve(spec);
  const presetPath = resolve(presetGroupsDir(), `${spec}.json`);
  if (existsSync(presetPath)) return presetPath;
  return resolve(spec); // let downstream raise a helpful error
}

async function groupsList() {
  const dir = presetGroupsDir();
  if (!existsSync(dir)) {
    console.log("(no preset groups dir)");
    return;
  }
  const entries = await readdir(dir);
  const groups = entries.filter((n) => n.endsWith(".json")).sort();
  if (groups.length === 0) {
    console.log("(no preset groups found)");
    return;
  }
  for (const file of groups) {
    try {
      const g = await loadGroupConfig(resolve(dir, file));
      const tag = g.mode === "moderator" ? `moderator(${g.moderatorId})` : g.mode;
      console.log(`- ${g.id} — ${g.name}`);
      console.log(`    mode:   ${tag}, maxRounds: ${g.maxRounds}`);
      console.log(`    agents: ${g.agents.map((a) => a.id).join(", ")}`);
      if (g.description) console.log(`    desc:   ${g.description}`);
    } catch (err) {
      console.log(`- ${file} — failed to load: ${(err as Error).message}`);
    }
  }
}

async function groupsShow(args: string[]) {
  const id = args[0];
  if (!id) {
    console.error("usage: agents groups show <group-id>");
    process.exit(2);
  }
  const path = resolveGroupSpec(id);
  if (!existsSync(path)) {
    console.error(`group not found: ${path}`);
    process.exit(1);
  }
  const g = await loadGroupConfig(path);
  console.log(JSON.stringify(
    {
      id: g.id,
      name: g.name,
      description: g.description,
      mode: g.mode,
      moderatorId: g.moderatorId,
      maxRounds: g.maxRounds,
      consensusMarker: g.consensusMarker,
      sourcePath: g.sourcePath,
      agents: g.agents.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        providerId: a.providerId,
        model: a.model,
        promptPreview: (a.systemPromptText ?? "").slice(0, 120),
      })),
    },
    null,
    2,
  ));
}
