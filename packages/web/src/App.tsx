import { useEffect, useMemo, useState } from "react";
import { api, type GroupSummary, type SessionInfo, type StoredEvent } from "./api.js";

// Renamed export so the new Shell can mount this as the legacy "Observatory" view.
export { App as ObservatoryApp };

interface PendingApproval {
  id: string;
  actor: string;
  toolName: string;
  targetPath: string;
  reason: string;
  classification: { role: string; ownerAgentId?: string };
}

const GROUP_HINTS: Record<string, { useCase: string; example: string }> = {
  "dual-debate": {
    useCase: "把一个有争议的问题交给 Pro/Con 辩论，Judge 仲裁出结论",
    example: "讨论：在中型创业公司，是否应该把生产 K8s 换成 Nomad？",
  },
  pentest: {
    useCase: "侦察 → 漏洞挖掘 → 利用 → 报告，按红队工作流轮转",
    example: "评估 https://target.example.com 的对外攻击面，重点关注鉴权与上传接口",
  },
  "trio-review": {
    useCase: "Writer 起草 / Reviewer 评审 / Critic 异议，自由 @-mention",
    example: "起草一份《2026 Q1 团队 OKR 草案》，含 3 个 Objective 与 9 个 KR",
  },
  "red-blue": {
    useCase: "Red 给攻击路径，Blue 给检测与处置，对抗式输出",
    example: "假设我们运行一台暴露 SSH/Nginx 的 VPS，演练一次入侵 + 检测剧本",
  },
};

const TAB_HINTS: Record<string, string> = {
  events: "实时事件流：每个 agent 的发言、轮次切换、错误、审批请求",
  blackboard: "共享黑板：meta 是初始任务；shared 由编排器写；agent:<id> 是各 agent 的私有发言",
  turns: "轮次记录：按顺序展开每一轮的完整发言文本",
};

export function App() {
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [maxRounds, setMaxRounds] = useState<string>("");
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [bbLabel, setBbLabel] = useState<string>("meta");
  const [bbBody, setBbBody] = useState<string>("");
  const [tab, setTab] = useState<"events" | "blackboard" | "turns">("events");
  const [turns, setTurns] = useState<Array<{ file: string; round?: number; agentId?: string; body: string }>>([]);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [helpOpen, setHelpOpen] = useState<boolean>(false);

  // Load groups on boot.
  useEffect(() => {
    api.listGroups().then((gs) => {
      setGroups(gs);
      if (gs.length > 0 && !selectedGroup) setSelectedGroup(gs[0].id);
    }).catch((e) => setError(String(e)));
    try {
      if (!localStorage.getItem("agents.helpSeen")) {
        setHelpOpen(true);
        localStorage.setItem("agents.helpSeen", "1");
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to SSE when session id changes.
  useEffect(() => {
    if (!session) return;
    setEvents([]);
    const off = api.subscribeEvents(session.id, (ev) => {
      setEvents((cur) => [...cur, ev]);
      if (ev.kind === "approval-pending") {
        setPending({
          id: String(ev.payload.id),
          actor: String(ev.payload.actor),
          toolName: String(ev.payload.toolName),
          targetPath: String(ev.payload.targetPath),
          reason: String(ev.payload.reason ?? ""),
          classification: ev.payload.classification ?? { role: "unknown" },
        });
      } else if (ev.kind === "approval-resolved") {
        setPending((cur) => (cur && cur.id === String(ev.payload.id) ? null : cur));
      } else if (ev.kind === "session-finished" || ev.kind === "session-error" || ev.kind === "session-aborted") {
        api.getSession(session.id).then(setSession).catch(() => {});
      } else if (ev.kind === "agent-spoke") {
        // refresh blackboard panel after each turn
        if (tab === "blackboard") loadBlackboard(session.id, bbLabel);
        if (tab === "turns") loadTurns(session.id);
      }
    });
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  const loadBlackboard = async (sid: string, label: string) => {
    try {
      const r = await api.readBlackboard(sid, label);
      setBbBody(r.body);
    } catch (e) {
      setBbBody(`(error: ${(e as Error).message})`);
    }
  };
  const loadTurns = async (sid: string) => {
    try {
      const r = await api.listTurns(sid);
      setTurns(r.turns);
    } catch (e) {
      setTurns([]);
      setError(String(e));
    }
  };

  // Refresh blackboard / turns when tab or label changes.
  useEffect(() => {
    if (!session) return;
    if (tab === "blackboard") loadBlackboard(session.id, bbLabel);
    else if (tab === "turns") loadTurns(session.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, bbLabel, session?.id]);

  const startRun = async () => {
    setError(null);
    if (!selectedGroup) {
      setError("先选一个群组");
      return;
    }
    if (!prompt.trim()) {
      setError("提示不能为空");
      return;
    }
    try {
      const sess = await api.createSession({
        groupId: selectedGroup,
        prompt: prompt.trim(),
        maxRounds: maxRounds ? Number(maxRounds) : undefined,
      });
      setSession(sess);
      setEvents([]);
      setTab("events");
    } catch (e) {
      setError(String(e));
    }
  };

  const abortRun = async () => {
    if (!session) return;
    await api.abortSession(session.id);
  };

  const decide = async (allow: boolean) => {
    if (!pending) return;
    try {
      await api.approve(pending.id, allow);
      setPending(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const blackboardLabels = useMemo(() => {
    const base = ["meta", "shared"];
    if (!session) return base;
    const g = groups.find((g) => g.id === session.groupId);
    if (!g) return base;
    return [...base, ...g.agents.map((a) => `agent:${a}`)];
  }, [groups, session]);

  return (
    <div className="app">
      <div className="topbar">
        <div className="row">
          <h1>Agents · 多 AI 黑板架构</h1>
          <span className="muted" style={{ fontSize: 12 }}>
            选群组 → 写任务 → 启动；右上角随时点 <b>使用指南</b>
          </span>
          {session ? (
            <span className="badge">
              session=<span className="kbd">{session.id}</span>
              {" · "}
              <span className={`status-${session.status}`}>{session.status}</span>
              {session.reason ? ` (${session.reason})` : ""}
              {" · 第 "}{session.rounds}{" 轮"}
            </span>
          ) : (
            <span className="badge">未启动</span>
          )}
        </div>
        <div className="row">
          <button onClick={() => setHelpOpen(true)} title="弹出使用指南">使用指南</button>
          {session && session.status === "running" ? (
            <button className="danger" onClick={abortRun} title="终止当前会话（产物保留在 workspaces/）">中止</button>
          ) : null}
          {session && session.status !== "running" ? (
            <button onClick={() => api.resumeSession(session.id).then(setSession).catch((e) => setError(String(e)))} title="基于现有黑板继续下一轮">
              续跑
            </button>
          ) : null}
          {session ? <button onClick={() => { setSession(null); setEvents([]); }} title="清空当前会话视图，准备新建">新会话</button> : null}
        </div>
      </div>

      <div className="main">
        {/* LEFT — group + prompt */}
        <div className="col">
          <h2>第 1 步 · 选群组</h2>
          {groups.length === 0 ? <div className="muted">读取中…（如果一直转，检查 /api/groups）</div> : null}
          {groups.map((g) => {
            const hint = GROUP_HINTS[g.id];
            return (
              <div
                key={g.id}
                className={`card ${selectedGroup === g.id ? "selected" : ""}`}
                onClick={() => setSelectedGroup(g.id)}
                style={{ cursor: "pointer" }}
              >
                <h3>{g.name}</h3>
                <div className="muted">{g.description ?? "(no description)"}</div>
                {hint ? (
                  <div className="muted" style={{ marginTop: 4, color: "var(--text)", fontSize: 12 }}>
                    适用：{hint.useCase}
                  </div>
                ) : null}
                <div style={{ marginTop: 6 }}>
                  <span className="tag" title="调度模式：round-robin 顺序轮转 / moderator 指定主持人 / free 自由 @-mention">{g.mode}</span>
                  <span className="tag" title="单次会话最多跑多少轮">maxRounds={g.maxRounds}</span>
                  <span className="tag">{g.agents.length} 个 agent</span>
                </div>
                <div className="muted" style={{ marginTop: 4 }}>{g.agents.join(" · ")}</div>
                {hint && selectedGroup === g.id ? (
                  <button
                    style={{ marginTop: 8, fontSize: 12 }}
                    onClick={(e) => { e.stopPropagation(); setPrompt(hint.example); }}
                    title="把示例任务填入下方输入框"
                  >
                    填入示例任务
                  </button>
                ) : null}
              </div>
            );
          })}

          <h2 style={{ marginTop: 16 }}>第 2 步 · 写任务并启动</h2>
          <div className="field">
            <label>初始提示（这条会写入黑板 meta，被所有 agent 看见）</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                selectedGroup && GROUP_HINTS[selectedGroup]
                  ? `示例：${GROUP_HINTS[selectedGroup].example}`
                  : "用一两句话说清楚目标和边界。例如：评估 https://example.com 的攻击面…"
              }
            />
          </div>
          <div className="field">
            <label>最大轮次（可选；留空使用群组默认值）</label>
            <input
              type="number"
              value={maxRounds}
              onChange={(e) => setMaxRounds(e.target.value)}
              placeholder={selectedGroup ? `默认 ${groups.find(g=>g.id===selectedGroup)?.maxRounds ?? "?"}` : "默认 ?"}
            />
          </div>
          <button className="primary" onClick={startRun} disabled={!!session && session.status === "running"}>
            启动
          </button>
          <div className="muted" style={{ marginTop: 6 }}>
            启动后中间栏会出现实时事件流。需要工具审批时右上角弹窗。
          </div>
          {error ? <div style={{ color: "var(--red)", marginTop: 8 }}>{error}</div> : null}
        </div>

        {/* MIDDLE — timeline */}
        <div className="col">
          <div className="tabs">
            <div className={`tab ${tab === "events" ? "active" : ""}`} onClick={() => setTab("events")} title={TAB_HINTS.events}>事件流</div>
            <div className={`tab ${tab === "blackboard" ? "active" : ""}`} onClick={() => setTab("blackboard")} title={TAB_HINTS.blackboard}>黑板</div>
            <div className={`tab ${tab === "turns" ? "active" : ""}`} onClick={() => setTab("turns")} title={TAB_HINTS.turns}>转译记录</div>
          </div>
          <div className="muted" style={{ marginBottom: 8 }}>{TAB_HINTS[tab]}</div>

          {tab === "events" ? (
            <div className="timeline">
              {events.length === 0 ? <div className="muted">{session ? "等待第一个事件…（agent 启动 + 首次发言可能需要 5-15 秒）" : "还没有会话。先在左栏选群组、写任务、点启动。"}</div> : null}
              {events.map((ev) => (
                <div className={`event kind-${ev.kind}`} key={ev.seq}>
                  <div className="head">
                    <span className="kbd">#{ev.seq}</span>
                    {" "}
                    <span style={{ color: "var(--accent)" }}>{ev.kind}</span>
                    {ev.payload.round ? <> · round={ev.payload.round}</> : null}
                    {ev.payload.agentId ? <> · agent={ev.payload.agentId}</> : null}
                    {ev.payload.reason ? <> · reason={ev.payload.reason}</> : null}
                    {" · "}
                    <span style={{ color: "var(--muted)" }}>{new Date(ev.ts).toLocaleTimeString()}</span>
                  </div>
                  {ev.payload.text ? <div className="body">{ev.payload.text}</div> : null}
                  {ev.payload.message ? <div className="body" style={{ color: "var(--red)" }}>{ev.payload.message}</div> : null}
                  {ev.kind === "approval-pending" ? (
                    <div className="body">
                      actor={ev.payload.actor} · tool={ev.payload.toolName}
                      {"\n"}target={ev.payload.targetPath}
                      {"\n"}reason={ev.payload.reason}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {tab === "blackboard" && session ? (
            <>
              <div className="tabs">
                {blackboardLabels.map((lbl) => (
                  <div key={lbl} className={`tab ${bbLabel === lbl ? "active" : ""}`} onClick={() => setBbLabel(lbl)}>
                    {lbl}
                  </div>
                ))}
              </div>
              <pre className="code">{bbBody || "(empty)"}</pre>
            </>
          ) : tab === "blackboard" ? (
            <div className="muted">没有活动会话</div>
          ) : null}

          {tab === "turns" && session ? (
            <div className="timeline">
              {turns.length === 0 ? <div className="muted">尚无转译</div> : null}
              {turns.map((t) => (
                <div className="event kind-agent-spoke" key={t.file}>
                  <div className="head">
                    <span className="kbd">{t.file}</span>
                    {t.round ? <> · round={t.round}</> : null}
                    {t.agentId ? <> · agent={t.agentId}</> : null}
                  </div>
                  <div className="body">{t.body}</div>
                </div>
              ))}
            </div>
          ) : tab === "turns" ? (
            <div className="muted">没有活动会话</div>
          ) : null}
        </div>

        {/* RIGHT — agents card / status */}
        <div className="col">
          <h2>第 3 步 · 状态与审批</h2>
          {!session ? (
            <div>
              <div className="card">
                <h3>接下来会发生什么</h3>
                <div className="muted" style={{ whiteSpace: "pre-wrap", fontSize: 12.5, lineHeight: 1.7 }}>
{`1. 启动后 server 起一个会话，按群组里的调度模式
   逐轮唤起 agent；
2. 每个 agent 是一个独立的 Claude Code 子进程，
   有自己的 cwd 和工具权限；
3. agent 的发言追加到黑板（meta / shared / agent:<id>）；
4. agent 想写文件、跑命令时，server 会发出
   "审批请求"，本面板会弹模态框；
5. 达到 maxRounds 或调度器判定收敛即结束。
   产物落在 workspaces/<session-id>/。`}
                </div>
              </div>
              <div className="card">
                <h3>常见问题</h3>
                <div className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
                  <div>• 启动后没事件？检查容器日志 <span className="kbd">docker logs -f agents-web</span></div>
                  <div>• Agent 卡住？多半是 provider 网络/额度问题，先试 <span className="kbd">/api/providers</span></div>
                  <div>• 想换 provider？编辑 <span className="kbd">configs/agents/&lt;id&gt;.json</span> 的 providerId，重启容器</div>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <div className="card">
                <h3>当前会话</h3>
                <div className="muted">id: {session.id}</div>
                <div className="muted">group: {session.groupId}</div>
                <div className="muted">prompt: {session.prompt.slice(0, 200)}</div>
                <div className="muted">started: {new Date(session.startedAt).toLocaleString()}</div>
              </div>

              {(() => {
                const g = groups.find((g) => g.id === session.groupId);
                if (!g) return null;
                const lastByAgent = new Map<string, StoredEvent>();
                for (const ev of events) {
                  if (ev.kind === "agent-spoke" && ev.payload.agentId) {
                    lastByAgent.set(String(ev.payload.agentId), ev);
                  }
                }
                const speaking = events.findLast?.((e) => e.kind === "agent-speaking")?.payload.agentId;
                return g.agents.map((id) => {
                  const last = lastByAgent.get(id);
                  const isSpeaking = id === speaking && session.status === "running";
                  const status = isSpeaking ? "speaking" : last ? "spoke" : "idle";
                  return (
                    <div className="card" key={id}>
                      <h3>
                        {id}
                        {" "}
                        <span className="tag" style={{
                          color: status === "speaking" ? "var(--yellow)" :
                                 status === "spoke" ? "var(--green)" : "var(--muted)",
                        }}>{status}</span>
                      </h3>
                      {last ? (
                        <div className="body" style={{ fontSize: 12, color: "var(--muted)", maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap" }}>
                          {String(last.payload.text ?? "").slice(0, 800)}
                        </div>
                      ) : <div className="muted">(no speech yet)</div>}
                    </div>
                  );
                });
              })()}

              {session.pendingApprovals.length > 0 ? (
                <div className="card" style={{ borderColor: "var(--red)" }}>
                  <h3 style={{ color: "var(--red)" }}>待审批</h3>
                  {session.pendingApprovals.map((p) => (
                    <div key={p.id} className="muted">
                      [{p.id}] {p.request.actor} → {p.request.toolName} · {p.request.targetPath}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {pending ? (
        <div className="modal-bg">
          <div className="modal">
            <h3>需要审批：agent 想调用工具</h3>
            <div className="muted" style={{ marginBottom: 8 }}>
              这是 Claude Code 的 canUseTool 钩子触发的。允许 = 工具执行；拒绝 = 工具被拒，agent 得到 deny 提示后可改写策略。
            </div>
            <div>actor: <span className="kbd">{pending.actor}</span></div>
            <div>tool: <span className="kbd">{pending.toolName}</span></div>
            <div>target: <span className="kbd">{pending.targetPath}</span></div>
            <div>role: {pending.classification.role}{pending.classification.ownerAgentId ? ` (owner=${pending.classification.ownerAgentId})` : ""}</div>
            <div className="muted" style={{ marginTop: 8 }}>{pending.reason}</div>
            <div className="row">
              <button className="primary" onClick={() => decide(true)}>允许</button>
              <button className="danger" onClick={() => decide(false)}>拒绝</button>
            </div>
          </div>
        </div>
      ) : null}

      {helpOpen ? (
        <div className="modal-bg" onClick={() => setHelpOpen(false)}>
          <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
            <div className="row between">
              <h3 style={{ color: "var(--accent)", margin: 0 }}>使用指南</h3>
              <button onClick={() => setHelpOpen(false)}>关闭</button>
            </div>
            <h4 style={{ marginTop: 12 }}>1. 这是什么</h4>
            <div className="muted">
              基于 Claude Code 的多 Agent 协作平台。每个 agent 是独立的 Claude 子进程，
              通过共享黑板（append-only）和编排器协作。Web 这一层是观察 + 操作面板。
            </div>
            <h4>2. 三步上手</h4>
            <ol className="muted" style={{ paddingLeft: 18 }}>
              <li>左栏选一个群组；<b>选中后</b>会出现"填入示例任务"按钮</li>
              <li>写好初始提示，点启动</li>
              <li>中间栏看事件流；右栏看 agent 状态；工具调用会弹审批框</li>
            </ol>
            <h4>3. 群组速查表</h4>
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
              <thead><tr style={{ color: "var(--muted)" }}>
                <th align="left">群组</th><th align="left">何时用</th>
              </tr></thead>
              <tbody>
                {Object.entries(GROUP_HINTS).map(([k, v]) => (
                  <tr key={k} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "6px 0" }}><span className="kbd">{k}</span></td>
                    <td>{v.useCase}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h4>4. 黑板的三种区域</h4>
            <ul className="muted" style={{ paddingLeft: 18 }}>
              <li><b>meta</b> — 你给的初始任务，所有 agent 只读</li>
              <li><b>shared</b> — 编排器/主持人写的全局摘要、共识、轮次结论</li>
              <li><b>agent:&lt;id&gt;</b> — 单个 agent 自己的发言区，append-only 不能改别人</li>
            </ul>
            <h4>5. 调度模式</h4>
            <ul className="muted" style={{ paddingLeft: 18 }}>
              <li><b>round-robin</b> — 按 agents 顺序轮转（pentest 用这个）</li>
              <li><b>moderator</b> — 指定一个 agent 决定下一手（dual-debate 的 Judge）</li>
              <li><b>free</b> — 通过黑板里 @-mention 自由调度</li>
            </ul>
            <h4>6. 关于审批</h4>
            <div className="muted">
              当 agent 想写文件、执行 Bash、访问宿主网络时会触发审批弹窗。
              拒绝是安全的——agent 收到 deny 后通常会换思路，不会崩。
            </div>
            <h4>7. 文件落盘</h4>
            <div className="muted">
              所有产物都在 <span className="kbd">workspaces/&lt;session-id&gt;/</span>：
              黑板（<span className="kbd">blackboard/</span>）、各 agent cwd（<span className="kbd">agents/&lt;id&gt;/</span>）、
              会话元数据（<span className="kbd">session.json</span>）、轮次日志（<span className="kbd">turn-log.jsonl</span>）。
            </div>
            <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
              <button className="primary" onClick={() => setHelpOpen(false)}>知道了</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
