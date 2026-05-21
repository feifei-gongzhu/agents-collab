/**
 * /api/groups — CRUD for chat groups.
 *
 * Groups own a name/emoji/description, an optional moderator agent, a meta
 * (system prompt for the group), and a member list (agent ids in display order).
 */

import type { FastifyInstance } from "fastify";
import type { Db, GroupRow } from "./db.js";

export interface GroupBody {
  id: string;
  name: string;
  emoji?: string;
  description?: string | null;
  moderatorAgentId?: string | null;
  meta?: string;
  memberIds?: string[];
}

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function normalize(b: GroupBody): Omit<GroupRow, "createdAt" | "updatedAt"> {
  return {
    id: b.id,
    name: b.name?.trim() || b.id,
    emoji: b.emoji || "💬",
    description: b.description ?? null,
    moderatorAgentId: b.moderatorAgentId ?? null,
    meta: b.meta ?? "",
    memberIds: Array.isArray(b.memberIds) ? b.memberIds : [],
  };
}

function validateMembers(db: Db, ids: string[]): string | null {
  for (const aid of ids) {
    if (!db.getAgent(aid)) return `member agent "${aid}" does not exist`;
  }
  return null;
}

export function registerGroupRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/groups2", async () => db.listGroups());

  app.get("/api/groups2/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const g = db.getGroup(id);
    if (!g) { reply.code(404); return { error: "not found" }; }
    return g;
  });

  app.post("/api/groups2", async (req, reply) => {
    const b = req.body as GroupBody;
    if (!b?.id || !ID_RE.test(b.id)) { reply.code(400); return { error: "id required, [a-zA-Z0-9_-]{1,64}" }; }
    if (!b.name) { reply.code(400); return { error: "name required" }; }
    if (db.getGroup(b.id)) { reply.code(409); return { error: "id already exists" }; }
    const memberIds = Array.isArray(b.memberIds) ? b.memberIds : [];
    const merr = validateMembers(db, memberIds);
    if (merr) { reply.code(400); return { error: merr }; }
    if (b.moderatorAgentId && !db.getAgent(b.moderatorAgentId)) {
      reply.code(400); return { error: `moderator "${b.moderatorAgentId}" does not exist` };
    }
    return db.upsertGroup(normalize(b));
  });

  app.put("/api/groups2/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = db.getGroup(id);
    if (!existing) { reply.code(404); return { error: "not found" }; }
    const b = { ...(req.body as GroupBody), id };
    if (!b.name) { reply.code(400); return { error: "name required" }; }
    const memberIds = Array.isArray(b.memberIds) ? b.memberIds : [];
    const merr = validateMembers(db, memberIds);
    if (merr) { reply.code(400); return { error: merr }; }
    if (b.moderatorAgentId && !db.getAgent(b.moderatorAgentId)) {
      reply.code(400); return { error: `moderator "${b.moderatorAgentId}" does not exist` };
    }
    return db.upsertGroup(normalize(b));
  });

  app.delete("/api/groups2/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.getGroup(id)) { reply.code(404); return { error: "not found" }; }
    db.deleteGroup(id);
    return { ok: true };
  });

  app.post("/api/groups2/:id/members", async (req, reply) => {
    const { id } = req.params as { id: string };
    const g = db.getGroup(id);
    if (!g) { reply.code(404); return { error: "not found" }; }
    const body = req.body as { memberIds: string[] };
    const ids = Array.isArray(body?.memberIds) ? body.memberIds : [];
    const merr = validateMembers(db, ids);
    if (merr) { reply.code(400); return { error: merr }; }
    db.setGroupMembers(id, ids);
    return db.getGroup(id);
  });
}
