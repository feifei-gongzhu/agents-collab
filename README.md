# Agents Collab

> 像微信群聊一样指挥多个 AI 协作 —— 基于 Claude Code SDK 的多智能体协作平台

[English](#english) | [中文](#中文)

---

## 中文

### 简介

**Agents Collab** 是一个多 AI 协作平台，让你像管理微信群一样管理多个 AI Agent。每个 Agent 可以配置不同的模型、API 密钥、系统提示和工具权限，通过 **主持人调度** 或 **@点名** 机制让它们围绕同一话题协同工作。

### 效果预览

```
┌─────────────────────────────────────────┐
│ 💬 群聊    🤖 AI管理    👥 群管理       │
├──────────┬──────────────────────────────┤
│ 🎯渗透测  │  🎙️ moderator              │
│ 🥊正反辩  │  → @recon · 先收集信息      │
│ ⚔️红蓝对  │                              │
│ 📑三人评  │ 🔭 recon                    │
│          │  发现子域名 3 个...           │
│          │  @vuln 来分析一下            │
│          │                              │
│          │ 🐛 vuln                     │
│          │  检测到 SQL 注入点...         │
│          │                              │
│ ─────────┤ 👤 用户                     │
│          │  @exploit 写个 PoC 试试      │
│          │                              │
└──────────┴──────────────────────────────┘
```

### 核心特性

- **微信群聊式交互** — 左侧群列表，右侧消息流，支持 emoji 头像
- **主持人调度** — AI 主持人自动决定下一个谁发言，输出 JSON 决策
- **@点名机制** — 用户直接 `@agent-id` 点名，跳过主持人
- **工具审批** — 敏感操作（Write/Edit/Bash）弹出确认框
- **黑板架构** — 共享工作区（meta/shared/agent 私有区）
- **SQLite 持久化** — Agent/群/消息全部进数据库
- **CC-Switch 复用** — 自动识别宿主机已配置的 AI 厂商
- **Docker 一键部署** — 多阶段构建，~60MB 镜像

### 快速开始

#### 方式一：Docker（推荐）

```bash
# 1. 克隆仓库
git clone https://github.com/feifei-gongzhu/agents-collab.git
cd agents-collab

# 2. 确保 CC-Switch 已配置至少一个厂商
#    ~/.cc-switch 会被自动挂载进容器

# 3. 启动
docker compose up -d

# 4. 访问 http://localhost:3010
```

#### 方式二：本地开发

```bash
npm install
npm run build
node packages/server/dist/index.js
# 另开终端
npm run dev --workspace @agents/web
# 访问 http://localhost:5173
```

### 架构

```
┌─────────────────────────────────────────────────────┐
│  前端 (React 18 + Vite)                              │
│  ├── 💬 群聊界面 (SSE 实时流)                        │
│  ├── 🤖 AI 管理 (CRUD + 工具白名单)                  │
│  └── 👥 群管理 (成员排序 + 主持人指定)               │
├─────────────────────────────────────────────────────┤
│  后端 (Fastify + SSE)                                │
│  ├── /api/agents      AI CRUD                       │
│  ├── /api/groups2     群 CRUD + 成员管理            │
│  ├── /api/groups2/:id/messages   消息               │
│  ├── /api/groups2/:id/stream     SSE 实时流         │
│  └── /api/chat-approvals/:reqId  工具审批           │
├─────────────────────────────────────────────────────┤
│  核心 (@agents/core)                                 │
│  ├── AgentRuntime     Claude SDK 封装               │
│  ├── Blackboard       文件系统黑板                  │
│  ├── ProviderRegistry CC-Switch 厂商解析            │
│  └── Orchestrator     旧版顺序调度器（兼容）        │
└─────────────────────────────────────────────────────┘
```

### 预设角色

| 角色 | emoji | 职责 |
|---|---|---|
| recon | 🔭 | 侦察 — 资产扫描、信息收集 |
| vuln | 🐛 | 漏洞 — 漏洞分析、验证 |
| exploit | 💥 | 利用 — PoC 编写、验证 |
| report | 📝 | 报告 — 漏洞报告撰写 |
| judge | ⚖️ | 仲裁 — 决策下一个谁发言 |
| pro | 👍 | 正方 — 支持观点 |
| con | 👎 | 反方 — 反对观点 |
| writer | ✍️ | 写作 — 内容创作 |
| reviewer | 🔍 | 评审 — 代码/文档审查 |
| critic | 🧐 | 批评 — 找出问题 |
| red | 🟥 | 红队 — 攻击方 |
| blue | 🟦 | 蓝队 — 防御方 |

### 群聊调度机制

```
用户发送消息
    │
    ▼
┌────────────────────────────────────┐
│ 1. 解析 @mentions，加入队列        │
│ 2. while step < 20:                │
│    - 队列非空 → 弹出指定 agent      │
│    - 有 moderator → 运行主持人决策  │
│    - 无 moderator → 按成员顺序轮转  │
│    - agent 发言 → 解析 @ → 入队    │
│    - 写入黑板                      │
└────────────────────────────────────┘
```

### 配置说明

#### AI 配置字段

| 字段 | 说明 | 示例 |
|---|---|---|
| id | 英文标识符 | `recon` |
| name | 显示名 | `侦察专家` |
| emoji | 头像 | `🔭` |
| providerId | 厂商 ID | `ikunn` |
| model | 模型覆盖 | `claude-opus-4-6` |
| systemPrompt | 系统提示 | `# 你是侦察专家...` |
| allowedTools | 允许的工具 | `WebFetch, Bash, Read` |
| disallowedTools | 禁止的工具 | `Write, Edit` |
| permissionMode | 权限模式 | `approve-dangerous` |
| maxTurns | 单次上限 | `8` |

#### 权限模式

| 模式 | 行为 |
|---|---|
| `default` | SDK 默认行为 |
| `approve-dangerous` | 危险操作弹窗确认（推荐） |
| `auto-allow` | 全部自动通过 |
| `deny-all` | 全部拒绝 |

### 技术栈

- **运行时**: Node.js 22+ (`node:sqlite` 内置)
- **包管理**: npm workspaces
- **后端**: Fastify 4.x + SSE
- **前端**: React 18 + Vite 5
- **数据库**: SQLite (`node:sqlite`)
- **AI SDK**: @anthropic-ai/claude-agent-sdk
- **容器**: Docker + Docker Compose

### 数据持久化

| 挂载点 | 内容 | 说明 |
|---|---|---|
| `./configs` | 配置模板 | 改 JSON 不用重建镜像 |
| `./workspaces` | SQLite + 黑板 | 聊天记录在此 |
| `~/.cc-switch` | 厂商密钥 | 只读挂载，复用宿主机配置 |

### 路线图

- [x] 微信群聊式 UI
- [x] 主持人调度 + @点名
- [x] 工具审批系统
- [x] SQLite 持久化
- [x] Docker 部署
- [ ] 对话摘要（超过 30 条自动压缩）
- [ ] Agent 并行执行
- [ ] 前端 code-split 优化
- [ ] 测试覆盖

### License

MIT

---

## English

### Introduction

**Agents Collab** is a multi-agent collaboration platform that lets you manage multiple AI agents like WeChat groups. Each agent can be configured with different models, API keys, system prompts, and tool permissions. Agents collaborate through **moderator scheduling** or **@ mentions**.

### Quick Start

```bash
git clone https://github.com/feifei-gongzhu/agents-collab.git
cd agents-collab
docker compose up -d
# Open http://localhost:3010
```

### Key Features

- WeChat-style group chat UI with emoji avatars
- Moderator-driven scheduling via JSON decisions
- @-mention support for direct agent addressing
- Tool approval system for sensitive operations
- Blackboard architecture (meta/shared/private areas)
- SQLite persistence for agents/groups/messages
- CC-Switch provider integration
- Docker one-click deployment

### Architecture

See [中文](#中文) section for detailed architecture diagram.

### License

MIT
