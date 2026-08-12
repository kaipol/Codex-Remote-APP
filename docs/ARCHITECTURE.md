# 架构与开源融合记录

## 单仓库

- `packages/shared`：REST/WebSocket 共用协议。
- `packages/server`：Express、ws、SQLite、认证和 Codex rollout 发现/读取。
- `packages/web`：Vue 3 PWA。`components/` 按 shell/sidebar/thread/timeline/message/event/diff/approval/composer/connection/settings/pairing 划分；`composables/` 负责事件投影、Diff 摘要与 outbox 重放；Dexie 保存 transcript、事件、cursor 与待发送消息。

## 借鉴与融合

实现前在 `.references/` 浅克隆并研究了 GOAL.md 指定的 yepanywhere、CC Pocket、codex-mobile。重点融合：

- Yep Anywhere：Codex 日期分片 rollout 扫描、坏文件隔离、会话读取与稳定排序思路。
- codex-mobile：移动优先聊天布局。

本项目根据自身协议重新实现，不复制其品牌、云服务、原生客户端或账号体系。

## 安全边界

产品仅支持 Codex。`codex/` 模块分离 app-server 子进程、JSON-RPC correlation、最小协议、通知路由与 thread manager。进程使用 `shell:false` 和行缓冲 stdio；超时、退出、malformed JSON、未知通知和 server request 均被隔离。工作目录经规范化并限制于 allowlist。

app-server 是实时 thread/turn 的首选事实源；`CODEX_SESSIONS_DIR` rollout 扫描保留为 durable fallback，二者按 thread id 合并。SQLite 保存 overlay、规范化事件、幂等记录和原生审批请求。重启后不信任旧 PID，首次 turn 前调用 `thread/resume`。

审批捕获 `commandExecution`、`fileChange`、`permissions`、`requestUserInput`、MCP elicitation 与旧版 exec/patch server requests。请求使用进程 epoch + 原始 JSON-RPC id 关联；决策按 Codex 0.147.0 生成的 schema 转换响应，进程重启后旧请求标记 stale，重复决策返回 409。额外权限只能远程拒绝，授予必须在主机处理。

配对码生成接口仅接受 loopback 来源；CORS 默认限制为本机开发源。cwd 必须存在，经过 `realpath` 后再做 allowlist 相对路径判断；不存在路径和越界路径分别拒绝。Web 端 refresh token 仍在 `localStorage`，属于待设备密钥/安全存储替换的明确安全债务。

## 同步

Codex thread/turn/item 通知被映射成稳定 shared events，SQLite 自增 `seq` 是全局单调 cursor；保存后立即经 WebSocket 广播。详情优先 `thread/read`，失败时从 rollout 读取历史。客户端不按当前会话过滤持久化：所有事件先进入 IndexedDB，再只投影当前会话；重连先调用 `/api/sync` 补齐全局 cursor，随后按会话和创建时间重放 outbox，原始 `client_id` 保持不变以获得服务端幂等。

## 前端与性能边界

界面采用响应式双层 shell：桌面常驻可折叠语义侧栏，移动端 drawer + sticky header + safe-area composer。主题只使用 design tokens 并支持 light/dark/system。Markdown 渲染模块动态导入，KaTeX 与受控的常用 highlight.js language 集合进入独立 chunk；Service Worker 只预缓存静态构建产物，明确不缓存 `/api` 或 `/ws`。

审批列表支持在线批准、拒绝、取消和 `request_user_input` 回答；审批不进入离线 outbox。服务端不会自动批准，且会校验 app-server 提供的 `availableDecisions`。

未实现 E2EE、Tunnel、Capacitor、推送和原生设备密钥；这些不得由当前配对令牌、PWA 或 TLS 部署能力推断为已完成。
