# 加油记

加油记是一个面向个人车主的轻量油耗记录网站，适合在加油现场用手机快速录入数据，并在云端保存、统计和导出。项目使用 TypeScript、Hono、Cloudflare Workers、D1 和 R2，前端为原生 HTML/CSS/JavaScript，图表使用 Chart.js。

## 功能特性

### 安全登录

登录需要先通过图形验证码（服务端生成的扭曲矢量图形，答案不出现在页面源码中），再校验用户名密码；开启两步验证的账号还需要输入认证器上的 6 位 TOTP 验证码或一次性备用恢复码。普通用户和管理员都可在账户页自助开启、关闭或重置两步验证，管理员也可以选择不启用 2FA。会话存储在 D1 中，便于登出和主动吊销；登录接口带 IP 限速，防止暴力破解。

![登录演示](docs/gifs/login.gif)

### 截图识别快速记录

录入页面向手机场景优化：上传加油截图后在浏览器本地完成 OCR 识别，自动回填日期、时间、油价、加油量、金额、油品和加油站，并以高亮提示所有自动填充的字段，识别所用的截图会自动保存为该记录的附件。OCR 完全在本地浏览器中进行，截图不会上传到任何云端识别服务，最大限度保护票据、位置和消费等隐私数据。OCR 模型资源通过当前 Worker 代理下载并缓存，避免浏览器直接访问 GitHub 原始资源失败；代理域名来自 `APP_ORIGIN` 或当前访问域名，不需要在前端代码里写死生产域名。当前里程由车主手动确认；机器显示金额和实付金额可分别记录，便于保留优惠和折扣信息。

![记录油耗演示](docs/gifs/record-fuel.gif)

### 仪表盘统计

仪表盘展示平均油耗、最近一箱油耗、每公里油费、累计里程、累计油费、累计加油量、平均油价、今年里程和今年油费，并提供分段油耗、每公里油费、油价趋势、月度油费、月度里程和年度对比共 6 张趋势图。平均油耗按“两次加满之间的实际补油量”加权计算，避免非加满记录造成误差。

![仪表盘演示](docs/gifs/dashboard.gif)

### 记录管理与数据迁移

记录按时间倒序分页展示，移动端以卡片形式突出分段油耗、每公里油费、里程、油价、加油量、金额、行驶距离和是否加满，编辑与删除收纳在右上角更多菜单里。每条加满记录直接显示该箱油的分段油耗（升/百公里）和每公里油费，未加满记录显示为“待加满后计算”，统计即时重算。工具栏提供 CSV 导出、CSV 回导、腾讯出行 XLSX 历史数据迁移和需要二次确认的一键清空。

![记录管理演示](docs/gifs/records.gif)

### 用户注册与管理后台

支持多用户注册（管理员可随时开关注册入口，默认关闭），各用户数据完全隔离。管理员在后台可以查看全部用户的角色、状态、两步验证情况、最近登录时间与 IP、登录次数以及记录数和附件占用空间，并可停用/启用用户（停用即强制下线）、重置用户两步验证、删除用户及其全部数据。

![管理后台演示](docs/gifs/admin.gif)

### 更多能力

- 附件保存：支持为每条记录上传加油票据或截图到 Cloudflare R2，图片内联预览，其余类型按附件下载。
- 草稿附件：新增记录时先上传的截图会以草稿附件保存，保存记录后自动关联；超过 10 分钟仍未关联的草稿会被清理，避免临时附件堆积。
- 腾讯出行迁移：导入时根据“最新油耗”连续重复值推断加满分段，组内最新一条标记为加满，其余标记为未加满，首条新车基线记录也按未加满处理。
- 邮箱找回密码：用户可在账户页绑定或更换邮箱，通过 6 位邮件验证码找回密码；邮件发送带用户/IP 频率限制，适合使用 QQ 邮箱 SMTP。
- 登录审计：记录每次成功登录的时间、IP 和 User-Agent，供管理后台查询。
- 访问加速：核心前端依赖已本地化，Chart.js 和 XLSX 不再依赖第三方 CDN；XLSX 仅在导入腾讯出行文件时按需加载，`/assets/*` 静态资源使用长期缓存。

## 技术栈

- Runtime: Cloudflare Workers
- Backend: TypeScript + Hono
- Database: Cloudflare D1
- Object Storage: Cloudflare R2
- Frontend: HTML + CSS + JavaScript
- Charts: Chart.js（本地静态资源）
- Spreadsheet Import: SheetJS XLSX（本地静态资源，按需加载）

## 本地开发

```bash
npm install
npm run db:init:local

# 生成初始化用户 SQL。随机密码会输出到终端，SQL 文件只包含密码哈希。
node scripts/create-user.mjs <username> > user.sql
npx wrangler d1 execute fuellog --local --file=user.sql
rm user.sql

npm run dev
```

本地服务默认运行在 `http://localhost:8787`。

## Cloudflare 部署

详细的新环境部署、D1/R2 初始化、自定义域名和后续更新流程见：[Cloudflare Workers 部署操作指南](docs/cloudflare-worker-deploy-guide.md)。

如果希望主要通过 Cloudflare 网页控制台和 GitHub 网页完成部署，见：[Cloudflare 网页控制台部署指南](docs/cloudflare-dashboard-deploy-guide.md)。

1. 登录 Cloudflare：

```bash
npx wrangler login
```

2. 创建 D1 数据库，并把输出的 `database_id` 填入 `wrangler.jsonc`：

```bash
npx wrangler d1 create fuellog
```

3. 创建 R2 存储桶。如果使用不同名称，也同步修改 `wrangler.jsonc`：

```bash
npx wrangler r2 bucket create fuellog-attachments
```

4. 初始化远程数据库：

```bash
npm run db:init:remote
```

如果是从旧版本升级已有远程数据库，先执行一次账号与管理后台迁移：

```bash
npx wrangler d1 execute fuellog --remote --file=migrations/0001_accounts_admin.sql
```

5. 创建远程管理员：

```bash
node scripts/create-user.mjs <username> > user.sql
npx wrangler d1 execute fuellog --remote --file=user.sql
rm user.sql
```

6. 部署：

```bash
npm run deploy
```

部署后访问 `https://fuellog.<your-subdomain>.workers.dev`。

## 配置说明

`wrangler.jsonc` 中的 `database_id` 已使用占位值，首次部署前必须替换为你自己的 D1 数据库 ID。`APP_ORIGIN` 建议配置为生产访问地址，例如 `https://car.example.com`；如果未配置，服务端会自动使用当前请求域名作为兜底。OCR 模型代理、邮件模板中的站点地址等场景都会优先使用该配置。

如需启用邮箱绑定和密码找回，需要在 Cloudflare Worker 中配置 QQ 邮箱 SMTP 相关变量或 Secret：`MAIL_FROM`、`SMTP_USER`、`SMTP_PASS`，可选配置包括 `SMTP_HOST`、`SMTP_PORT` 和 `APP_ORIGIN`。其中 `SMTP_PASS` 应使用 Worker Secret，不要写入仓库。

仓库不应提交 `.dev.vars`、`.env*`、`user.sql`、`.wrangler/`、`node_modules/` 或任何包含密码、令牌、Cookie、会话、恢复码的文件。

## 项目结构

```text
src/index.ts              Hono Worker 入口：认证、记录 CRUD、附件、统计、CSV 导出
src/auth.ts               PBKDF2 密码哈希、会话 token、TOTP、备用恢复码
src/stats.ts              油耗与费用统计算法
public/                   前端页面与静态资源
public/assets/ocr.js      截图 OCR 解析辅助
public/assets/chart.umd.min.js  本地化 Chart.js
public/assets/xlsx.full.min.js  本地化 XLSX 解析库
schema.sql                D1 表结构
migrations/               既有 D1 数据库升级脚本
scripts/create-user.mjs   生成初始化用户 SQL
wrangler.jsonc            Cloudflare Workers、D1、R2 配置
```

## 安全提示

- 初始化用户脚本不会把明文密码写入 SQL 文件；随机密码只显示在终端，请立即保存。
- 两步验证绑定后，备用恢复码只显示一次；每个恢复码只能使用一次。
- 附件接口需要登录后访问，图片以内联方式预览，非图片按附件下载。
- OCR 识别过程在浏览器本地执行；Worker 只代理和缓存公开模型资源，不接收用于识别的截图内容。
