# 加油记 Cloudflare 网页控制台部署指南

本文面向不想在本机执行 Wrangler 命令、希望主要通过 Cloudflare 网页控制台完成部署的人员。

这一版流程尽量使用网页操作：

- Cloudflare 控制台创建 D1 数据库。
- Cloudflare 控制台创建 R2 存储桶。
- GitHub 网页编辑 `wrangler.jsonc`。
- Cloudflare 控制台连接 GitHub 仓库并自动部署 Worker。
- Cloudflare D1 控制台执行初始化 SQL。
- 应用注册第一个账号，再在 D1 控制台提升为管理员。

说明：Cloudflare 网页控制台不能直接修改你的 Git 仓库文件，因此仍需要在 GitHub 网页里改一次 `wrangler.jsonc`。全程不需要在本机运行命令行。

## 1. 总体架构

```text
用户浏览器
  ↓
Cloudflare Worker
  ├─ Workers Static Assets：前端 HTML / CSS / JS
  ├─ D1：用户、车辆、加油记录、会话、2FA、设置
  └─ R2：加油票据、截图、附件
```

## 2. 准备事项

部署人员需要：

- 一个 Cloudflare 账号。
- 一个 GitHub 账号。
- 能访问项目仓库：https://github.com/mossexplore/fuellog
- 一个准备作为管理员的用户名。

建议先 fork 一份仓库到自己的 GitHub 账号或组织下，避免把自己的 Cloudflare 资源 ID 提交到原始仓库。

## 3. Fork 项目仓库

1. 打开 GitHub 仓库：

   ```text
   https://github.com/mossexplore/fuellog
   ```

2. 点击右上角 `Fork`。
3. 选择自己的 GitHub 账号或组织。
4. Fork 完成后，后续都在自己的 fork 仓库里操作。

假设 fork 后地址类似：

```text
https://github.com/<你的 GitHub 用户名>/fuellog
```

## 4. 在 Cloudflare 创建 D1 数据库

1. 打开 Cloudflare Dashboard。
2. 进入 `Storage & databases`。
3. 进入 `D1 SQL Database`。
4. 点击 `Create database`。
5. 数据库名称填写：

   ```text
   fuellog
   ```

6. Location 可以保持默认，或按自己的合规要求选择区域。
7. 点击 `Create`。
8. 创建完成后，进入该 D1 数据库的详情页。
9. 找到数据库的 `database_id`，复制保存。

后面需要把这个 ID 填到 `wrangler.jsonc`。

## 5. 在 Cloudflare 创建 R2 存储桶

1. 打开 Cloudflare Dashboard。
2. 进入 `Storage & databases`。
3. 进入 `R2 Object Storage`。
4. 点击 `Create bucket`。
5. Bucket 名称填写：

   ```text
   fuellog-attachments
   ```

6. Location 保持默认即可，或按自己的合规要求选择区域。
7. 点击 `Create bucket`。

R2 bucket 不需要公开访问。项目里的附件会通过 Worker 登录鉴权后读取，保持私有更安全。

## 6. 在 GitHub 网页编辑 wrangler.jsonc

打开自己 fork 后的 GitHub 仓库，找到：

```text
wrangler.jsonc
```

点击编辑，把 D1 的 `database_id` 从占位值：

```jsonc
"database_id": "00000000-0000-0000-0000-000000000000"
```

改为你刚才在 Cloudflare D1 页面复制到的真实 ID。

确认 R2 bucket 名称和你创建的一致：

```jsonc
"bucket_name": "fuellog-attachments"
```

如果你想给 Worker 换一个名字，也可以修改：

```jsonc
"name": "fuellog"
```

例如：

```jsonc
"name": "my-fuellog"
```

注意：如果后续在 Cloudflare 创建或连接已有 Worker，Cloudflare Workers Builds 要求控制台里的 Worker 名称与 `wrangler.jsonc` 中的 `name` 保持一致。

保存提交到 `main` 分支。

## 7. 初始化 D1 数据库表结构

打开自己 fork 后的 GitHub 仓库，找到：

```text
schema.sql
```

点击 `Raw`，复制全部 SQL 内容。

然后回到 Cloudflare：

1. 打开 `Storage & databases`。
2. 进入 `D1 SQL Database`。
3. 选择刚创建的 `fuellog` 数据库。
4. 进入 `Console` 或 `Query` 页面。
5. 粘贴 `schema.sql` 的全部内容。
6. 点击执行。

如果控制台不接受一次执行全部 SQL，可以按 `CREATE TABLE ...;`、`CREATE INDEX ...;` 为单位分段粘贴执行。

执行完成后，建议再运行：

```sql
SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;
```

正常应该能看到类似这些表：

```text
attachments
auth_challenges
backup_codes
captchas
fuel_records
login_attempts
login_events
sessions
settings
users
vehicles
```

## 8. 临时打开注册

为了避免在网页流程里生成密码哈希，推荐先临时打开注册，让应用自己创建第一个账号；然后再通过 D1 控制台把这个账号提升为管理员。

在 D1 控制台执行：

```sql
INSERT INTO settings (key, value)
VALUES ('registration_open', '1')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```

这表示临时允许用户注册。

## 9. 在 Cloudflare 连接 GitHub 仓库并部署 Worker

1. 打开 Cloudflare Dashboard。
2. 进入 `Workers & Pages`。
3. 点击 `Create application`。
4. 选择 `Import a repository`。
5. 点击 `Get started`。
6. 连接 GitHub 账号。
7. 授权 Cloudflare 访问你的 fork 仓库。
8. 选择仓库：

   ```text
   <你的 GitHub 用户名>/fuellog
   ```

9. 配置项目：

   ```text
   Project name / Worker name: fuellog
   Production branch: main
   Root directory: /
   Build command: 可留空
   Deploy command: npx wrangler deploy
   ```

   如果你在 `wrangler.jsonc` 里把 `"name"` 改成了 `my-fuellog`，这里的 Worker name 也要用 `my-fuellog`。

10. 保存并部署。

部署完成后，Cloudflare 会给出一个 `workers.dev` 地址，例如：

```text
https://fuellog.<your-subdomain>.workers.dev
```

如果部署失败，先看 Build Logs。最常见原因是：

- `wrangler.jsonc` 里的 `database_id` 仍是占位值。
- Worker name 与 `wrangler.jsonc` 的 `"name"` 不一致。
- R2 bucket 名称与 `wrangler.jsonc` 不一致。

## 10. 注册第一个账号

打开部署后的地址：

```text
https://fuellog.<your-subdomain>.workers.dev/register.html
```

注册一个准备作为管理员的账号。

注册完成后先不要急着正式使用，因为此时它还是普通用户。

## 11. 把第一个账号提升为管理员

回到 Cloudflare D1 控制台，执行下面的 SQL。把 `admin` 替换成你刚注册的用户名：

```sql
UPDATE users
SET role = 'admin', enabled = 1
WHERE username = 'admin';
```

确认结果：

```sql
SELECT id, username, role, enabled FROM users;
```

看到该用户的 `role` 是 `admin` 即可。

## 12. 关闭公开注册

如果只是个人使用，建议创建管理员后立刻关闭注册。

在 D1 控制台执行：

```sql
INSERT INTO settings (key, value)
VALUES ('registration_open', '0')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```

后续如需开放注册，可以由管理员登录应用，在管理页里打开“允许新用户注册”。

## 13. 管理员首次登录和绑定 2FA

访问：

```text
https://fuellog.<your-subdomain>.workers.dev/login.html
```

用刚提升为管理员的账号登录。

管理员首次登录时，系统会要求绑定两步验证：

1. 使用 Google Authenticator、Microsoft Authenticator、1Password 等 App 扫描二维码。
2. 输入 6 位验证码完成绑定。
3. 保存系统生成的备用恢复码。

备用恢复码只显示一次，请立即保存到安全位置。

## 14. 验证功能

建议按下面顺序检查：

1. 登录后能进入仪表盘。
2. 顶部能看到“账户”入口。
3. 管理员能看到“管理”入口。
4. 进入记录页，新增一条加油记录。
5. 上传一张票据或截图附件。
6. 查看仪表盘统计是否更新。
7. 导出 CSV 是否正常。
8. 如果需要普通用户注册，在管理页临时打开注册，再注册普通用户测试。

## 15. 绑定自定义域名

如果只做测试，可以直接使用 `workers.dev` 地址。

如果要绑定自己的域名，例如：

```text
car.example.com
```

在 Cloudflare 控制台操作：

1. 进入 `Workers & Pages`。
2. 选择本项目 Worker。
3. 进入 `Settings` 或 `Triggers`。
4. 找到 `Domains and Routes`。
5. 点击添加自定义域名。
6. 输入域名，例如 `car.example.com`。
7. 按提示完成 DNS 和证书配置。

域名必须属于当前 Cloudflare 账号中可管理的 zone。

## 16. 后续更新部署

使用 Workers Builds 连接 GitHub 后，后续只要 `main` 分支有新提交，Cloudflare 会自动构建和部署。

协作者日常更新方式：

1. 在 GitHub fork 仓库中同步上游代码。
2. 合并到自己的 `main` 分支。
3. Cloudflare Workers Builds 自动触发部署。
4. 在 Cloudflare 的 Worker 页面查看部署记录和构建日志。

如果某次更新包含新的数据库迁移文件，例如：

```text
migrations/0002_xxx.sql
```

需要先在 Cloudflare D1 控制台执行该迁移 SQL，再完成应用更新验证。

## 17. 常见问题

### 17.1 Import repository 后构建失败

进入 Worker 的部署详情，查看 Build Logs。

重点检查：

- `wrangler.jsonc` 的 `"name"` 是否等于 Cloudflare Worker 名称。
- `database_id` 是否已经换成真实 D1 ID。
- `bucket_name` 是否等于实际 R2 bucket 名。
- GitHub 仓库是否授权给了 Cloudflare。

### 17.2 页面能打开，但登录后报数据库错误

通常是 D1 还没有初始化表结构。

回到 D1 控制台执行 `schema.sql`。

### 17.3 注册页面提示注册关闭

在 D1 控制台执行：

```sql
INSERT INTO settings (key, value)
VALUES ('registration_open', '1')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```

注册完第一个管理员后，记得再改回 `'0'`。

### 17.4 管理员看不到管理入口

可能是账号还没有提升为管理员。

在 D1 控制台检查：

```sql
SELECT username, role, enabled FROM users;
```

如果需要提升：

```sql
UPDATE users SET role = 'admin', enabled = 1 WHERE username = '你的用户名';
```

然后退出应用重新登录。

### 17.5 附件上传失败

检查 R2：

- R2 bucket 是否存在。
- bucket 名称是否与 `wrangler.jsonc` 一致。
- Worker 是否已经重新部署。

项目配置里的 R2 binding 名称必须保持为：

```text
R2
```

### 17.6 不想把真实 database_id 提交到原始仓库

正确做法是：

1. Fork 到自己的仓库。
2. 只在自己的 fork 中填写真实 `database_id`。
3. 不要向原始仓库提交包含真实 `database_id` 的 Pull Request。

## 18. 安全注意事项

- 不要公开 Cloudflare API Token。
- 不要公开 D1 数据库 ID、账号密码、Cookie、Session、2FA 密钥、备用恢复码。
- R2 bucket 保持私有，不要设置 Public Bucket。
- 第一个管理员创建完成后关闭注册。
- 管理员必须绑定 2FA，并妥善保存备用恢复码。
- 多人部署时，每个人使用自己的 D1、R2、Worker 和域名，不要共用生产资源。

## 19. 参考资料

- Cloudflare Workers Builds：https://developers.cloudflare.com/workers/ci-cd/builds/
- Workers Builds 配置：https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- Cloudflare GitHub Integration：https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/
- D1 创建和绑定：https://developers.cloudflare.com/d1/get-started/
- R2 创建 Bucket：https://developers.cloudflare.com/r2/buckets/create-buckets/
- Workers 绑定 D1：https://developers.cloudflare.com/d1/best-practices/remote-development/
- Workers 自定义域名：https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
