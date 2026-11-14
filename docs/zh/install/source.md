# 从源码构建

需要 Go 1.26+、Node.js 22+、pnpm 11+ 与运行中的 CPA：

```bash
git clone https://github.com/WizisCool/oh-my-cpa.git
cd oh-my-cpa
pnpm install --frozen-lockfile
cp .env.example .env
chmod 600 .env
```

在 `.env` 中填好 `OMCPA_MASTER_KEY`、`OMCPA_CPA_MANAGEMENT_KEY` 与 `OMCPA_CPA_BASE_URL`（若 CPA 在远端且 `OMCPA_USAGE_INGEST_MODE` 设为 `subscribe` 或 `resp_pull`，请将 `OMCPA_CPA_BASE_URL` 设为提供 RESP 的明文 `http://` 地址与端口；`https://` 基地址不支持 RESP，这两种模式会忽略 `OMCPA_CPA_USAGE_ADDR`），然后编译并启动：

```bash
pnpm build
go build -trimpath -o bin/oh-my-cpa ./cmd/oh-my-cpa
./bin/oh-my-cpa
```

服务在前台运行，可使用 systemd 等服务管理器托管。真实环境变量优先级高于 `.env`，也可用 `OMCPA_ENV_FILE` 指定配置文件路径。
