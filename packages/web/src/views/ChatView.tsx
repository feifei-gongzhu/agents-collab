import { useEffect, useMemo, useRef, useState } from "react";
import { chatApi, type ChatAgent, type ChatGroup, type ChatMessage } from "../api.js";

interface PendingApproval {
  id: string;
  actor: string;
  toolName: string;
  targetPath: string;
  reason: string;
  classification: { role: string; ownerAgentId?: string };
}

export function ChatView() {
  const [groups, setGroups] = useState<ChatGroup[]>([]);
  const [agents, setAgents] = useState<ChatAgent[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(() =>
    localStorage.getItem("agents.activeGroup"));
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [thinkingId, setThinkingId] = useState<string | null>(null);
  const [schedulerStatus, setSchedulerStatus] = useState<string>("idle");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [showBlackboard, setShowBlackboard] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const agentMap = useMemo(() => {
    const m: Record<string, ChatAgent> = {};
    for (const a of agents) m[a.id] = a;
    return m;
  }, [agents]);

  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeGroupId) ?? null,
    [groups, activeGroupId],
  );

  // Initial load.
  useEffect(() => {
    Promise.all([chatApi.listGroups(), chatApi.listAgents()])
      .then(([gs, ags]) => {
        setGroups(gs); setAgents(ags);
        if (!activeGroupId && gs.length > 0) {
          setActiveGroupId(gs[0].id);
        }
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist active group.
  useEffect(() => {
    if (activeGroupId) localStorage.setItem("agents.activeGroup", activeGroupId);
  }, [activeGroupId]);

  // Load messages + subscribe stream when group changes.
  useEffect(() => {
    if (!activeGroupId) { setMessages([]); return; }
    let cancelled = false;
    chatApi.listMessages(activeGroupId).then((ms) => {
      if (cancelled) return;
      setMessages(ms);
    }).catch((e) => setError(String(e)));
    const off = chatApi.subscribeStream(activeGroupId, (kind, payload) => {
      if (kind === "message") {
        setMessages((prev) => prev.some((m) => m.id === payload.id) ? prev : [...prev, payload]);
      } else if (kind === "agent-thinking") {
        setThinkingId(payload.agentId);
      } else if (kind === "scheduler-idle") {
        setThinkingId(null); setSchedulerStatus("idle");
      } else if (kind === "scheduler-skip" || kind === "scheduler-warn") {
        setSchedulerStatus(`${kind}: ${payload.reason || ""}`);
      } else if (kind === "scheduler-error") {
        setSchedulerStatus(`error: ${payload.reason}`);
        setThinkingId(null);
      } else if (kind === "moderator-decision") {
        setSchedulerStatus(`主持人 → ${payload.next}`);
      } else if (kind === "approval-pending") {
        setPending(payload);
      }
    });
    return () => { cancelled = true; off(); };
  }, [activeGroupId]);

  // Auto-scroll on new messages.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, thinkingId]);

  async function send() {
    if (!draft.trim() || !activeGroupId) return;
    const text = draft.trim();
    setDraft("");
    setSchedulerStatus("发送中…");
    try {
      await chatApi.postMessage(activeGroupId, text);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  async function abort() {
    if (!activeGroupId) return;
    try { await chatApi.abortGroup(activeGroupId); } catch {}
  }

  async function decideApproval(allow: boolean) {
    if (!pending) return;
    try { await chatApi.approve(pending.id, allow); } catch (e: any) { setError(String(e)); }
    setPending(null);
  }

  return (
    <div className="chat-root">
      {/* Left: group list */}
      <aside className="chat-sidebar">
        <div className="chat-sidebar-head">群</div>
        {groups.length === 0 ? (
          <div className="muted" style={{ padding: 12 }}>
            暂无群。先去 <b>群管理</b> 标签创建。
          </div>
        ) : null}
        {groups.map((g) => (
          <div
            key={g.id}
            className={`chat-group-item ${activeGroupId === g.id ? "active" : ""}`}
            onClick={() => setActiveGroupId(g.id)}
          >
            <div className="chat-group-emoji">{g.emoji}</div>
            <div className="chat-group-meta">
              <div className="chat-group-name">{g.name}</div>
              <div className="chat-group-sub">{g.memberIds.length} 个 AI</div>
            </div>
          </div>
        ))}
      </aside>

      {/* Center: chat */}
      <section className="chat-main">
        {!activeGroup ? (
          <div className="chat-empty">
            <div style={{ fontSize: 48 }}>💬</div>
            <div>选一个群开始聊天</div>
            <div className="muted" style={{ marginTop: 8 }}>
              没有群？切到 <b>群管理</b> 标签新建一个，先在 <b>AI 管理</b> 添加 AI 成员。
            </div>
          </div>
        ) : (
          <>
            <header className="chat-header">
              <div className="chat-header-title">
                <span style={{ fontSize: 22 }}>{activeGroup.emoji}</span>
                <b>{activeGroup.name}</b>
                <span className="muted">{activeGroup.description ?? ""}</span>
              </div>
              <div className="chat-members">
                {activeGroup.memberIds.map((id) => {
                  const a = agentMap[id];
                  return (
                    <span key={id} className="chat-member" title={a?.name ?? id}>
                      {a?.emoji ?? "🤖"}
                    </span>
                  );
                })}
                {activeGroup.moderatorAgentId ? (
                  <span className="chat-member moderator" title={`主持人：${agentMap[activeGroup.moderatorAgentId]?.name}`}>
                    🎙️ {agentMap[activeGroup.moderatorAgentId]?.emoji ?? "?"}
                  </span>
                ) : null}
                <button onClick={() => setShowBlackboard(true)} title="查看黑板">📋 黑板</button>
                <button onClick={abort} title="终止当前调度循环">⏹ 中止</button>
              </div>
            </header>

            <div className="chat-status">{schedulerStatus}</div>

            <div ref={scrollerRef} className="chat-scroller">
              {messages.length === 0 ? (
                <div className="muted" style={{ padding: 24, textAlign: "center" }}>
                  还没有消息。在下面输入来开始。<br />
                  使用 <span className="kbd">@agent-id</span> 直接点名某个 AI（如 <span className="kbd">@recon</span>）。
                </div>
              ) : null}
              {messages.map((m) => (
                <MessageBubble key={m.id} m={m} agentMap={agentMap} />
              ))}
              {thinkingId ? (
                <div className="chat-thinking">
                  {agentMap[thinkingId]?.emoji ?? "🤖"} {agentMap[thinkingId]?.name ?? thinkingId} 正在输入…
                </div>
              ) : null}
            </div>

            <footer className="chat-input">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
                }}
                placeholder="输入消息…  Ctrl+Enter 发送  ·  @agent-id 点名"
                rows={3}
              />
              <button className="primary" onClick={send} disabled={!draft.trim()}>发送</button>
            </footer>
          </>
        )}
      </section>

      {pending ? (
        <div className="modal-bg">
          <div className="modal">
            <h3>需要审批：{agentMap[pending.actor]?.emoji ?? "🤖"} {agentMap[pending.actor]?.name ?? pending.actor}</h3>
            <div className="muted">这个 AI 想用工具：</div>
            <div>tool: <span className="kbd">{pending.toolName}</span></div>
            <div>target: <span className="kbd">{pending.targetPath}</span></div>
            <div>role: {pending.classification.role}{pending.classification.ownerAgentId ? ` (owner=${pending.classification.ownerAgentId})` : ""}</div>
            <div className="muted" style={{ marginTop: 8 }}>{pending.reason}</div>
            <div className="row">
              <button className="primary" onClick={() => decideApproval(true)}>允许</button>
              <button className="danger" onClick={() => decideApproval(false)}>拒绝</button>
            </div>
          </div>
        </div>
      ) : null}

      {showBlackboard && activeGroup ? (
        <BlackboardDrawer group={activeGroup} agentMap={agentMap} onClose={() => setShowBlackboard(false)} />
      ) : null}

      {error ? (
        <div className="chat-error" onClick={() => setError(null)}>错误（点击关闭）：{error}</div>
      ) : null}
    </div>
  );
}

function MessageBubble({ m, agentMap }: { m: ChatMessage; agentMap: Record<string, ChatAgent> }) {
  if (m.fromKind === "user") {
    return (
      <div className="msg msg-user">
        <div className="msg-body">{m.text}</div>
        <div className="msg-avatar">👤</div>
      </div>
    );
  }
  if (m.fromKind === "moderator") {
    return <div className="msg-moderator">🎙️ {m.text}</div>;
  }
  const a = m.fromAgentId ? agentMap[m.fromAgentId] : null;
  return (
    <div className="msg msg-agent">
      <div className="msg-avatar" title={a?.name ?? m.fromAgentId ?? ""}>{a?.emoji ?? "🤖"}</div>
      <div>
        <div className="msg-name">{a?.name ?? m.fromAgentId} · <span className="muted">{new Date(m.ts).toLocaleTimeString()}</span></div>
        <div className="msg-body">{m.text}</div>
      </div>
    </div>
  );
}

function BlackboardDrawer({ group, agentMap, onClose }: {
  group: ChatGroup;
  agentMap: Record<string, ChatAgent>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState<string>("shared");
  const [text, setText] = useState<string>("");
  useEffect(() => {
    chatApi.readBlackboard(group.id, label).then((r) => setText(r.text || "(空)")).catch((e) => setText(String(e)));
  }, [group.id, label]);
  const tabs = ["meta", "shared", ...group.memberIds.map((id) => `agent:${id}`)];
  return (
    <div className="bb-drawer">
      <div className="bb-head">
        <b>📋 黑板 · {group.name}</b>
        <button onClick={onClose}>关闭</button>
      </div>
      <div className="bb-tabs">
        {tabs.map((t) => (
          <button key={t} className={`bb-tab ${label === t ? "active" : ""}`} onClick={() => setLabel(t)}>
            {t.startsWith("agent:") ? `${agentMap[t.slice(6)]?.emoji ?? "🤖"} ${t.slice(6)}` : t}
          </button>
        ))}
      </div>
      <pre className="bb-body">{text}</pre>
    </div>
  );
}
