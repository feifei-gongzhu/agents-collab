import { useEffect, useState } from "react";
import { ChatView } from "./views/ChatView.js";
import { AgentsView } from "./views/AgentsView.js";
import { GroupsView } from "./views/GroupsView.js";
import { ObservatoryApp } from "./App.js";

type Tab = "chat" | "agents" | "groups" | "observatory";

const TAB_LABEL: Record<Tab, string> = {
  chat: "💬 群聊",
  agents: "🤖 AI 管理",
  groups: "👥 群管理",
  observatory: "📺 观察台 (旧)",
};

export function Shell() {
  const [tab, setTab] = useState<Tab>(() => {
    const t = (localStorage.getItem("agents.shellTab") as Tab) || "chat";
    return ["chat", "agents", "groups", "observatory"].includes(t) ? t : "chat";
  });
  useEffect(() => { localStorage.setItem("agents.shellTab", tab); }, [tab]);

  return (
    <div className="shell">
      <nav className="shell-nav">
        <div className="shell-brand">Agents 群聊</div>
        {(["chat", "agents", "groups", "observatory"] as Tab[]).map((t) => (
          <button
            key={t}
            className={`shell-nav-btn ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
            title={t === "observatory" ? "旧版观察台，会话式一次性运行" : ""}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
        <div className="shell-spacer" />
        <a className="shell-link" href="/api/health" target="_blank" rel="noreferrer">/api/health</a>
      </nav>
      <main className="shell-main">
        {tab === "chat" ? <ChatView /> : null}
        {tab === "agents" ? <AgentsView /> : null}
        {tab === "groups" ? <GroupsView /> : null}
        {tab === "observatory" ? <ObservatoryApp /> : null}
      </main>
    </div>
  );
}
