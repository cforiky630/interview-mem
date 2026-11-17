# 拾忆 · SHIYI

桌面优先、手机自适应的面试学习 Web 应用。整理题目，用间隔复习建立记忆，划选不懂的句子向 AI 追问。

[桌面预览](docs/notebook-home-desktop.png) · [手机预览](docs/notebook-home-mobile.png) · [段落默写](docs/notebook-paragraph-desktop.png) · [验证记录](docs/VERIFICATION.md)

## 本地运行

需要 Node.js **24 或更新版本**。

```powershell
cd F:\Project\interview-memory
npm ci
npm run dev
```

打开 <http://localhost:3000>，创建自己的账号。首次启动会生成独立随机密钥，保存于忽略提交的 `.env.local`，并自动应用数据库迁移。数据库落盘到 `.data/postgres`，重启不会丢失。不要同时启动多个进程访问同一份嵌入式数据库。

局域网访问：开发服务已监听 `0.0.0.0:3000`。在 `.env.local` 中设置 `BETTER_AUTH_TRUSTED_ORIGINS=http://你的局域网IP:3000`（多个地址用逗号分隔，不加空格），重启 `npm run dev`，并在系统防火墙允许局域网设备访问 TCP 3000 端口。其他设备打开该地址即可；`localhost` 仍可使用。此配置同时允许登录、接口写入及 Next.js 开发资源访问。

没有安装 PostgreSQL 或 Docker 也能体验：开发环境使用 PGlite（嵌入式 PostgreSQL）。填写 `DATABASE_URL` 后会使用标准 PostgreSQL，表结构、Drizzle 查询与迁移一致。生产环境默认要求标准 PostgreSQL。

账号不预置默认密码。首页可载入明确标注的示例面试题，也可直接导入自己的资料。

## 已实现的功能

- 邮箱密码注册、登录、退出和账号数据隔离。
- 多题库、题目搜索、标签、收藏、待整理、归档与恢复。
- 粘贴后自动入库，可关闭自动入库；识别 Markdown 标题、Q/A 和编号题目，保留代码块、答案列表与原始资料；重复内容跳过。
- Tiptap 富文本答案编辑、Markdown 阅读及独立个人笔记。浏览器中保留尚未保存的导入/笔记草稿，草稿按账号区分。
- 整题默写和口述答题；对照参考答案后自评，作答随复习记录按账号保存，可在回顾记录中展开。
- 段落原地默写，支持单段、嵌套列表中的单个要点或整篇遮挡，对照后可重写。草稿按账号、题目版本和段落保存在当前浏览器；不会覆盖参考答案。
- 正文、追问、笔记、记忆分栏；面试追问用独立卡片切换并按需翻答案。AI 侧栏默认收起，划选仍可随时提问。
- FSRS-7 调度，先回忆再展开答案、四档评分、下次复习时间、单题预测遗忘曲线、学习热力图与历史记录。
- 复习事件幂等、复习状态和笔记的版本检查；重复提交不会重复推进记忆状态。
- 每人填写 OpenAI 兼容接口的 Base URL、API Key 与模型名；提供 OpenAI、DeepSeek、自定义预设。密钥按用户加密保存，支持替换、删除和测试连接。
- 答案中划选文字后解释、举例、追问；右侧 AI 对话栏，手机底部面板；流式回答、多轮对话、引用快照和内容版本保留；解释可以保存为私人笔记或独立卡片。
- 题库草稿与发布版本分开。公开发布或通过链接分享，其他用户可持续订阅；作者发布新版本才会传播修改；更新不覆盖订阅者的笔记和复习状态。
- 重要知识修正提醒重新复习；归档题目仍保留历史；取消订阅停止接收更新，重新订阅后原有学习状态仍可恢复。
- 个人数据 JSON 导出，包含原文、笔记、完整复习历史和对话，不包含 API Key。
- 明暗主题、每日目标、中文排版和响应式界面。

第一版以联网使用为主；页面打开、重新获得焦点和每分钟会读取云端最新状态。没有离线同步或 PWA 安装能力。

## 导入方式

打开“导入面试题”，先选择目标题库，再粘贴：

````markdown
## 什么是闭包？

闭包是函数与其词法环境的组合。

```javascript
function counter() {
  let n = 0;
  return () => ++n;
}
```

## 什么是事件循环？

先说明调用栈，再解释任务与微任务的执行时机。
````

默认粘贴后 1.2 秒自动入库；也可关闭该选项，检查预览后手动导入。标准解析不调用模型。答案缺失的题目进入“待整理”。AI 整理需用户先配置自己的 Key，每次最多 25000 字符；原文会先保存，失败可切换标准解析重试。完整原文也包含在数据导出中。

## 本次原题库导入

已将 `F:\tools\repositorys\interview` 的资料快照导入本地认领账号的私有题库：8 道 RAG 主问题、28 道追问，以及 1 份独立复习笔记。每个原始 Markdown 文件作为完整资料卡保留，追问仅在阅读界面独立显示，索引仅留作原文记录。全部 10 份文件的原始字节副本位于 `content/interview-original/`，清单与 SHA-256 位于 `content/interview-manifest.json`。

[内容校验报告](docs/content-review-2026-11-14.md) 记录了 10 处内容问题及其来源。校验说明独立于答案，阅读页可展开；没有回写或改排原文。阅读器支持原文中的 Obsidian 关联链接、追问 callout、表格与数学公式。后续自行编辑答案时，既有校验会提示其针对导入版本。

导入脚本会核对快照哈希，重复执行不重建卡片或清空学习状态；同一路径的原文有变化时会停止，需重新核验后处理。源目录在导入期间发生过外部编辑，本次以清单记录的快照为准。

```powershell
# 仅校验快照并生成报告
npm run library:import -- --source content/interview-original --dry-run
# 导入或核对某个已经存在的账号（将占位符替换为账号 UUID）
npm run library:import -- --source content/interview-original --owner <OWNER_UUID>
```

账号密码不存入脚本、报告或版本库。注册密码最低长度为 8 位。

## AI 与密钥

设置 → AI 连接 → 选择预设，填写 Base URL、API Key 与模型名 → 保存连接。测试连接使用当前表单，测试本身不保存或替换配置；短请求产生的费用计入用户自己的模型服务账号。普通导入和复习不需要 Key。

统一使用 OpenAI Chat Completions 协议。预设只填入地址和模型建议，模型名仍可手动修改；聊天、AI 导入和连接测试共用同一份连接配置。Base URL 填接口根路径（例如 `https://api.example.com/v1`），也兼容粘贴完整的 `/chat/completions` 地址。DeepSeek 预设参考[官方兼容说明](https://api-docs.deepseek.com/)，OpenAI 请求参数参考[Chat Completions 文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。

省略 Key 时仅保留相同 Base URL 下已保存的 Key；换到其他接口后需要重新填写。原有 DeepSeek 配置会保留原模型和加密密钥，迁移后仍走原地址。

自定义地址使用公网 HTTPS，拒绝 URL 中的账号密码及查询参数，不跟随重定向；DNS 检查后的地址直接用于连接。若本机代理使用 `198.18.0.0/15` 虚拟地址，OpenAI 和 DeepSeek 官方来源可直接使用；其他网关由服务器管理员在 `.env.local` 中配置准确的 `AI_PROXY_TRUSTED_ORIGINS=https://your-gateway.example.com`，多个来源用逗号分隔。此配置只允许代理虚拟网段，仍不开放回环、私网和云元数据地址。

随文对话只发送当前题目、选文及有限的当前对话上下文；AI 整理发送本次粘贴的资料。输出不会自动替换原答案。

密钥是**服务端托管加密**：应用服务器在请求模型时会解密使用，不能把这称为端到端加密。`KEY_ENCRYPTION_SECRET` 应与数据库分开保存并备份；直接更换该主密钥会让已有用户 Key 无法解密，需迁移或让用户重新配置。密钥不会返回页面，也不应进入日志或数据导出。

## 订阅规则

1. 作者编辑的是草稿，点击“发布题库 / 发布更新”生成不可变的内容快照。
2. 公开题库显示在“发现题库”；仅链接题库通过订阅链接访问。
3. 订阅者自动读取最新发布版本，看到更新提示；题目使用稳定 ID，与个人学习数据关联。
4. 文字修改保留原调度；标记为重要知识修正时提示重新复习，不删除历史。
5. 订阅者不能修改作者原题，可写个人笔记、保存 AI 补充或另存独立副本。
6. 作者归档题目后重新发布，该题退出常规复习，但原笔记与记录保留。AI 对话保留当时的选文、答案快照和版本。

这里的“订阅”表示持续接收内容更新，当前不涉及付费订阅。

## 验证

```powershell
npm run typecheck
npm test
npm run test:e2e
npm run build
```

核心与后端集成测试使用内存 PostgreSQL，验证导入、FSRS、密钥加密、账号隔离、版本发布、订阅、笔记冲突、复习幂等和导出。AI 调用使用模拟流，不使用真实密钥或产生模型费用。

浏览器测试使用独立的 `.data/e2e-postgres`、`.next-e2e` 和 3107 端口，不写入日常开发数据库。Windows 默认使用已安装的 Chrome；其他平台需要先执行 `npx playwright install chromium`。首次测试前先运行一次 `npm run dev` 生成本地配置。测试保存电脑和手机截图到 `test-results/`。

## 云端部署

同一应用部署到服务器后，电脑和手机访问同一个 HTTPS 地址，使用相同账号即可同步。

可使用提供的 `Dockerfile` 和 `compose.yaml`（需自行准备 Docker 及域名/HTTPS 反向代理）。项目根目录创建忽略提交的 `.env`，填写：

```dotenv
BETTER_AUTH_URL=https://your-domain.example
BETTER_AUTH_SECRET=GENERATE_A_RANDOM_SECRET
KEY_ENCRYPTION_SECRET=GENERATE_A_DIFFERENT_RANDOM_SECRET
POSTGRES_PASSWORD=GENERATE_AN_ALPHANUMERIC_PASSWORD
```

每次运行下面的命令生成一个独立随机值。不要将真实值提交到 Git：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
docker compose up -d --build
```

反向代理连接 `127.0.0.1:3000`，AI 流式接口需关闭代理缓冲。请备份 PostgreSQL 数据与加密主密钥。当前限流在单应用进程内生效；扩展到多实例前需增加共享限流和迁移协调。Docker / 标准 PostgreSQL 的部署配置需在目标服务器实际验证。

本地生产构建体验可设置 `ALLOW_LOCAL_DATABASE=true` 再执行 `npm run start`，但必须先停止开发服务器，避免两个进程操作同一嵌入式数据库。

## 项目结构

```text
src/app/              Next.js 页面与按领域划分的 API
src/components/       题库、阅读、复习、AI 与设置界面
src/server/           权限、内容版本、AI 调用、加密与调度
src/db/               Drizzle PostgreSQL 表结构与连接
src/lib/              导入解析、客户端类型与工具
drizzle/              已生成的 SQL 迁移
tests/                核心、后端集成与浏览器流程测试
```

后续功能：完整备份恢复、邮件验证与密码重置、批量管理、离线复习、更多模型供应商。当前未接入邮件服务，忘记密码后不能通过页面自助重置；公开运营前应补齐邮件验证/找回和目标环境的运维验证。
