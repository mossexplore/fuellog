# 加油记 Cloudflare Workers 部署操作指南

本文面向从 GitHub 拉取本项目代码、并在自己的 Cloudflare 账号中部署“加油记”的协作者。

项目使用 Cloudflare Workers 承载后端 API 和静态前端资源，使用 D1 保存结构化数据，使用 R2 保存加油票据、截图等附件。

## 1. 准备条件

部署人员需要准备：

- 一个可用的 Cloudflare 账号。
- 本机已安装 Node.js，建议使用当前 LTS 版本。
- 本机已安装 Git。
- 能访问项目 GitHub 仓库。
- 一个用于登录加油记的管理员账号名。

Cloudflare 相关工具通过项目依赖里的 Wrangler 使用，无需全局安装。

## 2. 拉取代码

```bash
git clone https://github.com/mossexplore/fuellog.git
cd fuellog
npm install
```

确认 TypeScript 能正常编译：

```bash
npm exec -- tsc --noEmit
```

## 3. 登录 Cloudflare

```bash
npx wrangler login
```

命令会打开浏览器，按提示授权 Wrangler 访问 Cloudflare 账号。

如果部署人员使用的是服务器或 CI 环境，也可以使用 Cloudflare API Token，但不要把 Token 写入仓库、README、截图或聊天记录中。

## 4. 创建 D1 数据库

D1 用来保存用户、会话、车辆、加油记录、统计数据、2FA 状态等结构化数据。

```bash
npx wrangler d1 create fuellog
```

执行后 Cloudflare 会输出类似下面的绑定配置：

```json
{
  "binding": "DB",
  "database_name": "fuellog",
  "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

把输出中的 `database_id` 填入本地 `wrangler.jsonc`：

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "fuellog",
    "database_id": "你的 D1 database_id"
  }
]
```

注意：仓库里的 `database_id` 默认是占位值 `00000000-0000-0000-0000-000000000000`，真实 ID 属于部署环境信息，不建议提交回 GitHub。

## 5. 创建 R2 存储桶

R2 用来保存加油截图、票据附件等文件。

```bash
npx wrangler r2 bucket create fuellog-attachments
```

项目默认配置如下：

```jsonc
"r2_buckets": [
  {
    "binding": "R2",
    "bucket_name": "fuellog-attachments"
  }
]
```

如果你创建了不同名称的 bucket，需要同步修改 `wrangler.jsonc` 里的 `bucket_name`。

R2 bucket 不需要设置为公开访问。附件由 Worker 在登录校验后读取和返回，保持私有更安全。

## 6. 初始化远程数据库

首次部署新数据库时执行：

```bash
npm run db:init:remote
```

等价于：

```bash
npx wrangler d1 execute fuellog --remote --file=schema.sql
```

这一步会创建项目需要的全部表结构。

如果是升级很早之前部署过的旧数据库，而不是首次初始化，才需要额外执行迁移脚本：

```bash
npx wrangler d1 execute fuellog --remote --file=migrations/0001_accounts_admin.sql
```

新数据库已经通过 `schema.sql` 创建完整结构，不需要再执行该迁移。

## 7. 创建管理员账号

项目需要至少一个管理员账号，用来登录系统、管理注册开关、管理普通用户。

生成管理员初始化 SQL：

```bash
node scripts/create-user.mjs <管理员用户名> > user.sql
```

示例：

```bash
node scripts/create-user.mjs admin > user.sql
```

脚本会在终端输出随机密码，SQL 文件里只包含密码哈希，不包含明文密码。请立即保存终端显示的随机密码。

把管理员写入远程 D1：

```bash
npx wrangler d1 execute fuellog --remote --file=user.sql
```

执行成功后立刻删除临时 SQL：

```bash
rm user.sql
```

也可以指定初始密码：

```bash
node scripts/create-user.mjs admin '你的强密码' > user.sql
npx wrangler d1 execute fuellog --remote --file=user.sql
rm user.sql
```

安全建议：不要把明文密码写进 shell 历史、文档、截图或 Git 仓库。多人协作时，更推荐让脚本生成随机密码，然后通过安全渠道交付给管理员本人。

## 8. 部署 Worker

```bash
npm run deploy
```

等价于：

```bash
npx wrangler deploy
```

部署成功后，终端会输出类似：

```text
https://fuellog.<your-subdomain>.workers.dev
```

打开该地址即可访问。

首次使用管理员账号登录时，如果管理员尚未绑定两步验证，系统会引导绑定 Authenticator，并生成备用恢复码。

## 9. 验证部署结果

建议按下面顺序检查：

1. 打开 Workers 地址，确认自动进入登录页。
2. 用管理员账号和初始密码登录。
3. 按提示绑定两步验证，并保存备用恢复码。
4. 进入仪表盘，确认页面能正常加载。
5. 新增一条加油记录，确认记录可保存。
6. 上传一张附件，确认附件可预览或下载。
7. 进入记录页，确认 CSV 导出可用。
8. 如需开放注册，用管理员进入管理页打开“允许新用户注册”。

## 10. 绑定自定义域名

可以先使用 `workers.dev` 地址运行。生产环境建议绑定自己的域名，例如：

```text
car.example.com
```

常见做法：

1. 域名 DNS 托管在 Cloudflare。
2. 进入 Cloudflare Dashboard。
3. 打开 Workers & Pages。
4. 选择本项目 Worker，默认名称为 `fuellog`。
5. 进入 Settings 或 Triggers 中的 Domains and Routes。
6. 添加 Custom Domain，例如 `car.example.com`。
7. 等待证书和路由生效。

也可以在 `wrangler.jsonc` 中增加 routes 配置：

```jsonc
"routes": [
  {
    "pattern": "car.example.com",
    "custom_domain": true
  }
]
```

如果协作者只是部署自己的实例，请把域名替换为自己的域名，不要复用他人的生产域名。

## 11. 后续更新部署

后续从 GitHub 获取最新代码并重新部署：

```bash
git pull
npm install
npm exec -- tsc --noEmit
npm run deploy
```

如果更新说明中包含新的数据库迁移文件，需要先执行对应迁移，再部署或在维护窗口内按发布说明操作。

示例：

```bash
npx wrangler d1 execute fuellog --remote --file=migrations/xxxx.sql
npm run deploy
```

## 12. 本地开发和预览

初始化本地 D1：

```bash
npm run db:init:local
```

创建本地用户：

```bash
node scripts/create-user.mjs admin > user.sql
npx wrangler d1 execute fuellog --local --file=user.sql
rm user.sql
```

启动本地开发服务：

```bash
npm run dev
```

默认访问：

```text
http://localhost:8787
```

本地 D1 和远程 D1 是分开的。本地调试不会修改生产数据。

## 13. 敏感信息处理规范

不要提交以下内容：

- 真实的 D1 `database_id`。
- Cloudflare API Token。
- `.dev.vars`、`.env`、`.env.*`。
- `user.sql`。
- 明文密码。
- 登录 Cookie、Session Token。
- 2FA 密钥、备用恢复码。
- `.wrangler/`。
- `node_modules/`。

仓库已经通过 `.gitignore` 忽略常见敏感文件，但提交前仍建议执行：

```bash
git status --short
git diff --check
```

如果不小心生成了 `user.sql`，确认执行后立即删除：

```bash
rm user.sql
```

## 14. 常见问题

### 14.1 部署时报 `database_id` 无效

检查 `wrangler.jsonc` 是否仍然是占位值：

```jsonc
"database_id": "00000000-0000-0000-0000-000000000000"
```

需要替换为 `npx wrangler d1 create fuellog` 输出的真实 ID。

### 14.2 登录时报数据库表不存在

通常是忘记初始化远程数据库。执行：

```bash
npm run db:init:remote
```

如果是旧库升级，按发布说明执行对应 `migrations/` 文件。

### 14.3 附件上传失败

检查 R2 bucket 是否存在，且 `wrangler.jsonc` 中的 bucket 名称是否一致：

```bash
npx wrangler r2 bucket list
```

项目代码使用的 binding 名必须保持为：

```jsonc
"binding": "R2"
```

### 14.4 管理员无法进入管理页

确认用户的 `role` 是 `admin`。

如果是通过当前脚本创建的默认用户，默认就是管理员。如果是手动插入用户，需要保证 `users.role = 'admin'`。

可以用 D1 查询确认：

```bash
npx wrangler d1 execute fuellog --remote --command "SELECT id, username, role, enabled FROM users;"
```

### 14.5 普通用户无法注册

注册默认关闭。管理员登录后进入管理页，打开“允许新用户注册”。

### 14.6 不想把真实 `database_id` 改进 Git

真实 `database_id` 不属于密码，但它是部署环境信息。多人协作时建议：

1. 本地修改 `wrangler.jsonc` 后不要提交。
2. 提交前运行 `git diff wrangler.jsonc` 检查。
3. 如果需要 CI/CD，优先在 CI 中生成临时 Wrangler 配置文件，或使用独立的私有部署配置。

## 15. 参考资料

- Cloudflare Workers 文档：https://developers.cloudflare.com/workers/
- Wrangler 文档：https://developers.cloudflare.com/workers/wrangler/
- Workers Static Assets 文档：https://developers.cloudflare.com/workers/static-assets/
- D1 入门文档：https://developers.cloudflare.com/d1/get-started/
- D1 Wrangler 命令：https://developers.cloudflare.com/d1/wrangler-commands/
- R2 创建 bucket 文档：https://developers.cloudflare.com/r2/buckets/create-buckets/
- R2 Workers 使用文档：https://developers.cloudflare.com/r2/api/workers/workers-api-usage/
- Workers 自定义域名文档：https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
