/**
 * /api/chat — group chat messages, SSE stream, and moderator-driven scheduling.
 *
 * Design (Q1c hybrid + Q3c per-agent perms + Q4b sliding window + Q5 emoji):
 *   - User posts a message → enqueue scheduler tick.
 *   - Moderator agent (an Agent like any other) decides next speaker via JSON:
 *       {"next":"<agent-id>|user","reason":"..."}
 *   - That agent runs once, message saved, loop back to moderator.
 *   - Loop terminates when next === "user" or step limit reached.
 *   - When the user @-mentions agents in their message, we bypass the moderator
 *     for the first turn(s) and run them in order.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { resolve } from "node:path";
import type { Db, AgentRow, GroupRow, MessageRow } from "./db.js";
import {
  AgentRuntime,
  Blackboard,
  SessionLayout,
  type ApprovalHandler,
  type ApprovalRequest,
  type ApprovalResponse,
  type LoadedAgentConfig,
  type ProviderRegistry,
} from "@agents/core";

interface ChatOpts { projectRoot: string; workspaces: string; }

type StreamHandler = (ev: { kind: string; payload: any }) => void;

interface GroupCtl {
  groupId: string;
  busy: boolean;
  abort: AbortController;
  layout: SessionLayout;
  blackboard: Blackboard;
  subscribers: Set<StreamHandler>;
  pendingApprovals: Map<string, { req: ApprovalRequest; resolve: (r: ApprovalResponse) => void }>;
}

const ctls = new Map<string, GroupCtl>();
let approvalSeq = 1;
const SCHEDULER_STEP_LIMIT = 20;
const HISTORY_WINDOW = 30;

function getCtl(groupId: string, opts: ChatOpts): GroupCtl {
  let c = ctls.get(groupId);
  if (c) return c;
  const layout = new SessionLayout(resolve(opts.workspaces), groupId);
  c = {
    groupId, busy: false, abort: new AbortController(), layout,
    blackboard: new Blackboard(layout), subscribers: new Set(),
    pendingApprovals: new Map(),
  };
  ctls.set(groupId, c);
  return c;
}

function broadcast(c: GroupCtl, kind: string, payload: any): void {
  for (const fn of c.subscribers) { try { fn({ kind, payload }); } catch {} }
}

function rowToLoadedAgent(a: AgentRow, projectRoot: string): LoadedAgentConfig {
  return {
    id: a.id, name: a.name, providerId: a.providerId,
    model: a.model ?? undefined,
    systemPrompt: a.systemPrompt,
    systemPromptText: a.systemPrompt,
    allowedTools: a.allowedTools.length ? a.allowedTools : undefined,
    disallowedTools: a.disallowedTools.length ? a.disallowedTools : undefined,
    maxTurns: a.maxTurns,
    sourcePath: resolve(projectRoot, "configs", "agents", `${a.id}.json`),
  };
}

function parseMentions(text: string, members: string[]): string[] {
  const out: string[] = [];
  const re = /@([a-zA-Z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (members.includes(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function renderHistory(group: GroupRow, msgs: MessageRow[], db: Db): string {
  const nameById: Record<string, string> = { user: "👤 用户" };
  for (const id of group.memberIds) {
    const a = db.getAgent(id);
    if (a) nameById[id] = `${a.emoji} ${a.name} [@${id}]`;
  }
  return msgs.map((m) => {
    const tag = m.fromKind === "user" ? "👤 用户"
      : m.fromKind === "moderator" ? "🎙️ 主持人"
      : (m.fromAgentId && nameById[m.fromAgentId]) || m.fromAgentId || m.fromKind;
    return `### ${tag}\n${m.text}`;
  }).join("\n\n");
}

function buildModeratorPrompt(group: GroupRow, members: AgentRow[], history: string): string {
  const roster = members.map((a) => `- @${a.id}（${a.name}）：${a.systemPrompt.split("\n")[0].slice(0, 80)}`).join("\n");
  return `你是群聊「${group.name}」的主持人。基于下面的群聊历史，决定**下一句话该由谁来说**。

可选成员：
${roster}
- user（让用户继续，如果话题已告一段落或需要用户决定）

# 群聊历史（最近 ${HISTORY_WINDOW} 条）
${history}

# 你的输出
仅输出 JSON，无任何前后缀。结构：
{"next": "<agent-id 或 user>", "reason": "<一句话理由>"}

如果用户的消息已经被妥善回应、或者不需要更多 AI 接龙，就选 "user"。`;
}

function parseModeratorChoice(text: string): { next: string; reason: string } | null {
  const m = text.match(/\{[\s\S]*?"next"[\s\S]*?\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (typeof o.next === "string") return { next: o.next, reason: String(o.reason ?? "") };
  } catch {}
  return null;
}

function buildAgentPrompt(group: GroupRow, agent: AgentRow, members: AgentRow[], history: string): string {
  const peers = members.filter((a) => a.id !== agent.id).map((a) => `@${a.id} (${a.name})`).join(", ");
  return `你正在参与群聊「${group.name}」。你的身份：${agent.emoji} ${agent.name} [@${agent.id}]。

# 群组目标
${group.meta || "（未指定）"}

# 群成员（除你之外）
${peers || "（只有你和用户）"}

# 群聊历史（最近 ${HISTORY_WINDOW} 条）
${history}

# 现在请你发言
保持你的角色与专业风格，简明扼要回应当前话题。可以 @ 其他成员请求他们参与。直接输出你要说的话，不要重复历史。`;
}

async function runOneTurn(
  agent: AgentRow, prompt: string, c: GroupCtl, reg: ProviderRegistry, projectRoot: string,
): Promise<string> {
  const provider = await reg.get(agent.providerId);
  const loaded = rowToLoadedAgent(agent, projectRoot);
  const approvalHandler: ApprovalHandler = (req) => new Promise((res) => {
    const id = `apv-${approvalSeq++}`;
    c.pendingApprovals.set(id, { req, resolve: res });
    broadcast(c, "approval-pending", {
      id, actor: req.actor, toolName: req.toolName,
      targetPath: req.targetPath, classification: req.classification, reason: req.reason,
    });
  });
  const rt = new AgentRuntime({ agent: loaded, provider, layout: c.layout, approvalHandler });
  const onMessage = (msg: unknown) => {
    broadcast(c, "agent-message", { agentId: agent.id, msg });
  };
  const result = await rt.run({ prompt, signal: c.abort.signal, onMessage });
  return (result.text ?? "").trim();
}

async function tickScheduler(opts: {
  group: GroupRow; db: Db; reg: ProviderRegistry; chatOpts: ChatOpts; mentioned: string[];
}): Promise<void> {
  const { group, db, reg, chatOpts, mentioned } = opts;
  const c = getCtl(group.id, chatOpts);
  if (c.busy) { broadcast(c, "scheduler-skip", { reason: "busy" }); return; }
  c.busy = true;
  c.abort = new AbortController();
  try {
    const queue = [...mentioned];
    let steps = 0;
    while (steps < SCHEDULER_STEP_LIMIT) {
      steps++;
      let nextId: string;
      let reason = "";
      if (queue.length > 0) {
        nextId = queue.shift()!;
        reason = "用户 @ 指定";
      } else if (group.moderatorAgentId) {
        const moderator = db.getAgent(group.moderatorAgentId);
        if (!moderator) { broadcast(c, "scheduler-error", { reason: "moderator agent missing" }); break; }
        const msgs = db.listMessages(group.id, 0, 9999).slice(-HISTORY_WINDOW);
        const members = group.memberIds.map((id) => db.getAgent(id)).filter((x): x is AgentRow => !!x);
        const history = renderHistory(group, msgs, db);
        const decisionText = await runOneTurn(moderator, buildModeratorPrompt(group, members, history), c, reg, chatOpts.projectRoot);
        const choice = parseModeratorChoice(decisionText);
        if (!choice) { broadcast(c, "scheduler-warn", { reason: "moderator output not parseable", raw: decisionText.slice(0, 200) }); break; }
        broadcast(c, "moderator-decision", { next: choice.next, reason: choice.reason, raw: decisionText });
        const decisionMsg = db.appendMessage({
          groupId: group.id, fromKind: "moderator", fromAgentId: moderator.id,
          text: `→ @${choice.next} · ${choice.reason}`, meta: { decision: choice },
        });
        broadcast(c, "message", decisionMsg);
        if (choice.next === "user") break;
        nextId = choice.next;
        reason = choice.reason;
      } else {
        // No moderator and no mentions → stop after one auto-pick of first member.
        if (steps > 1) break;
        nextId = group.memberIds[0];
        if (!nextId) break;
        reason = "无主持人，默认首位成员";
      }
      const agent = db.getAgent(nextId);
      if (!agent) { broadcast(c, "scheduler-warn", { reason: `unknown next: ${nextId}` }); break; }
      if (!group.memberIds.includes(agent.id)) { broadcast(c, "scheduler-warn", { reason: `${agent.id} not in group` }); break; }
      broadcast(c, "agent-thinking", { agentId: agent.id, reason });
      const msgs = db.listMessages(group.id, 0, 9999).slice(-HISTORY_WINDOW);
      const members = group.memberIds.map((id) => db.getAgent(id)).filter((x): x is AgentRow => !!x);
      const history = renderHistory(group, msgs, db);
      const reply = await runOneTurn(agent, buildAgentPrompt(group, agent, members, history), c, reg, chatOpts.projectRoot);
      const saved = db.appendMessage({
        groupId: group.id, fromKind: "agent", fromAgentId: agent.id,
        text: reply || "(空回复)", meta: { reason },
      });
      broadcast(c, "message", saved);
      // Append to blackboard owner area (best effort).
      try { await c.blackboard.appendToOwnArea(agent.id, reply, { header: `## ${new Date().toISOString()}` }); } catch {}
      // Honor agent-side @-mentions to keep the chain going.
      const fwd = parseMentions(reply, group.memberIds).filter((id) => id !== agent.id);
      for (const id of fwd) if (!queue.includes(id)) queue.push(id);
    }
  } catch (e: any) {
    broadcast(c, "scheduler-error", { reason: e?.message ?? String(e) });
  } finally {
    c.busy = false;
    broadcast(c, "scheduler-idle", {});
  }
}

export function registerChatRoutes(app: FastifyInstance, db: Db, reg: ProviderRegistry, chatOpts: ChatOpts): void {
  app.get("/api/groups2/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.getGroup(id)) { reply.code(404); return { error: "not found" }; }
    const q = req.query as { since?: string; limit?: string };
    return db.listMessages(id, Number(q.since ?? 0), Math.min(Number(q.limit ?? 500), 2000));
  });

  app.post("/api/groups2/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    const g = db.getGroup(id);
    if (!g) { reply.code(404); return { error: "not found" }; }
    const body = req.body as { text: string };
    if (!body?.text?.trim()) { reply.code(400); return { error: "text required" }; }
    const c = getCtl(id, chatOpts);
    const saved = db.appendMessage({ groupId: id, fromKind: "user", fromAgentId: null, text: body.text.trim(), meta: null });
    broadcast(c, "message", saved);
    const mentions = parseMentions(body.text, g.memberIds);
    void tickScheduler({ group: g, db, reg, chatOpts, mentioned: mentions });
    return saved;
  });

  app.post("/api/groups2/:id/abort", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.getGroup(id)) { reply.code(404); return { error: "not found" }; }
    const c = ctls.get(id);
    if (c) c.abort.abort();
    return { ok: true };
  });

  app.get("/api/groups2/:id/stream", async (req, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (!db.getGroup(id)) { reply.code(404); return reply.send({ error: "not found" }); }
    const c = getCtl(id, chatOpts);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send: StreamHandler = (ev) => {
      reply.raw.write(`event: ${ev.kind}\ndata: ${JSON.stringify(ev.payload)}\n\n`);
    };
    c.subscribers.add(send);
    const ping = setInterval(() => { try { reply.raw.write(`: ping\n\n`); } catch {} }, 15000);
    req.raw.on("close", () => {
      clearInterval(ping);
      c.subscribers.delete(send);
    });
    return reply;
  });

  app.get("/api/groups2/:id/blackboard", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.getGroup(id)) { reply.code(404); return { error: "not found" }; }
    const q = req.query as { label?: string };
    const c = getCtl(id, chatOpts);
    const label = q.label ?? "shared";
    try {
      let text = "";
      if (label === "meta") text = await c.blackboard.readMeta();
      else if (label === "shared") text = await c.blackboard.readShared();
      else if (label.startsWith("agent:")) text = await c.blackboard.readAgentArea(label.slice(6));
      return { label, text };
    } catch (e: any) { return { label, text: "", error: e?.message ?? String(e) }; }
  });

  app.post("/api/chat-approvals/:reqId", async (req, reply) => {
    const { reqId } = req.params as { reqId: string };
    const body = req.body as { allow: boolean; message?: string };
    for (const c of ctls.values()) {
      const p = c.pendingApprovals.get(reqId);
      if (p) {
        c.pendingApprovals.delete(reqId);
        const resp: ApprovalResponse = body.allow
          ? { decision: "allow" }
          : { decision: "deny", message: body.message ?? "user denied via web chat" };
        p.resolve(resp);
        return { ok: true };
      }
    }
    reply.code(404); return { error: "approval not found or already resolved" };
  });
}
