# 单服务器部署

使用一个应用容器和 PostgreSQL 17。应用只映射到服务器本机的 `127.0.0.1:3000`，公网通过 HTTPS 反向代理访问。

## 配置与启动

在项目根目录创建 `.env`，权限设为仅部署用户可读：

```dotenv
BETTER_AUTH_URL=https://study.example.com
BETTER_AUTH_SECRET=独立随机值_至少32字符
KEY_ENCRYPTION_SECRET=另一个独立随机值_至少32字符
POSTGRES_PASSWORD=独立的数据库密码
```

每次用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成一个值。Compose 使用独立连接字段传递数据库密码，不需要手动做 URL 编码。含 `$` 等字符的手写值应按 Docker Compose `.env` 语法使用单引号。

将 [nginx.conf](nginx.conf) 中的域名及证书路径替换成实际配置，然后在服务器运行：

```sh
docker compose up -d --build --wait
curl --fail http://127.0.0.1:3000/api/health
curl --fail https://study.example.com/api/health
```

容器先校验配置，再通过同一 PostgreSQL 连接持有迁移锁并应用 SQL 迁移，成功后启动 Next.js。迁移失败不会启动应用。健康检查验证数据库及最新连接表字段；只返回可用状态。

Linux 容器构建时启用 `NEXT_STANDALONE=true`，并核对全部依赖追踪清单，缺失运行文件会直接使镜像构建失败。本地 `npm run build` 使用常规生产构建，避免 Windows 独立包复制阶段的权限错误。

应用镜像只包含 Next.js standalone 运行文件、静态资源和迁移，不复制本地账号库、个人原文、`.env.local`、测试产物及开发依赖。不要开放数据库端口或把 `.data` 目录当作网页目录。

这里的代理配置关闭了缓存和响应缓冲，支持 AI 流式回答。若前面还有 CDN，`/api/*` 也应绕过缓存。参考 [Nginx 代理缓冲说明](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)。

## 更新与备份

更新前备份数据库，并另行备份 `KEY_ENCRYPTION_SECRET` 与 `BETTER_AUTH_SECRET`。升级镜像时保留相同密钥；直接更换加密主密钥会使已有用户的模型 Key 无法解密。

```sh
docker compose exec -T db pg_dump -U shiyi -d shiyi -Fc -f /tmp/shiyi.dump
docker compose cp db:/tmp/shiyi.dump ../shiyi-backup.dump
docker compose exec -T db rm /tmp/shiyi.dump
docker compose up -d --build --wait
```

备份文件包含账号与私有数据，应保存在项目目录之外并复制到另一台机器。将自定义格式备份恢复到独立的空数据库后核对账号、题库和记录，再切换流量；不要在没有验证备份的情况下覆盖现有数据库。参考 [PostgreSQL 备份工具](https://www.postgresql.org/docs/17/app-pgdump.html)。`docker compose down` 保留数据卷；不要加 `-v`。

本地开发使用的 PGlite 与服务器 PostgreSQL 不是同一个数据目录。首次上云时需要将现有账号、题库和历史一起迁移；仅复制项目或个人 JSON 导出不会迁移登录账号与模型密钥。当前本地数据保留原位，待目标数据库确定后做迁移与校验。

## 运行边界

- 当前按单个应用实例部署，认证限流及 AI 并发计数保存在进程内。多实例前需共享限流状态；数据库迁移已有锁保护。
- 外部托管 PostgreSQL 可改用 `DATABASE_URL`；TLS/CA 按数据库服务配置，不关闭证书校验。
- 邮件验证与密码找回尚未接入。开放给陌生用户注册前应配置邮件服务并验证找回流程。
- 本机没有 Docker、Nginx 或标准 PostgreSQL 服务，这套容器与代理配置仍需在目标服务器执行上述检查。
