# agents

Multi-agent collaboration on top of Claude Code (blackboard architecture).

## Layout

```
packages/
  core/   # orchestrator, blackboard, agent runtime, cc-switch adapter
  cli/    # Ink TUI
configs/
  agents/  # agent definitions
  groups/  # group (multi-agent) definitions
claudemd/  # role / group system prompts
workspaces/<session-id>/
  blackboard/        # shared, append-only by owner
  agents/<agent-id>/ # private cwd per agent
  session.json
```

## Status

WIP — CLI MVP + Web 已就绪。

## Docker 快速启动

```bash
# 1. 把示例 providers 改名（或挂载宿主机 CC-Switch DB）
cp configs/providers.example.json configs/providers.json
# 编辑 configs/providers.json，填入真实的 ANTHROPIC_BASE_URL / TOKEN

# 2. 构建镜像 + 启动
docker compose up --build

# 3. 浏览器打开
#   http://localhost:3000
```

容器内挂载点：
- `./configs` → `/app/configs`：群组、agent、providers 配置（改了不用重建镜像）
- `./workspaces` → `/app/workspaces`：会话产物（黑板 / turn-log / session.json）
- `~/.cc-switch` → `/root/.cc-switch`（只读）：复用宿主机的 CC-Switch 厂商配置

环境变量：
- `PORT`（默认 3000）
- `AGENTS_PROJECT_ROOT`（默认 `/app`）
- `AGENTS_WORKSPACES`（默认 `/app/workspaces`）
- `HTTP_PROXY` / `HTTPS_PROXY`（按需）

## 本地开发（非 Docker）

```bash
npm install
npm run build
node packages/server/dist/index.js
# 另一个终端跑前端 dev server
npm run dev --workspace @agents/web
# 浏览器打开 http://localhost:5173 （vite 会代理 /api）
```

