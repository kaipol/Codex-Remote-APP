# Codex Remote

移动优先、自托管的 Codex 会话客户端。服务通过 `codex app-server` 创建、恢复、发送和取消 turn，并以本机 rollout 作为耐久历史后备；SQLite 保存 overlay、规范化事件、审批捕获与幂等记录。

## 快速开始

要求 Node.js 20+。

```bash
copy .env.example .env      # macOS/Linux: cp .env.example .env
npm install
npm run dev
```

默认扫描 `~/.codex/sessions`。可配置：

```dotenv
CODEX_HOME=
CODEX_SESSIONS_DIR=
```

终端会打印六位配对码。打开 `http://localhost:5173` 配对后，页面自动展示按日期分片的 `rollout-*.jsonl` 会话。列表请求和“刷新”按钮都会重新扫描。

手机或另一台电脑配对时，同时填写服务端地址（例如 `http://192.168.1.10:8787`）。公网部署应使用 HTTPS；局域网、Tunnel 和移动端构建说明见 [`docs/REMOTE-ACCESS.md`](docs/REMOTE-ACCESS.md)。

## 已实现

- 递归发现 Codex rollout，支持 Windows 路径、坏文件隔离、thread id 去重和稳定排序。
- 解析 `session_meta`，提取 id、cwd、创建/更新时间，并从首个有效用户消息生成标题。
- 读取常见 `event_msg` / `response_item` 用户与助手文本。
- 支持普通 JSONL 与 gzip；同名普通文件优先。最小构建不引入 zstd 依赖，因此 `.zst` 会被安全跳过。
- SQLite overlay 可保存标题、状态和置顶；不会覆盖 rollout 历史事实。
- `POST /api/sessions/refresh` 手动刷新；同步 cursor 严格校验非负整数。
- 产品协议没有 provider/model 选择，也没有客户端伪造审批入口。
- Vue UI 已拆分为桌面侧栏/移动抽屉、会话列表、时间线、事件/工具卡、Diff viewer、只读审批 sheet、composer、连接 banner、配对与设置界面。
- create/send/cancel 使用真实 app-server API；assistant delta 按 turn 合并，未知事件安全降级。
- IndexedDB 保存会话、消息、全局事件 cursor 和 outbox；重连先增量同步，再按会话顺序使用 `client_id` 重放。
- access/refresh token 使用 IndexedDB 中不可导出的 Web Crypto 密钥加密保存；旧版 `localStorage` token 会自动迁移并删除。同一浏览器刷新或关闭网页后仍可继续使用；服务端重启会撤销旧设备令牌，需重新配对。
- WebSocket 使用 Origin 校验、心跳和设备撤销联动；断线重连会先补齐分页事件，再投影实时事件，避免流式回复缺段或重复。
- 支持 Capacitor Android 工程；移动端可在配对页配置运行时服务端地址。
- light/dark/system design tokens、safe-area 与移动固定 composer 已落地。
- Markdown/KaTeX/常用语言高亮按需加载；Service Worker 不缓存任何认证 API 响应。
- app-server 审批请求可在 Web 端批准、拒绝或取消；JSON-RPC 请求 ID 按进程 epoch 关联，重启后旧请求自动失效。额外权限授予仍要求在主机端处理，`request_user_input` 支持远程回答。
- 配对码只能由 loopback 本机调用生成；CORS 默认允许本机 Vite 与 Capacitor (`http://localhost`、`capacitor://localhost`) 源，可通过 `CORS_ORIGINS` 显式配置。
- cwd 在启动 thread 前要求真实存在并经 `realpath` 后落入 allowlist，阻断符号链接/前缀绕过；子进程固定 `shell:false`。

实现参考了 `.references/yepanywhere` 中 Codex scanner/discovery/reader 的设计，并在源码头部记录了上游 commit attribution；这里只移植 Codex 所需的最小闭包。

## App-server 交互

后端通过行分隔 JSON-RPC 启动真实 `codex app-server`（`shell:false`），完成 `initialize`/`initialized` 后使用 `thread/list`、`thread/read`、`thread/start`、`thread/resume`、`turn/start` 和 `turn/interrupt`。创建、发送和取消分别由 `/api/sessions`、`/api/sessions/{id}/messages`、`/api/sessions/{id}/cancel` 提供。

`CODEX_COMMAND`、JSON 数组格式的 `CODEX_ARGS`、`CODEX_REQUEST_TIMEOUT_MS` 可调整进程；工作目录必须位于 `CODEX_CWD_ALLOWLIST`。app-server 列表/详情失败时仍使用 rollout 自动发现作为 durable fallback。

通知被规范化、写入 SQLite 自增 cursor 并通过 WebSocket 广播。原始 payload 仅供持久化/debug，不是 UI 合约。审批 server request 会被捕获并存为 pending；决策 API 按官方 app-server schema 回写对应 JSON-RPC result，并拒绝重复、过期或服务端未提供的决策。

## 验证

```bash
npm test
npm run typecheck
npm run build
```

测试覆盖发现、解析、坏文件隔离、去重/排序、API 列表和详情、overlay、真实桥接协议、只读审批列表、事件投影/流合并、outbox 顺序与失败隔离、Diff 截断和 Markdown 安全清理。

## 边界

- 额外权限授予仍只允许在本机 Codex 处理；远程端只能拒绝此类请求。审批不会离线排队。
- 未实现 E2EE、内置 Tunnel/VPS relay、推送通知或系统钥匙串集成；当前安全边界是配对令牌、浏览器本地加密存储与部署层 TLS。
- 浏览器 IndexedDB 的不可导出密钥可以降低静态 token 泄漏风险，但不等同于原生系统钥匙串，也无法防御同源脚本被攻陷。
- 未加入 zstd rollout、超大历史增量索引、文件浏览器或原生安装包。
- 离线能力是可靠的消息 outbox 与缓存 transcript，不包含离线创建会话、审批或冲突编辑。

API 见 `docs/openapi.yaml`，架构与 attribution 见 `docs/ARCHITECTURE.md`。
