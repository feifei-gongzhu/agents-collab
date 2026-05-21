// Thin client for /api/* endpoints exposed by @agents/server.

export interface GroupSummary {
  id: string;
  name: string;
  description?: string;
  mode: string;
  maxRounds: number;
  agents: string[];
  sourcePath: string;
}
export interface GroupDetail extends GroupSummary {
  moderatorId?: string;
  consensusMarker?: string;
  metaText?: string;
  agents: any;
}
export interface ProviderInfo {
  id: string;
  name: string;
  source: string;
  models: string[];
  env: Record<string, string>;
  meta?: Record<string, unknown>;
}
export interface SessionInfo {
  id: string;
  groupId: string;
  prompt: string;
  status: "running" | "finished" | "aborted" | "error";
  reason?: string;
  consensusBy?: string;
  rounds: number;
  startedAt: string;
  pendingApprovals: Array<{
    id: string;
    request: {
      actor: string;
      toolName: string;
      targetPath: string;
      classification: { role: string; ownerAgentId?: string };
      reason: string;
    };
  }>;
}
export interface StoredEvent {
  seq: number;
  ts: string;
  kind: string;
  payload: Record<string, any>;
}

const BASE = "/api";

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(BASE + url, init);
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`${r.status}: ${txt}`);
  }
  return r.json();
}

export const api = {
  listGroups: () => j<GroupSummary[]>("/groups"),
  getGroup: (id: string) => j<GroupDetail>(`/groups/${id}`),
  listProviders: () => j<ProviderInfo[]>("/providers"),
  listSessions: () => j<SessionInfo[]>("/sessions"),
  getSession: (id: string) => j<SessionInfo>(`/sessions/${id}`),
  createSession: (body: { groupId: string; prompt: string; maxRounds?: number; sessionId?: string }) =>
    j<SessionInfo>("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  resumeSession: (id: string, maxRounds?: number) =>
    j<SessionInfo>(`/sessions/${id}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxRounds }),
    }),
  abortSession: (id: string) =>
    j<{ ok: true }>(`/sessions/${id}/abort`, { method: "POST" }),
  readBlackboard: (id: string, label: string) =>
    j<{ label: string; body: string }>(
      `/sessions/${id}/blackboard?label=${encodeURIComponent(label)}`,
    ),
  listTurns: (id: string) =>
    j<{ turns: Array<{ file: string; round?: number; agentId?: string; body: string }> }>(
      `/sessions/${id}/turns`,
    ),
  approve: (reqId: string, allow: boolean, message?: string) =>
    j<{ ok: true }>(`/approvals/${reqId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow, message }),
    }),

  /** Subscribe to SSE; returns an unsubscribe fn. */
  subscribeEvents(
    id: string,
    onEvent: (ev: StoredEvent) => void,
    onEnd?: () => void,
    lastSeq = 0,
  ): () => void {
    const url = `${BASE}/sessions/${id}/events?lastSeq=${lastSeq}`;
    const es = new EventSource(url);
    es.onmessage = () => {
      // ignore unnamed messages
    };
    es.addEventListener("end", () => {
      es.close();
      onEnd?.();
    });
    const handler = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as StoredEvent;
        onEvent(data);
      } catch {
        // ignore
      }
    };
    // Fastify SSE attaches `event:` headers; subscribe to all known kinds.
    for (const kind of [
      "session-start", "round-start", "agent-speaking", "agent-spoke",
      "consensus-reached", "run-finished", "run-start",
      "approval-pending", "approval-resolved",
      "session-finished", "session-error", "session-aborted",
    ]) {
      es.addEventListener(kind, handler as any);
    }
    return () => es.close();
  },
};

// ============================================================================
//  Chat API — group chat with multiple AI members + moderator scheduling.
// ============================================================================

export interface ChatAgent {
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

export interface ChatGroup {
  id: string;
  name: string;
  emoji: string;
  description: string | null;
  moderatorAgentId: string | null;
  meta: string;
  memberIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: number;
  groupId: string;
  fromKind: "user" | "agent" | "moderator" | "system";
  fromAgentId: string | null;
  text: string;
  meta: any | null;
  ts: string;
}

export const chatApi = {
  // --- agents ---
  listAgents: () => j<ChatAgent[]>("/agents"),
  getAgent: (id: string) => j<ChatAgent>(`/agents/${id}`),
  createAgent: (body: Partial<ChatAgent> & { id: string; name: string; providerId: string }) =>
    j<ChatAgent>("/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  updateAgent: (id: string, body: Partial<ChatAgent>) =>
    j<ChatAgent>(`/agents/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  deleteAgent: (id: string) => j<{ ok: true }>(`/agents/${id}`, { method: "DELETE" }),

  // --- groups ---
  listGroups: () => j<ChatGroup[]>("/groups2"),
  getGroup: (id: string) => j<ChatGroup>(`/groups2/${id}`),
  createGroup: (body: Partial<ChatGroup> & { id: string; name: string }) =>
    j<ChatGroup>("/groups2", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  updateGroup: (id: string, body: Partial<ChatGroup>) =>
    j<ChatGroup>(`/groups2/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  deleteGroup: (id: string) => j<{ ok: true }>(`/groups2/${id}`, { method: "DELETE" }),

  // --- messages ---
  listMessages: (groupId: string, since = 0) =>
    j<ChatMessage[]>(`/groups2/${groupId}/messages?since=${since}`),
  postMessage: (groupId: string, text: string) =>
    j<ChatMessage>(`/groups2/${groupId}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  abortGroup: (groupId: string) =>
    j<{ ok: true }>(`/groups2/${groupId}/abort`, { method: "POST" }),
  readBlackboard: (groupId: string, label: string) =>
    j<{ label: string; text: string }>(`/groups2/${groupId}/blackboard?label=${encodeURIComponent(label)}`),
  approve: (reqId: string, allow: boolean, message?: string) =>
    j<{ ok: true }>(`/chat-approvals/${reqId}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow, message }),
    }),

  /** Subscribe to a group's stream. Returns unsubscribe. */
  subscribeStream(
    groupId: string,
    onEvent: (kind: string, payload: any) => void,
  ): () => void {
    const es = new EventSource(`${BASE}/groups2/${groupId}/stream`);
    const kinds = [
      "message", "moderator-decision", "agent-thinking", "agent-message",
      "scheduler-skip", "scheduler-warn", "scheduler-error", "scheduler-idle",
      "approval-pending",
    ];
    const h = (kind: string) => (e: MessageEvent) => {
      try { onEvent(kind, JSON.parse(e.data)); } catch {}
    };
    for (const k of kinds) es.addEventListener(k, h(k) as any);
    return () => es.close();
  },
};
