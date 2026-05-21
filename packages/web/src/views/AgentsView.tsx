import { useEffect, useState } from "react";
import { chatApi, type ChatAgent, type ProviderInfo, api } from "../api.js";
import { EmojiPicker } from "../components/EmojiPicker.js";

const TOOL_OPTIONS = ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "Task"];
const PERM_MODES = ["default", "approve-dangerous", "auto-allow", "deny-all"];
const SUGGESTED_EMOJIS = ["🤖", "🔭", "🐛", "💥", "📝", "⚖️", "👍", "👎", "✍️", "🔍", "🧐", "🟥", "🟦", "🎙️", "🦊", "🐢", "🐱", "🐶", "🦄", "👽"];

interface FormState {
  id: string;
  name: string;
  emoji: string;
  providerId: string;
  model: string;
  systemPrompt: string;
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: string;
  maxTurns: number;
}

const EMPTY_FORM: FormState = {
  id: "", name: "", emoji: "🤖", providerId: "", model: "",
  systemPrompt: "", allowedTools: [], disallowedTools: [],
  permissionMode: "approve-dangerous", maxTurns: 8,
};

export function AgentsView() {
  const [agents, setAgents] = useState<ChatAgent[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function refresh() {
    chatApi.listAgents().then(setAgents).catch((e) => setErr(String(e)));
  }
  useEffect(() => {
    refresh();
    api.listProviders().then(setProviders).catch((e) => setErr(String(e)));
  }, []);

  function startNew() {
    setEditing({ ...EMPTY_FORM, providerId: providers[0]?.name ?? "" });
    setIsNew(true);
  }
  function startEdit(a: ChatAgent) {
    setEditing({
      id: a.id, name: a.name, emoji: a.emoji,
      providerId: a.providerId, model: a.model ?? "",
      systemPrompt: a.systemPrompt,
      allowedTools: a.allowedTools, disallowedTools: a.disallowedTools,
      permissionMode: a.permissionMode, maxTurns: a.maxTurns,
    });
    setIsNew(false);
  }
  async function save() {
    if (!editing) return;
    const body = {
      ...editing,
      model: editing.model.trim() || null,
      maxTurns: Number(editing.maxTurns) || 8,
    };
    try {
      if (isNew) await chatApi.createAgent(body as any);
      else await chatApi.updateAgent(editing.id, body as any);
      setEditing(null); refresh();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  }
  async function del(id: string) {
    if (!confirm(`确认删除 AI "${id}"？关联的群成员也会被解除。`)) return;
    try { await chatApi.deleteAgent(id); refresh(); }
    catch (e: any) { setErr(String(e?.message ?? e)); }
  }
  function toggleTool(field: "allowedTools" | "disallowedTools", t: string) {
    if (!editing) return;
    const cur = editing[field];
    setEditing({ ...editing, [field]: cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t] });
  }

  return (
    <div className="manage-root">
      <div className="manage-list">
        <div className="manage-head">
          <h2>AI 列表（{agents.length}）</h2>
          <button className="primary" onClick={startNew}>+ 新建 AI</button>
        </div>
        {err ? <div className="chat-error" onClick={() => setErr(null)}>{err}</div> : null}
        <table className="manage-table">
          <thead><tr><th></th><th>id</th><th>名字</th><th>provider</th><th>model</th><th>权限</th><th></th></tr></thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td style={{ fontSize: 22 }}>{a.emoji}</td>
                <td><span className="kbd">{a.id}</span></td>
                <td>{a.name}</td>
                <td>{a.providerId}</td>
                <td>{a.model ?? "(provider 默认)"}</td>
                <td>{a.permissionMode}</td>
                <td>
                  <button onClick={() => startEdit(a)}>编辑</button>
                  <button className="danger" onClick={() => del(a.id)}>删</button>
                </td>
              </tr>
            ))}
            {agents.length === 0 ? <tr><td colSpan={7} className="muted" style={{ padding: 16 }}>还没有 AI。点右上角「新建 AI」开始。</td></tr> : null}
          </tbody>
        </table>
      </div>

      {editing ? (
        <div className="manage-editor">
          <div className="manage-head">
            <h2>{isNew ? "新建 AI" : `编辑 ${editing.id}`}</h2>
            <div>
              <button onClick={() => setEditing(null)}>取消</button>
              <button className="primary" onClick={save}>保存</button>
            </div>
          </div>
          <div className="form-grid">
            <label>id <input value={editing.id} onChange={(e) => setEditing({ ...editing, id: e.target.value })} disabled={!isNew} placeholder="recon, vuln, my-bot..." /></label>
            <label>显示名字 <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="侦察专家" /></label>
            <label>头像 emoji
              <EmojiPicker value={editing.emoji} onChange={(v) => setEditing({ ...editing, emoji: v })} suggestions={SUGGESTED_EMOJIS} />
            </label>
            <label>Provider
              <select value={editing.providerId} onChange={(e) => setEditing({ ...editing, providerId: e.target.value })}>
                <option value="">(选择)</option>
                {providers.map((p) => <option key={p.id} value={p.name}>{p.name}{(p.meta as any)?.isCurrent ? " ★" : ""}</option>)}
              </select>
            </label>
            <label>Model（留空用 provider 默认）
              <input value={editing.model} onChange={(e) => setEditing({ ...editing, model: e.target.value })} placeholder="claude-opus-4-7" />
            </label>
            <label>权限模式
              <select value={editing.permissionMode} onChange={(e) => setEditing({ ...editing, permissionMode: e.target.value })}>
                {PERM_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label>每轮最大 turns
              <input type="number" value={editing.maxTurns} onChange={(e) => setEditing({ ...editing, maxTurns: Number(e.target.value) })} />
            </label>
          </div>
          <label className="form-block">系统提示词（角色 / 风格）
            <textarea value={editing.systemPrompt} onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })} rows={10}
              placeholder={`你是一名顶级渗透测试工程师...\n输出风格：简明、专业、可执行。`}/>
          </label>
          <div className="form-block">
            <div>允许的工具（留空 = SDK 默认）</div>
            <div className="tool-grid">
              {TOOL_OPTIONS.map((t) => (
                <label key={t} className={`tool-chip ${editing.allowedTools.includes(t) ? "on" : ""}`}>
                  <input type="checkbox" checked={editing.allowedTools.includes(t)} onChange={() => toggleTool("allowedTools", t)} />
                  {t}
                </label>
              ))}
            </div>
          </div>
          <div className="form-block">
            <div>禁用的工具（优先级高）</div>
            <div className="tool-grid">
              {TOOL_OPTIONS.map((t) => (
                <label key={t} className={`tool-chip ${editing.disallowedTools.includes(t) ? "on red" : ""}`}>
                  <input type="checkbox" checked={editing.disallowedTools.includes(t)} onChange={() => toggleTool("disallowedTools", t)} />
                  {t}
                </label>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
