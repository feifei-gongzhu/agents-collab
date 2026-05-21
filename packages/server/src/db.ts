/**
 * SQLite-backed persistence for agents/groups/messages.
 *
 * Uses node:sqlite (Node 22 experimental, stable enough). The DB file lives at
 * AGENTS_DB_PATH (default: <projectRoot>/workspaces/agents.db). On first boot we
 * import existing JSON configs from configs/agents/*.json and configs/groups/*.json
 * so users keep their starter set after upgrading.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type FromKind = "user" | "agent" | "moderator" | "system";

export interface AgentRow {
  id: string;
  name: string;
  emoji: string;
  providerId: string;
  model: string | null;
  systemPrompt: string;
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: string;
  maxTurns: number;
  createdAt: string;
  updatedAt: string;
}

export interface GroupRow {
  id: string;
  name: string;
  emoji: string;
  description: string | null;
  moderatorAgentId: string | null;
  meta: string;
  createdAt: string;
  updatedAt: string;
  memberIds: string[];
}

export interface MessageRow {
  id: number;
  groupId: string;
  fromKind: FromKind;
  fromAgentId: string | null;
  text: string;
  meta: Record<string, any> | null;
  ts: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🤖',
  provider_id TEXT NOT NULL,
  model TEXT,
  system_prompt TEXT NOT NULL DEFAULT '',
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  disallowed_tools TEXT NOT NULL DEFAULT '[]',
  permission_mode TEXT NOT NULL DEFAULT 'approve-dangerous',
  max_turns INTEGER NOT NULL DEFAULT 8,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '💬',
  description TEXT,
  moderator_agent_id TEXT,
  meta TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  sort_index INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, agent_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  from_kind TEXT NOT NULL,
  from_agent_id TEXT,
  text TEXT NOT NULL,
  meta TEXT,
  ts TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_group_ts ON messages(group_id, ts);
`;

const DEFAULT_EMOJI: Record<string, string> = {
  recon: "🔭", vuln: "🐛", exploit: "💥", report: "📝",
  judge: "⚖️", pro: "👍", con: "👎",
  writer: "✍️", reviewer: "🔍", critic: "🧐",
  red: "🟥", blue: "🟦",
  moderator: "🎙️",
};
const GROUP_EMOJI: Record<string, string> = {
  pentest: "🎯", "dual-debate": "🥊", "trio-review": "📑", "red-blue": "⚔️",
};

export class Db {
  readonly path: string;
  private readonly raw: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec(SCHEMA);
  }

  close(): void { this.raw.close(); }

  // ---- agents ----
  listAgents(): AgentRow[] {
    return (this.raw.prepare(`SELECT * FROM agents ORDER BY name`).all() as any[])
      .map(rowToAgent);
  }
  getAgent(id: string): AgentRow | null {
    const row = this.raw.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as any;
    return row ? rowToAgent(row) : null;
  }
  upsertAgent(a: Omit<AgentRow, "createdAt" | "updatedAt"> & Partial<Pick<AgentRow, "createdAt" | "updatedAt">>): AgentRow {
    const now = new Date().toISOString();
    const existing = this.getAgent(a.id);
    const createdAt = existing?.createdAt ?? a.createdAt ?? now;
    const updatedAt = now;
    this.raw.prepare(`
      INSERT INTO agents (id,name,emoji,provider_id,model,system_prompt,allowed_tools,disallowed_tools,permission_mode,max_turns,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, emoji=excluded.emoji, provider_id=excluded.provider_id,
        model=excluded.model, system_prompt=excluded.system_prompt,
        allowed_tools=excluded.allowed_tools, disallowed_tools=excluded.disallowed_tools,
        permission_mode=excluded.permission_mode, max_turns=excluded.max_turns,
        updated_at=excluded.updated_at
    `).run(
      a.id, a.name, a.emoji, a.providerId, a.model ?? null, a.systemPrompt,
      JSON.stringify(a.allowedTools), JSON.stringify(a.disallowedTools),
      a.permissionMode, a.maxTurns, createdAt, updatedAt,
    );
    return this.getAgent(a.id)!;
  }
  deleteAgent(id: string): boolean {
    const r = this.raw.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
    this.raw.prepare(`DELETE FROM group_members WHERE agent_id = ?`).run(id);
    return (r.changes ?? 0) > 0;
  }

  // ---- groups ----
  listGroups(): GroupRow[] {
    const rows = this.raw.prepare(`SELECT * FROM groups ORDER BY name`).all() as any[];
    return rows.map((r) => this.hydrateGroup(r));
  }
  getGroup(id: string): GroupRow | null {
    const r = this.raw.prepare(`SELECT * FROM groups WHERE id = ?`).get(id) as any;
    return r ? this.hydrateGroup(r) : null;
  }
  private hydrateGroup(r: any): GroupRow {
    const members = (this.raw.prepare(`SELECT agent_id FROM group_members WHERE group_id = ? ORDER BY sort_index, agent_id`).all(r.id) as any[]).map((x) => x.agent_id);
    return {
      id: r.id, name: r.name, emoji: r.emoji,
      description: r.description, moderatorAgentId: r.moderator_agent_id,
      meta: r.meta, createdAt: r.created_at, updatedAt: r.updated_at,
      memberIds: members,
    };
  }
  upsertGroup(g: Omit<GroupRow, "createdAt" | "updatedAt"> & Partial<Pick<GroupRow, "createdAt" | "updatedAt">>): GroupRow {
    const now = new Date().toISOString();
    const existing = this.getGroup(g.id);
    const createdAt = existing?.createdAt ?? g.createdAt ?? now;
    this.raw.prepare(`
      INSERT INTO groups (id,name,emoji,description,moderator_agent_id,meta,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, emoji=excluded.emoji, description=excluded.description,
        moderator_agent_id=excluded.moderator_agent_id, meta=excluded.meta,
        updated_at=excluded.updated_at
    `).run(g.id, g.name, g.emoji, g.description ?? null, g.moderatorAgentId ?? null, g.meta, createdAt, now);
    this.setGroupMembers(g.id, g.memberIds);
    return this.getGroup(g.id)!;
  }
  setGroupMembers(groupId: string, agentIds: string[]): void {
    this.raw.prepare(`DELETE FROM group_members WHERE group_id = ?`).run(groupId);
    const stmt = this.raw.prepare(`INSERT INTO group_members (group_id, agent_id, sort_index) VALUES (?, ?, ?)`);
    agentIds.forEach((aid, i) => stmt.run(groupId, aid, i));
  }
  deleteGroup(id: string): boolean {
    const r = this.raw.prepare(`DELETE FROM groups WHERE id = ?`).run(id);
    this.raw.prepare(`DELETE FROM group_members WHERE group_id = ?`).run(id);
    this.raw.prepare(`DELETE FROM messages WHERE group_id = ?`).run(id);
    return (r.changes ?? 0) > 0;
  }

  // ---- messages ----
  listMessages(groupId: string, sinceId = 0, limit = 500): MessageRow[] {
    return (this.raw.prepare(
      `SELECT * FROM messages WHERE group_id = ? AND id > ? ORDER BY id ASC LIMIT ?`
    ).all(groupId, sinceId, limit) as any[]).map(rowToMessage);
  }
  appendMessage(m: Omit<MessageRow, "id" | "ts"> & { ts?: string }): MessageRow {
    const ts = m.ts ?? new Date().toISOString();
    const r = this.raw.prepare(`
      INSERT INTO messages (group_id, from_kind, from_agent_id, text, meta, ts)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(m.groupId, m.fromKind, m.fromAgentId ?? null, m.text, m.meta ? JSON.stringify(m.meta) : null, ts);
    const id = Number(r.lastInsertRowid);
    return { id, ts, ...m, meta: m.meta ?? null, fromAgentId: m.fromAgentId ?? null };
  }
  countMessages(groupId: string): number {
    const r = this.raw.prepare(`SELECT COUNT(*) AS n FROM messages WHERE group_id = ?`).get(groupId) as any;
    return Number(r?.n ?? 0);
  }
}

function rowToAgent(r: any): AgentRow {
  return {
    id: r.id, name: r.name, emoji: r.emoji,
    providerId: r.provider_id, model: r.model,
    systemPrompt: r.system_prompt,
    allowedTools: safeJson(r.allowed_tools, []),
    disallowedTools: safeJson(r.disallowed_tools, []),
    permissionMode: r.permission_mode, maxTurns: r.max_turns,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function rowToMessage(r: any): MessageRow {
  return {
    id: r.id, groupId: r.group_id, fromKind: r.from_kind,
    fromAgentId: r.from_agent_id, text: r.text,
    meta: r.meta ? safeJson(r.meta, null) : null, ts: r.ts,
  };
}
function safeJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

/**
 * Migrate legacy configs/agents/*.json + configs/groups/*.json into the DB on first run.
 * Idempotent: skips agents/groups that already exist.
 */
export function migrateLegacyConfigs(db: Db, projectRoot: string): { agents: number; groups: number } {
  const out = { agents: 0, groups: 0 };
  const agentsDir = join(projectRoot, "configs", "agents");
  const groupsDir = join(projectRoot, "configs", "groups");

  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir).filter((x) => x.endsWith(".json"))) {
      try {
        const j = JSON.parse(readFileSync(join(agentsDir, f), "utf-8"));
        if (!j.id || db.getAgent(j.id)) continue;
        const sp = readSystemPrompt(projectRoot, agentsDir, j.systemPromptFile);
        db.upsertAgent({
          id: j.id, name: j.name ?? j.id,
          emoji: DEFAULT_EMOJI[j.id] ?? "🤖",
          providerId: j.providerId ?? "ikunn",
          model: j.model ?? null,
          systemPrompt: sp,
          allowedTools: j.allowedTools ?? [],
          disallowedTools: j.disallowedTools ?? [],
          permissionMode: j.permissionMode ?? "approve-dangerous",
          maxTurns: j.maxTurns ?? 8,
        });
        out.agents++;
      } catch { /* skip */ }
    }
  }
  if (existsSync(groupsDir)) {
    for (const f of readdirSync(groupsDir).filter((x) => x.endsWith(".json"))) {
      try {
        const j = JSON.parse(readFileSync(join(groupsDir, f), "utf-8"));
        if (!j.id || db.getGroup(j.id)) continue;
        const meta = readSystemPrompt(projectRoot, groupsDir, j.metaFile);
        db.upsertGroup({
          id: j.id, name: j.name ?? j.id,
          emoji: GROUP_EMOJI[j.id] ?? "💬",
          description: j.description ?? null,
          moderatorAgentId: j.moderatorId ?? null,
          meta,
          memberIds: Array.isArray(j.agents) ? j.agents : [],
        });
        out.groups++;
      } catch { /* skip */ }
    }
  }
  return out;
}

function readSystemPrompt(projectRoot: string, baseDir: string, ref?: string): string {
  if (!ref) return "";
  try {
    const p = ref.startsWith("..") || ref.startsWith("/")
      ? join(baseDir, ref)
      : join(projectRoot, ref);
    return readFileSync(p, "utf-8");
  } catch { return ""; }
}
