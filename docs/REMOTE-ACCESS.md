# Codex Remote 公网访问方案

本方案不使用 Docker。本地启动服务后,手机 App 或浏览器可以直接通过局域网或公网访问。

## 方案一:局域网直连（最简单,推荐家用）

1. **启动服务**:
   ```bash
   npm run build
   npm start
   ```
   服务监听 `0.0.0.0:8787`,同一 WiFi 下的设备可直接访问。

2. **手机访问**:
   - 浏览器: `http://<电脑IP>:8787`
   - App: 在 Codex Remote App 设置中填写 `http://<电脑IP>:8787` 作为服务器地址

3. **获取电脑 IP**:
   - Windows: `ipconfig` → 找 IPv4 地址
   - macOS: `ifconfig | grep inet`

4. **防火墙**: 确保 Windows 防火墙允许 8787 端口入站。

## 方案二:Cloudflare Tunnel（公网访问,免端口映射）

适合在外网（如出差、咖啡厅）访问家里电脑。无需公网 IP,不需要 Docker。

1. **安装 cloudflared**:
   - Windows: 下载 [cloudflared.exe](https://github.com/cloudflare/cloudflared/releases/latest)
   - macOS: `brew install cloudflare/cloudflare/cloudflared`

2. **快速隧道（临时,无需域名）**:
   ```bash
   npm start &
   cloudflared tunnel --url http://localhost:8787
   ```
   输出会显示一个 `https://xxx.trycloudflare.com` 链接,在手机浏览器打开即可。

3. **命名隧道（持久,需要 Cloudflare 账号和域名）**:
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create codex-remote
   cloudflared tunnel route dns codex-remote codex.yourdomain.com
   cloudflared tunnel run codex-remote
   ```
   配置文件 `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: ~/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: codex.yourdomain.com
       service: http://localhost:8787
     - service: http_status:404
   ```

## 方案三:SSH 反向隧道（VPS 中继）

适合有 VPS 但不想装 Cloudflare 的场景。

1. **在 VPS 上开放端口**: 确保 VPS 安全组/防火墙允许指定端口（如 8787）。

2. **在本地电脑建立反向隧道**:
   ```bash
   ssh -R 8787:localhost:8787 user@your-vps-ip -N
   ```
   然后在手机上访问 `http://<vps-ip>:8787`。

3. **持久化**: 使用 `autossh` 保持连接:
   ```bash
   autossh -M 0 -o "ServerAliveInterval 30" -o "ServerAliveCountMax 3" \
     -R 8787:localhost:8787 user@your-vps-ip -N
   ```

## 离线说明

- **本地未启动时**,手机 App 可查看缓存的会话历史（IndexedDB）。
- 消息发送会进入离线队列,服务恢复后自动重发。
- 审批、创建会话等交互需要服务在线。

## 安全提醒

- 配对码只能在电脑本机生成（loopback only）。
- 生产环境建议始终使用 HTTPS（Cloudflare Tunnel 或 VPS + Let's Encrypt）。
- Android 客户端显式允许局域网 HTTP（cleartext）并关闭应用备份；公网或不可信网络仍必须使用 HTTPS。
- 定期在设置中检查已配对设备,不需要时解除配对。
- `CODEX_CWD_ALLOWLIST` 限制了 Codex 可操作的目录范围,确保只包含必要目录。
- 远程端默认禁用 `danger-full-access`;只有明确设置 `ALLOW_DANGER_FULL_ACCESS=true` 才会在界面中开放“完全访问权限”。启用后 cwd allowlist 不再能限制 Codex 读取工作目录以外的文件。
