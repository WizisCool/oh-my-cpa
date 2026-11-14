# 远程访问与 HTTPS

默认 Compose 仅监听 `127.0.0.1`。从另一台机器临时访问可通过 SSH 端口转发：

```bash
ssh -L 18080:127.0.0.1:8080 user@server
```

若需通过 HTTPS 公网访问，请将反向代理指向上游 `127.0.0.1:8080`（或自定义 `OMCPA_BIND` 端口），在 `.env` 中设置外部访问的 `OMCPA_PUBLIC_URL`（`https://...`）及反代节点 IP/CIDR（`OMCPA_TRUSTED_PROXY_CIDRS`）。请勿在未配置 TLS 的情况下直接把 `8080` 暴露到公网。


## 反向代理配置

OMC 将前端页面与 `/api/*` 后端整合在同一个 HTTP 服务与端口（默认 `127.0.0.1:8080`），因此反向代理**只需转发一个上游端口**，根路径 `/` 无需裁剪或重写路径（若需同时对外代理 CPA 推理端口 `8317`，可另配独立域名或端口；仓库 `deploy/nginx.conf` 提供了完整示例）。

Caddy 示例：

```caddyfile
omc.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

nginx 示例（在反代层终止 TLS 并把 80 端口重定向至 HTTPS；容器内网分流模板可参考仓库 `deploy/nginx.conf`）：

```nginx
server {
    listen 80;
    server_name omc.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name omc.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

配置 HTTPS 反向代理后，在 `.env` 中补全公开地址与反代源 IP/CIDR，然后重建容器使环境变量生效（Docker 桥接模式下，宿主机上的反代访问容器看到的对端 IP 通常是 Docker 网桥网关 IP 而非 `127.0.0.1`；若反代与 OMC 同处宿主机网络命名空间则可使用 `127.0.0.1/32,::1/128`）：

```dotenv
OMCPA_PUBLIC_URL=https://omc.example.com
OMCPA_TRUSTED_PROXY_CIDRS=<proxy-peer-ip-or-cidr>
```

通过代理验证健康状态：

```bash
curl -fsS https://omc.example.com/api/healthz
```

若配置了 `OMCPA_BASE_PATH`（例如 `/omc`），请在反代规则中完整保留该前缀并同时转发前缀本身及其下所有路径。

## 安装为桌面 / 移动应用（PWA）

控制台支持浏览器标准 PWA 安装，可在独立窗口中运行并显示 OMC 图标：

| 平台与浏览器 | 操作入口 |
| --- | --- |
| 桌面端 Chrome / Edge | 地址栏右侧安装图标，或浏览器菜单 → **将此网页安装为应用** |
| Android Chrome | 浏览器菜单 → **安装应用** / **添加到主屏幕** |
| 三星浏览器 | **添加到主屏幕** |
| iOS / iPadOS Safari（及 16.4+ 的 Chrome/Edge/Firefox/Orion） | 分享按钮 → **添加到主屏幕** |
| macOS Safari 17+ | 菜单栏 **文件 → 添加到程序坞** |

浏览器要求站点运行在安全上下文（`https://` 或本机 `http://127.0.0.1` / `localhost`）才提供安装入口。应用不缓存离线业务数据，每次打开都会直接连接线上实例读取最新资源；不同 `OMCPA_BASE_PATH` 各自对应独立的应用身份。
