# 多阶段构建：
#   1. base   — node + pnpm/npm，复用依赖缓存
#   2. build  — 编译 core / cli / server (TypeScript) + web (Vite)
#   3. runner — 只保留运行时所需文件，体积小
#
# 运行时挂载点：
#   /app/configs        — 群组 / agent / CLAUDE.md / providers.json
#   /app/workspaces     — 会话产物（持久化）
#   /root/.cc-switch    — 可选，挂载主机的 CC-Switch DB（只读）
#
# 端口：3000

# ------- 1. base -------
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=development
ENV CI=1

# Workspaces 需要每个子包的 package.json 在 npm install 前就存在，否则链接是悬挂的。
# 一次性复制全部源（依赖体积小，cache 失效成本可控）。
COPY package.json package-lock.json tsconfig.base.json tsconfig.json build.mjs ./
COPY packages ./packages

RUN npm install --no-audit --no-fund

# ------- 2. build -------
FROM base AS build
# TS 工程构建 — 按依赖顺序逐包编译
RUN npm run build --workspace @agents/core
RUN npm run build --workspace @agents/cli
RUN npm run build --workspace @agents/server

# Web 前端构建 (Vite)
RUN npm run build --workspace @agents/web

# ------- 3. runner -------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV AGENTS_PROJECT_ROOT=/app
ENV AGENTS_WORKSPACES=/app/workspaces
ENV AGENTS_WEB_DIST=/app/packages/web/dist
# CLI 自重启逻辑跳过
ENV AGENTS_CLI_NOWARN=1

# 安装运行时依赖（仅 server 这条线需要的）
COPY package.json package-lock.json ./
# Workspaces 链接需要每个子包的 package.json 同时存在
COPY packages/core/package.json packages/core/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json

# 只装生产依赖
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts

# 复制编译产物
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/cli/dist packages/cli/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist

# 默认带上仓库内置的 configs（容器里可被 volume 覆盖）
COPY configs ./configs

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
