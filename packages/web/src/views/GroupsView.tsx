import { useEffect, useState } from "react";
import { chatApi, type ChatGroup, type ChatAgent } from "../api.js";
import { EmojiPicker } from "../components/EmojiPicker.js";

const SUGGESTED_GROUP_EMOJIS = ["💬", "🎯", "🥊", "📑", "⚔️", "🛠️", "🔬", "🎭", "🚀", "🏛️", "🎲", "🌐"];

interface FormState {
  id: string;
  name: string;
  emoji: string;
  description: string;
  moderatorAgentId: string;
  meta: string;
  memberIds: string[];
}

const EMPTY: FormState = {
  id: "", name: "", emoji: "💬", description: "",
  moderatorAgentId: "", meta: "", memberIds: [],
};

export function GroupsView() {
  const [groups, setGroups] = useState<ChatGroup[]>([]);
  const [agents, setAgents] = useState<ChatAgent[]>([]);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function refresh() {
    chatApi.listGroups().then(setGroups).catch((e) => setErr(String(e)));
  }
  useEffect(() => {
    refresh();
    chatApi.listAgents().then(setAgents).catch((e) => setErr(String(e)));
  }, []);

  function startNew() { setEditing({ ...EMPTY }); setIsNew(true); }
  function startEdit(g: ChatGroup) {
    setEditing({
      id: g.id, name: g.name, emoji: g.emoji,
      description: g.description ?? "",
      moderatorAgentId: g.moderatorAgentId ?? "",
      meta: g.meta, memberIds: [...g.memberIds],
    });
    setIsNew(false);
  }
  async function save() {
    if (!editing) return;
    const body = {
      ...editing,
      description: editing.description || null,
      moderatorAgentId: editing.moderatorAgentId || null,
    };
    try {
      if (isNew) await chatApi.createGroup(body as any);
      else await chatApi.updateGroup(editing.id, body as any);
      setEditing(null); refresh();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  }
  async function del(id: string) {
    if (!confirm(`确认删除群「${id}」？聊天记录会一并清掉。`)) return;
    try { await chatApi.deleteGroup(id); refresh(); }
    catch (e: any) { setErr(String(e?.message ?? e)); }
  }
  function toggleMember(id: string) {
    if (!editing) return;
    const cur = editing.memberIds;
    setEditing({ ...editing, memberIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  }
  function moveMember(idx: number, dir: -1 | 1) {
    if (!editing) return;
    const list = [...editing.memberIds];
    const j = idx + dir;
    if (j < 0 || j >= list.length) return;
    [list[idx], list[j]] = [list[j], list[idx]];
    setEditing({ ...editing, memberIds: list });
  }

  return (
    <div className="manage-root">
      <div className="manage-list">
        <div className="manage-head">
          <h2>群列表（{groups.length}）</h2>
          <button className="primary" onClick={startNew}>+ 新建群</button>
        </div>
        {err ? <div className="chat-error" onClick={() => setErr(null)}>{err}</div> : null}
        <table className="manage-table">
          <thead><tr><th></th><th>id</th><th>名字</th><th>主持人</th><th>成员</th><th></th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id}>
                <td style={{ fontSize: 22 }}>{g.emoji}</td>
                <td><span className="kbd">{g.id}</span></td>
                <td>{g.name}</td>
                <td>{g.moderatorAgentId ?? <span className="muted">(无)</span>}</td>
                <td>{g.memberIds.length}</td>
                <td>
                  <button onClick={() => startEdit(g)}>编辑</button>
                  <button className="danger" onClick={() => del(g.id)}>删</button>
                </td>
              </tr>
            ))}
            {groups.length === 0 ? <tr><td colSpan={6} className="muted" style={{ padding: 16 }}>还没有群。点「新建群」开始。</td></tr> : null}
          </tbody>
        </table>
      </div>

      {editing ? (
        <div className="manage-editor">
          <div className="manage-head">
            <h2>{isNew ? "新建群" : `编辑 ${editing.id}`}</h2>
            <div>
              <button onClick={() => setEditing(null)}>取消</button>
              <button className="primary" onClick={save}>保存</button>
            </div>
          </div>
          <div className="form-grid">
            <label>id <input value={editing.id} onChange={(e) => setEditing({ ...editing, id: e.target.value })} disabled={!isNew} placeholder="my-team, debate-1..." /></label>
            <label>名字 <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="技术辩论室" /></label>
            <label>群头像
              <EmojiPicker value={editing.emoji} onChange={(v) => setEditing({ ...editing, emoji: v })} suggestions={SUGGESTED_GROUP_EMOJIS} />
            </label>
            <label>主持人（决定下一个谁说话）
              <select value={editing.moderatorAgentId} onChange={(e) => setEditing({ ...editing, moderatorAgentId: e.target.value })}>
                <option value="">(无主持人 / @ 直接点名)</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.emoji} {a.name} ({a.id})</option>)}
              </select>
            </label>
          </div>
          <label className="form-block">描述
            <input value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} placeholder="一句话描述群的用途" />
          </label>
          <label className="form-block">群目标 / 上下文（所有 AI 都会看到）
            <textarea value={editing.meta} onChange={(e) => setEditing({ ...editing, meta: e.target.value })} rows={5}
              placeholder={`例：本群讨论 https://example.com 的攻击面...`} />
          </label>

          <div className="form-block">
            <div>群成员（顺序决定无主持人时的轮转 / @ 候选）</div>
            {editing.memberIds.length > 0 ? (
              <ol className="member-order">
                {editing.memberIds.map((id, i) => {
                  const a = agents.find((x) => x.id === id);
                  return (
                    <li key={id}>
                      <span style={{ fontSize: 18 }}>{a?.emoji ?? "🤖"}</span>
                      <span>{a?.name ?? id} <span className="muted">@{id}</span></span>
                      <button onClick={() => moveMember(i, -1)}>↑</button>
                      <button onClick={() => moveMember(i, 1)}>↓</button>
                      <button className="danger" onClick={() => toggleMember(id)}>移除</button>
                    </li>
                  );
                })}
              </ol>
            ) : <div className="muted">尚未添加成员</div>}
            <div className="member-pool">
              <div className="muted">点击下方 AI 加入群：</div>
              <div className="tool-grid">
                {agents.filter((a) => !editing.memberIds.includes(a.id)).map((a) => (
                  <button key={a.id} className="tool-chip" onClick={() => toggleMember(a.id)}>
                    {a.emoji} {a.name}
                  </button>
                ))}
                {agents.length === 0 ? <span className="muted">还没有 AI。先去「AI 管理」创建。</span> : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
