// HTTP/SSE server that drives Orchestrator runs from a web UI.
//
// Endpoints:
//   GET  /api/health
//   GET  /api/providers
//   GET  /api/groups
//   GET  /api/groups/:id
//   POST /api/sessions                 { groupId, prompt, maxRounds? }
//   GET  /api/sessions
//   GET  /api/sessions/:id
//   GET  /api/sessions/:id/events      (SSE)
//   GET  /api/sessions/:id/blackboard?label=meta|shared|agent:<id>
//   POST /api/sessions/:id/resume      { maxRounds? }
//   POST /api/sessions/:id/abort
//   POST /api/approvals/:reqId         { allow: boolean, message? }
//
// Static web bundle (if present at WEB_DIST) is served at "/".

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import { Db, migrateLegacyConfigs } from "./db.js";
import { registerAgentRoutes } from "./routes-agents.js";
import { registerGroupRoutes } from "./routes-groups.js";
import { registerChatRoutes } from "./routes-chat.js";
import {
  Blackboard,
  Orchestrator,
  ProviderNotFoundError,
  SessionLayout,
  SessionStore,
  createDefaultRegistry,
  loadGroupConfig,
  type ApprovalHandler,
  type ApprovalRequest,
  type ApprovalResponse,
  type LoadedGroupConfig,
  type OrchestratorEvent,
  type Provider,
} from "@agents/core";

const here = dirname(fileURLToPath(import.meta.url));
// dist/index.js -> packages/server -> agents root (3 levels up).
const PROJECT_ROOT = resolve(
  process.env.AGENTS_PROJECT_ROOT ?? resolve(here, "..", "..", ".."),
);
const WORKSPACES = resolve(
  process.env.AGENTS_WORKSPACES ?? resolve(PROJECT_ROOT, "workspaces"),
);
const GROUPS_DIR = resolve(PROJECT_ROOT, "configs", "groups");
const WEB_DIST = process.env.AGENTS_WEB_DIST
  ? resolve(process.env.AGENTS_WEB_DIST)
  : resolve(here, "..", "..", "web", "dist");
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

// ---- in-memory session controllers ----
interface SessionCtl {
  id: string;
  groupId: string;
  prompt: string;
  status: "running" | "finished" | "aborted" | "error";
  reason?: string;
  consensusBy?: string;
  rounds: number;
  startedAt: string;
  events: StoredEvent[];
  subscribers: Set<(e: StoredEvent) => void>;
  abort: AbortController;
  approvalIds: Map<string, PendingApproval>;
}
interface StoredEvent {
  seq: number;
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
}
interface PendingApproval {
  request: ApprovalRequest;
  resolve: (resp: ApprovalResponse) => void;
}

const sessions = new Map<string, SessionCtl>();
let nextEventSeq = 1;
let nextApprovalSeq = 1;

// PLACEHOLDER_SERVER_REST

const reg = createDefaultRegistry({ projectRoot: PROJECT_ROOT });

function maskProvider(p: Provider): Record<string, unknown> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.env)) {
    env[k] = /token|key|auth|secret/i.test(k) && v ? "***" : v;
  }
  return { ...p, env };
}

async function listGroupsWithMeta(): Promise<
  Array<{ id: string; name: string; description?: string; mode: string; maxRounds: number; agents: string[]; sourcePath: string }>
> {
  if (!existsSync(GROUPS_DIR)) return [];
  const files = (await readdir(GROUPS_DIR)).filter((f) => f.endsWith(".json")).sort();
  const out: Array<{ id: string; name: string; description?: string; mode: string; maxRounds: number; agents: string[]; sourcePath: string }> = [];
  for (const file of files) {
    try {
      const g = await loadGroupConfig(resolve(GROUPS_DIR, file));
      out.push({
        id: g.id,
        name: g.name,
        description: g.description,
        mode: g.mode,
        maxRounds: g.maxRounds,
        agents: g.agents.map((a) => a.id),
        sourcePath: g.sourcePath,
      });
    } catch {
      // skip
    }
  }
  return out;
}

function pushEvent(ctl: SessionCtl, kind: string, payload: Record<string, unknown>): StoredEvent {
  const ev: StoredEvent = {
    seq: nextEventSeq++,
    ts: new Date().toISOString(),
    kind,
    payload,
  };
  ctl.events.push(ev);
  for (const fn of ctl.subscribers) {
    try { fn(ev); } catch { /* ignore */ }
  }
  return ev;
}

function ctlPublic(ctl: SessionCtl) {
  return {
    id: ctl.id,
    groupId: ctl.groupId,
    prompt: ctl.prompt,
    status: ctl.status,
    reason: ctl.reason,
    consensusBy: ctl.consensusBy,
    rounds: ctl.rounds,
    startedAt: ctl.startedAt,
    pendingApprovals: Array.from(ctl.approvalIds.entries()).map(([id, p]) => ({
      id,
      request: {
        actor: p.request.actor,
        toolName: p.request.toolName,
        targetPath: p.request.targetPath,
        classification: p.request.classification,
        reason: p.request.reason,
      },
    })),
  };
}

// MARKER_RUN_LAUNCH

async function launchSession(opts: {
  group: LoadedGroupConfig;
  prompt: string;
  sessionId: string;
  maxRounds?: number;
  resumeRecord?: import("@agents/core").SessionRecord;
}): Promise<SessionCtl> {
  const layout = new SessionLayout(WORKSPACES, opts.sessionId);

  const ctl: SessionCtl = {
    id: opts.sessionId,
    groupId: opts.group.id,
    prompt: opts.prompt,
    status: "running",
    rounds: 0,
    startedAt: new Date().toISOString(),
    events: [],
    subscribers: new Set(),
    abort: new AbortController(),
    approvalIds: new Map(),
  };
  sessions.set(opts.sessionId, ctl);

  const approvalHandler: ApprovalHandler = (req) =>
    new Promise<ApprovalResponse>((res) => {
      const id = `apv-${nextApprovalSeq++}`;
      ctl.approvalIds.set(id, { request: req, resolve: res });
      pushEvent(ctl, "approval-pending", {
        id,
        actor: req.actor,
        toolName: req.toolName,
        targetPath: req.targetPath,
        classification: req.classification,
        reason: req.reason,
      });
    });

  const orch = new Orchestrator({
    group: opts.group,
    layout,
    providerResolver: (id) => reg.get(id),
    approvalHandler,
    maxRoundsOverride: opts.maxRounds,
  });

  pushEvent(ctl, "session-start", { groupId: opts.group.id, prompt: opts.prompt });

  const onEvent = (e: OrchestratorEvent) => {
    if (e.round !== undefined) ctl.rounds = e.round;
    pushEvent(ctl, e.type, {
      round: e.round,
      agentId: e.agentId,
      text: e.text,
      reason: e.reason,
    });
  };

  // Fire-and-forget; status reflected via SSE.
  void orch
    .run({
      initialPrompt: opts.prompt,
      onEvent,
      signal: ctl.abort.signal,
      resumeFrom: opts.resumeRecord,
    })
    .then((res) => {
      ctl.status = "finished";
      ctl.reason = res.reason;
      ctl.consensusBy = res.consensusAgentId;
      ctl.rounds = res.rounds;
      pushEvent(ctl, "session-finished", {
        reason: res.reason,
        consensusBy: res.consensusAgentId,
        rounds: res.rounds,
      });
    })
    .catch((err) => {
      ctl.status = "error";
      ctl.reason = (err as Error).message;
      pushEvent(ctl, "session-error", { message: (err as Error).message });
    });

  return ctl;
}

function baseName(p: string): string {
  const m = /([^\\/]+?)(?:\.[^.]+)?$/.exec(p);
  return m?.[1] ?? "session";
}

function resolveGroupSpec(spec: string): string {
  if (existsSync(spec)) return resolve(spec);
  const presetPath = resolve(GROUPS_DIR, `${spec}.json`);
  if (existsSync(presetPath)) return presetPath;
  return resolve(spec);
}

// MARKER_FASTIFY

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(fastifyCors, { origin: true });

// ---- chat DB + new CRUD routes ----
const DB_PATH = resolve(process.env.AGENTS_DB_PATH ?? join(WORKSPACES, "agents.db"));
const db = new Db(DB_PATH);
const migrated = migrateLegacyConfigs(db, PROJECT_ROOT);
app.log.info(`db: ${DB_PATH} (migrated ${migrated.agents} agents, ${migrated.groups} groups)`);
registerAgentRoutes(app, db, reg);
registerGroupRoutes(app, db);
registerChatRoutes(app, db, reg, { projectRoot: PROJECT_ROOT, workspaces: WORKSPACES });

app.get("/api/health", async () => ({
  ok: true,
  projectRoot: PROJECT_ROOT,
  workspaces: WORKSPACES,
}));

app.get("/api/providers", async () => {
  const providers = await reg.list();
  return providers.map(maskProvider);
});

app.get("/api/groups", async () => {
  return await listGroupsWithMeta();
});

app.get<{ Params: { id: string } }>("/api/groups/:id", async (req, reply) => {
  const path = resolveGroupSpec(req.params.id);
  if (!existsSync(path)) {
    reply.code(404);
    return { error: `group not found: ${req.params.id}` };
  }
  try {
    const g = await loadGroupConfig(path);
    return {
      id: g.id,
      name: g.name,
      description: g.description,
      mode: g.mode,
      moderatorId: g.moderatorId,
      maxRounds: g.maxRounds,
      consensusMarker: g.consensusMarker,
      sourcePath: g.sourcePath,
      metaText: g.metaText,
      agents: g.agents.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        providerId: a.providerId,
        model: a.model,
        promptPreview: (a.systemPromptText ?? "").slice(0, 200),
        allowedTools: a.allowedTools,
        disallowedTools: a.disallowedTools,
        maxTurns: a.maxTurns,
      })),
    };
  } catch (err) {
    reply.code(500);
    return { error: (err as Error).message };
  }
});

app.post<{ Body: { groupId: string; prompt: string; maxRounds?: number; sessionId?: string } }>(
  "/api/sessions",
  async (req, reply) => {
    const { groupId, prompt, maxRounds, sessionId } = req.body ?? ({} as never);
    if (!groupId || !prompt) {
      reply.code(400);
      return { error: "groupId and prompt are required" };
    }
    const groupPath = resolveGroupSpec(groupId);
    if (!existsSync(groupPath)) {
      reply.code(404);
      return { error: `group not found: ${groupId}` };
    }
    let group: LoadedGroupConfig;
    try {
      group = await loadGroupConfig(groupPath);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }

    // Validate every agent's provider up-front so we fail fast with a clear error.
    for (const a of group.agents) {
      try {
        await reg.get(a.providerId);
      } catch (err) {
        reply.code(400);
        if (err instanceof ProviderNotFoundError) {
          return {
            error: `agent "${a.id}" needs provider "${a.providerId}" — not found in registry`,
          };
        }
        return { error: (err as Error).message };
      }
    }

    const sid = sessionId ?? `${baseName(groupPath)}-${Date.now()}`;
    const ctl = await launchSession({ group, prompt, sessionId: sid, maxRounds });
    return ctlPublic(ctl);
  },
);

app.get("/api/sessions", async () => {
  return Array.from(sessions.values()).map(ctlPublic);
});

app.get<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
  const ctl = sessions.get(req.params.id);
  if (ctl) return ctlPublic(ctl);
  // fall back to disk record
  const layout = new SessionLayout(WORKSPACES, req.params.id);
  if (!existsSync(layout.sessionMetaFile)) {
    reply.code(404);
    return { error: "session not found" };
  }
  const rec = await new SessionStore(layout).read();
  return {
    id: rec.sessionId,
    groupId: rec.groupId,
    prompt: rec.initialPrompt,
    status: rec.status,
    reason: rec.finishReason,
    consensusBy: rec.consensusAgentId,
    rounds: rec.history.length,
    startedAt: rec.startedAt,
    pendingApprovals: [],
  };
});

// MARKER_SSE_AND_BB

app.get<{ Params: { id: string }; Querystring: { lastSeq?: string } }>(
  "/api/sessions/:id/events",
  async (req, reply) => {
    const ctl = sessions.get(req.params.id);
    if (!ctl) {
      reply.code(404);
      return { error: "session not in memory (start a new run or implement disk replay)" };
    }
    const lastSeq = req.query.lastSeq ? Number(req.query.lastSeq) : 0;

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders?.();

    const send = (ev: StoredEvent) => {
      reply.raw.write(`id: ${ev.seq}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
    };

    // Replay missed events.
    for (const ev of ctl.events) {
      if (ev.seq > lastSeq) send(ev);
    }
    // If already finished, close after replay.
    if (ctl.status !== "running") {
      reply.raw.write(`event: end\ndata: {"status":"${ctl.status}"}\n\n`);
      reply.raw.end();
      return reply;
    }
    // Live subscribe.
    const sub = (ev: StoredEvent) => {
      send(ev);
      if (ev.kind === "session-finished" || ev.kind === "session-error") {
        reply.raw.write(`event: end\ndata: {"status":"${ctl.status}"}\n\n`);
        reply.raw.end();
        ctl.subscribers.delete(sub);
      }
    };
    ctl.subscribers.add(sub);
    req.raw.on("close", () => ctl.subscribers.delete(sub));
    return reply;
  },
);

app.get<{ Params: { id: string }; Querystring: { label?: string } }>(
  "/api/sessions/:id/blackboard",
  async (req, reply) => {
    const layout = new SessionLayout(WORKSPACES, req.params.id);
    if (!existsSync(layout.root)) {
      reply.code(404);
      return { error: "session not found" };
    }
    const bb = new Blackboard(layout);
    const label = (req.query.label ?? "meta").trim();
    try {
      let body = "";
      if (label === "meta") body = await bb.readMeta();
      else if (label === "shared") body = await bb.readShared();
      else if (label.startsWith("agent:")) body = await bb.readAgentArea(label.slice(6));
      else {
        reply.code(400);
        return { error: `unknown label: ${label}` };
      }
      return { label, body };
    } catch (err) {
      reply.code(500);
      return { error: (err as Error).message };
    }
  },
);

app.get<{ Params: { id: string } }>("/api/sessions/:id/turns", async (req, reply) => {
  const layout = new SessionLayout(WORKSPACES, req.params.id);
  if (!existsSync(layout.root)) {
    reply.code(404);
    return { error: "session not found" };
  }
  const dir = join(layout.root, "blackboard", "turns");
  if (!existsSync(dir)) return { turns: [] };
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  const { readFile } = await import("node:fs/promises");
  const turns: Array<{ file: string; round?: number; agentId?: string; body: string }> = [];
  for (const f of files) {
    const m = /^(\d{4})-([^.]+)\.md$/.exec(f);
    const body = await readFile(join(dir, f), "utf8");
    turns.push({
      file: f,
      round: m ? Number(m[1]) : undefined,
      agentId: m?.[2],
      body,
    });
  }
  return { turns };
});

app.post<{ Params: { reqId: string }; Body: { allow: boolean; message?: string } }>(
  "/api/approvals/:reqId",
  async (req, reply) => {
    const { reqId } = req.params;
    const { allow, message } = req.body ?? ({} as never);
    for (const ctl of sessions.values()) {
      const p = ctl.approvalIds.get(reqId);
      if (!p) continue;
      ctl.approvalIds.delete(reqId);
      if (allow) p.resolve({ decision: "allow" });
      else p.resolve({ decision: "deny", message: message ?? "user denied via web" });
      pushEvent(ctl, "approval-resolved", { id: reqId, allow });
      return { ok: true };
    }
    reply.code(404);
    return { error: "approval not found (timed out?)" };
  },
);

app.post<{ Params: { id: string } }>("/api/sessions/:id/abort", async (req, reply) => {
  const ctl = sessions.get(req.params.id);
  if (!ctl) {
    reply.code(404);
    return { error: "session not in memory" };
  }
  ctl.abort.abort();
  ctl.status = "aborted";
  ctl.reason = "user-abort";
  pushEvent(ctl, "session-aborted", {});
  return { ok: true };
});

app.post<{ Params: { id: string }; Body: { maxRounds?: number } }>(
  "/api/sessions/:id/resume",
  async (req, reply) => {
    const layout = new SessionLayout(WORKSPACES, req.params.id);
    if (!existsSync(layout.sessionMetaFile)) {
      reply.code(404);
      return { error: "session.json not found" };
    }
    const rec = await new SessionStore(layout).read();
    if (rec.status === "finished" || rec.status === "aborted") {
      return { error: `already ${rec.status}` };
    }
    const path = resolveGroupSpec(rec.groupSourcePath);
    let group: LoadedGroupConfig;
    try {
      group = await loadGroupConfig(path);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
    const ctl = await launchSession({
      group,
      prompt: rec.initialPrompt,
      sessionId: req.params.id,
      maxRounds: req.body?.maxRounds,
      resumeRecord: { ...rec, status: "running", finishReason: undefined },
    });
    return ctlPublic(ctl);
  },
);

// MARKER_STATIC_AND_LISTEN

// Serve the SPA bundle if it has been built. The web package's vite build
// emits to packages/web/dist; we resolve relative to PROJECT_ROOT in Docker.
if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, {
    root: WEB_DIST,
    prefix: "/",
    wildcard: false,
  });
  // SPA fallback for client-side routes.
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith("/api/")) {
      reply.code(404).send({ error: "not found" });
      return;
    }
    reply.sendFile("index.html");
  });
  app.log.info(`web bundle served from ${WEB_DIST}`);
} else {
  app.log.warn(`no web bundle at ${WEB_DIST}; API only`);
}

await app.listen({ host: HOST, port: PORT });
app.log.info(`agents server up at http://${HOST}:${PORT}`);
app.log.info(`project root: ${PROJECT_ROOT}`);
app.log.info(`workspaces:   ${WORKSPACES}`);





