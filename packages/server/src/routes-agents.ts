/**
 * /api/agents — CRUD for agent definitions.
 *
 * Agents are stored in SQLite (see ./db.ts). The legacy configs/agents/*.json
 * are imported on first boot and ignored thereafter.
 */

import type { FastifyInstance } from "fastify";
import type { Db, AgentRow } from "./db.js";
import type { ProviderRegistry } from "@agents/core";

export interface AgentBody {
  id: string;
  name: string;
  emoji?: string;
  providerId: string;
  model?: string | null;
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  maxTurns?: number;
}

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function normalize(b: AgentBody): Omit<AgentRow, "createdAt" | "updatedAt"> {
  return {
    id: b.id,
    name: b.name?.trim() || b.id,
    emoji: b.emoji || "🤖",
    providerId: b.providerId,
    model: b.model ?? null,
    systemPrompt: b.systemPrompt ?? "",
    allowedTools: Array.isArray(b.allowedTools) ? b.allowedTools : [],
    disallowedTools: Array.isArray(b.disallowedTools) ? b.disallowedTools : [],
    permissionMode: b.permissionMode ?? "approve-dangerous",
    maxTurns: typeof b.maxTurns === "number" ? b.maxTurns : 8,
  };
}

async function validateProvider(reg: ProviderRegistry, providerId: string): Promise<string | null> {
  try { await reg.get(providerId); return null; }
  catch (e: any) { return e?.message ?? "provider lookup failed"; }
}

export function registerAgentRoutes(app: FastifyInstance, db: Db, reg: ProviderRegistry): void {
  app.get("/api/agents", async () => db.listAgents());

  app.get("/api/agents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = db.getAgent(id);
    if (!a) { reply.code(404); return { error: "not found" }; }
    return a;
  });

  app.post("/api/agents", async (req, reply) => {
    const b = req.body as AgentBody;
    if (!b?.id || !ID_RE.test(b.id)) { reply.code(400); return { error: "id required, [a-zA-Z0-9_-]{1,64}" }; }
    if (!b.name) { reply.code(400); return { error: "name required" }; }
    if (!b.providerId) { reply.code(400); return { error: "providerId required" }; }
    if (db.getAgent(b.id)) { reply.code(409); return { error: "id already exists" }; }
    const err = await validateProvider(reg, b.providerId);
    if (err) { reply.code(400); return { error: err }; }
    return db.upsertAgent(normalize(b));
  });

  app.put("/api/agents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = db.getAgent(id);
    if (!existing) { reply.code(404); return { error: "not found" }; }
    const b = { ...(req.body as AgentBody), id };
    if (!b.name) { reply.code(400); return { error: "name required" }; }
    if (!b.providerId) { reply.code(400); return { error: "providerId required" }; }
    const err = await validateProvider(reg, b.providerId);
    if (err) { reply.code(400); return { error: err }; }
    return db.upsertAgent(normalize(b));
  });

  app.delete("/api/agents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.getAgent(id)) { reply.code(404); return { error: "not found" }; }
    db.deleteAgent(id);
    return { ok: true };
  });
}
