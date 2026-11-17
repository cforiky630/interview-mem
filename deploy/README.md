# 单服务器镜像部署

使用一个应用容器和 PostgreSQL 17。默认从 GitHub Container Registry 下载已经测试的 Linux amd64 镜像，服务器只需 Docker Compose 和 HTTPS 反向代理。应用只映射到服务器本机的 `127.0.0.1:3000`。

## 自动构建

推送代码到 `main`，或在 GitHub Actions 中手动运行 **Check and publish Linux image**：

1. 在 Linux 上安装锁定依赖，运行类型检查和 Node 测试。
2. 构建 Linux amd64 镜像，启动临时 PostgreSQL，自动应用迁移。
3. 对正在运行的镜像执行电脑、手机浏览器测试；全部通过后才发布同一个镜像。
4. 发布 `ghcr.io/cforiky630/interview-mem:sha-完整提交SHA` 和 `:main`。Actions 摘要提供完整 digest 引用，部署时可固定到这一内容版本。

PR 只运行只读的类型检查和 Node 测试。文档修改不触发自动构建；需要时可手动运行。发布使用本次工作流的 `GITHUB_TOKEN`，不需要填写个人 Token、数据库密码或生产密钥；第三方 Actions 固定到完整提交 SHA。

首次发布的 GHCR 包默认为私有。可在 [Package 设置](https://github.com/users/cforiky630/packages/container/package/interview-mem) 中将镜像设为公开，服务器即可免登录拉取；保留私有时，服务器需要用至少有 `read:packages` 权限的 classic PAT 登录 `ghcr.io`，输入使用 `docker login ghcr.io -u cforiky630` 的密码提示。不要将 Token 写进项目或命令参数。参见 [GHCR 官方认证说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

当前只构建常见 Intel / AMD 服务器使用的 `linux/amd64`；ARM64 服务器需要另加构建和验证。CI 发布镜像后不会自动登录你的服务器，服务器的更新由下面的命令完成。

## 配置与启动

在项目根目录创建 `.env`，权限设为仅部署用户可读：

```dotenv
BETTER_AUTH_URL=https://study.example.com
BETTER_AUTH_SECRET=独立随机值_至少32字符
KEY_ENCRYPTION_SECRET=另一个独立随机值_至少32字符
POSTGRES_PASSWORD=独立的数据库密码
# 推荐从 Actions 摘要复制 SHIYI_IMAGE=...@sha256:...，固定到已验证的镜像。
SHIYI_IMAGE=ghcr.io/cforiky630/interview-mem:main
```

每次用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成一个值。Compose 使用独立连接字段传递数据库密码，不需要手动做 URL 编码。含 `$` 等字符的手写值应按 Docker Compose `.env` 语法使用单引号。

将 [nginx.conf](nginx.conf) 中的域名及证书路径替换成实际配置，然后在服务器运行：

```sh
docker compose pull
docker compose up -d --no-build --wait
curl --fail http://127.0.0.1:3000/api/health
curl --fail https://study.example.com/api/health
```

容器先校验配置，再通过同一 PostgreSQL 连接持有迁移锁并应用 SQL 迁移，成功后启动 Next.js。迁移失败不会启动应用。健康检查验证数据库及最新连接表字段；只返回可用状态。

镜像构建时启用 `NEXT_STANDALONE=true`，并核对全部依赖追踪清单，缺失运行文件会直接使构建失败。本地 `npm run build` 使用常规生产构建，避免 Windows 独立包复制阶段的权限错误。

应用镜像只包含 Next.js standalone 运行文件、静态资源和迁移，不复制本地账号库、个人原文、`.env.local`、测试产物及开发依赖。不要开放数据库端口或把 `.data` 目录当作网页目录。

这里的代理配置关闭了缓存和响应缓冲，支持 AI 流式回答。若前面还有 CDN，`/api/*` 也应绕过缓存。参考 [Nginx 代理缓冲说明](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)。

## 更新与备份

更新前备份数据库，并另行备份 `KEY_ENCRYPTION_SECRET` 与 `BETTER_AUTH_SECRET`。记录当前的 `SHIYI_IMAGE` 引用，升级时保留相同密钥；直接更换加密主密钥会使已有用户的模型 Key 无法解密。

```sh
docker compose exec -T db pg_dump -U shiyi -d shiyi -Fc -f /tmp/shiyi.dump
docker compose cp db:/tmp/shiyi.dump ../shiyi-backup.dump
docker compose exec -T db rm /tmp/shiyi.dump
# 将 .env 中的 SHIYI_IMAGE 改为新构建的 digest，再更新应用。
docker compose pull app
docker compose up -d --no-build --wait
```

备份文件包含账号与私有数据，应保存在项目目录之外并复制到另一台机器。将自定义格式备份恢复到独立的空数据库后核对账号、题库和记录，再切换流量；不要在没有验证备份的情况下覆盖现有数据库。参考 [PostgreSQL 备份工具](https://www.postgresql.org/docs/17/app-pgdump.html)。`docker compose down` 保留数据卷；不要加 `-v`。

切回旧版本时，将 `SHIYI_IMAGE` 改回之前记录的 digest，再拉取、启动。此操作只更换程序，不自动回滚数据库；涉及不兼容的数据库迁移时需要使用已验证的备份恢复。

本地开发使用的 PGlite 与服务器 PostgreSQL 不是同一个数据目录。首次上云时需要将现有账号、题库和历史一起迁移，并保留原加密主密钥；仅复制项目或个人 JSON 导出不会迁移登录账号与模型密钥。当前本地数据保留原位，待目标数据库确定后做迁移与校验。

## 需要在服务器构建时

如果服务器无法拉取 GHCR，可保留源码构建方式，主动叠加构建配置：

```sh
docker compose -f compose.yaml -f compose.build.yaml up -d --build --wait
```

默认 `compose.yaml` 没有 `build` 字段，服务器不会在拉取镜像失败时自行编译源码。

## 运行边界

- 当前按单个应用实例部署，认证限流及 AI 并发计数保存在进程内。多实例前需共享限流状态；数据库迁移已有锁保护。
- 外部托管 PostgreSQL 可改用 `DATABASE_URL`；TLS/CA 按数据库服务配置，不关闭证书校验。
- 邮件验证与密码找回尚未接入。开放给陌生用户注册前应配置邮件服务并验证找回流程。
- Linux 镜像及 PostgreSQL 由 CI 运行验证；目标服务器的域名、HTTPS、网络与数据迁移仍需部署时验收。
