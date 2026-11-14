# 端口与存储

Compose 从 `compose.yml` 所在目录读取 `.env`，`.env` 中的相对路径也以该目录为准。修改后执行 `docker compose up -d` 重建容器。

## 修改端口

宿主机 `8080` 端口被其他服务占用时，修改方式取决于运行模式：

1. **标准 Docker Compose（桥接网络）**：
   只修改 `.env` 中的宿主机映射 `OMCPA_BIND`（例如改为 `18317`）：

   ```dotenv
   OMCPA_BIND=127.0.0.1:18317
   ```

   请保持 `ports:` 右侧容器端口为 `:8080`（`${OMCPA_BIND:-127.0.0.1:8080}:8080`）。容器内进程和内置健康检查仍监听 `:8080`。如果直接改了右侧容器端口而未改 `OMCPA_LISTEN_ADDR`，流量将被转发到无进程监听的端口。

2. **原生可执行文件**（或自行采用 `network_mode: host` 并将 `OMCPA_LISTEN_ADDR` 传入容器 `environment:` 的场景）：
   由于没有容器端口映射层，直接在 `.env` 中设置 `OMCPA_LISTEN_ADDR`：

   ```dotenv
   OMCPA_LISTEN_ADDR=127.0.0.1:18317
   ```

修改宿主机端口后，请同步更新浏览器访问地址、本地健康检查 URL 与反向代理上游地址。

## 存储与目录权限

两份官方 Compose 文件默认配置为 `volumes: - ${OMCPA_DATA_PATH:-oh-my-cpa-data}:/data`。未设置 `OMCPA_DATA_PATH` 时，Docker 会自动创建 `oh-my-cpa-data` 命名卷并继承镜像 `/data` 的权限（`10001:10001`，`0700`），无需手动创建目录。使用该命名卷时请保持默认的 `OMCPA_USER=10001:10001`。

如果希望将 SQLite 数据库放在 `compose.yml` 同级宿主机目录（如 `./oh-my-cpa-data`），请在 `.env` 中配置：

```dotenv
OMCPA_DATA_PATH=./oh-my-cpa-data
```

挂载宿主机目录时 Docker 不会自动修改目录属主，且容器以非 root 用户运行。可通过以下任一方案使目录属主与容器进程一致：

- **方案 A — 以当前宿主机用户运行容器（无需 `sudo chown`）**：

  ```bash
  mkdir -p -m 700 ./oh-my-cpa-data
  printf 'OMCPA_DATA_PATH=./oh-my-cpa-data\nOMCPA_USER=%s:%s\n' "$(id -u)" "$(id -g)" >> .env
  ```

  切勿将主服务设为 `OMCPA_USER=0:0`。

- **方案 B — 保持容器默认 `10001:10001` 并修改宿主机目录属主**：

  ```bash
  mkdir -p -m 700 ./oh-my-cpa-data
  sudo chown -R 10001:10001 ./oh-my-cpa-data
  echo "OMCPA_DATA_PATH=./oh-my-cpa-data" >> .env
  ```

重要规则：
- 修改 `OMCPA_USER` 只影响进程运行身份，不会自动修改磁盘上已有文件的属主。
- 修改 `OMCPA_DATA_PATH` 会切换容器挂载的数据位置，不会自动把命名卷中的旧数据搬迁到新目录。
- 严禁在 OMC 运行期间直接拷贝正在使用的 SQLite 文件；请先停服或使用[SQLite 运维与备份手册](../ops/sqlite-operations.md)中的在线备份与导出功能。
