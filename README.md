# 路书 · ROAM NOTE

一个更容易编辑多日行程的高德路书工作台，基于
[vinext](https://github.com/cloudflare/vinext) 和 Cloudflare Workers。

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

## Cloudflare 部署

完成 Cloudflare 登录后，在项目根目录执行：

```bash
npx wrangler login
npm run deploy
```

部署命令会先生成 Workers 产物，再发布到 Cloudflare Workers，并使用免费的静态资源托管能力。高德 JS API Key 可以在网站内“配置地图”中保存；正式上线后建议把 Web 服务 Key 和安全密钥迁移到 Cloudflare 的环境变量或后端代理中。

部署后，在 Cloudflare Worker 的“设置 → 变量和机密”中添加：

| 名称 | 类型 | 值 |
| --- | --- | --- |
| `AMAP_JS_KEY` | 变量（可选） | 首次创建 admin 时使用的高德“Web端（JS API）”Key |
| `AMAP_SECURITY_CODE` | 加密机密（可选） | 首次创建 admin 时使用的高德 JS API 安全密钥 |
| `AMAP_WEB_SERVICE_KEY` | 加密机密（可选） | 首次创建 admin 时使用的高德“Web服务”Key |
| `SITE_PASSWORD` | 加密机密（可选） | 未启用账号模式时，打开编辑网站使用的访问密码；账号模式使用 `admin`/用户账号登录 |
| `allowregister` | 变量 | 设置为 `1` 后显示用户注册入口；关闭注册可删除该变量或改为其他值 |

保存变量后重新部署。网站会通过 `/api/amap-config` 自动读取配置；也可以继续在网页设置里使用当前浏览器本地配置。

账号模式下，用户注册时会填写自己的 3 项高德凭据并保存到 KV。确认 admin 已经拥有可用的个人高德配置后，上面 3 个全局变量可以删除；首次创建 admin 时如果没有这些变量，需要登录后在「配置地图」中手动填写。

## 用户注册与账号隔离

配置 `ROADBOOK_KV` 后，将 Cloudflare Worker 的变量 `allowregister` 设置为 `1`，刷新网站即可看到注册入口。注册页要求填写用户名、密码，以及下面 3 项高德凭据：

1. **Web 端（JS API）Key**
2. **安全密钥 `securityJsCode`**
3. **Web 服务 Key**

获取方式：登录[高德开放平台控制台](https://console.amap.com/dev)，进入「应用管理」创建应用；添加一个「Web 端（JS API）」Key，复制 Key 和安全密钥；再添加一个「Web 服务」Key。注册页也提供了对应的官方说明链接。

账号、密码哈希、高德凭据、路书和分享链接都会按用户写入 KV。浏览器本地缓存也按账号分开，切换账号不会读取其他账号的路书。

首次启用账号模式时，Worker 会自动创建 `admin` 用户，初始密码为用户指定的 `nsnkarlxu`，并将现有的 `AMAP_JS_KEY`、`AMAP_SECURITY_CODE`、`AMAP_WEB_SERVICE_KEY` 绑定给它。已有 admin 的非空个人配置不会在每次请求时被环境变量覆盖；可以登录后在「配置地图」中修改。建议首次登录后关闭 `allowregister`，只允许已有账号登录。

## 云端保存（Workers KV）

路书数据现在支持保存到 Cloudflare Workers KV。Workers Free 目前包含每天 10 万次读取、1000 次写入和 1GB 存储，个人使用通常足够；KV 是最终一致性的，同一条数据不要连续快速保存多次。

第一次启用时：

1. 在 Cloudflare 控制台创建一个 KV Namespace，例如 `ROADBOOK_KV`。
2. 复制这个 Namespace 的 ID，在本地部署时设置 `ROADBOOK_KV_NAMESPACE_ID`。
3. 重新部署，例如：

```bash
ROADBOOK_KV_NAMESPACE_ID="你的 KV Namespace ID" npm run deploy
```

注意：本项目的 `npm run deploy` 会使用构建生成的 Wrangler 配置发布 Worker。Cloudflare 控制台里单独添加的 KV 绑定不会自动合并到这份配置中；如果不传 `ROADBOOK_KV_NAMESPACE_ID`，部署会主动停止，避免用空的 `kv_namespaces` 覆盖已有绑定。这个 ID 可以在 KV 命名空间详情页查看，命名空间本身和其中的数据不会因部署而被删除。

不想每次输入的话，可以在项目根目录创建本地忽略文件 `.env.local`，写入：

```bash
ROADBOOK_KV_NAMESPACE_ID="你的 KV Namespace ID"
```

部署脚本会自动读取 `.env.local`，之后直接执行 `npm run deploy` 即可；命令行临时传入的环境变量优先级更高。

部署后，网站会优先从 KV 读取路书；账号模式下每个账号使用独立的 KV 记录，浏览器本地只作为该账号的临时缓存。未启用账号模式时，继续使用原有的单密码/本地兼容模式。

## 使用说明

- 顶部“我的路书”可以在多条行程之间切换；“＋ 新路书”可以创建一条独立保存的新行程。
- 编辑页“分享路书”会复制一个分享链接。分享链接是只读快照，不会自动创建可编辑路书；同一条路书可以生成多条分享链接，因此“分享管理”的链接数和“我的路书”的可编辑路书数不必相等。部署配置 KV 时，分享快照保存到 KV、链接只携带短 token；之后保存路书会自动同步该路书现有的云端分享链接，无需重新发送 URL。本地未配置 KV 时兼容内嵌快照链接，这类链接的数据写在 URL 中，无法自动更新。快照包含地点路径、每段距离与驾驶时间、高速费；打开分享链接不会加载或调用高德，也不能编辑行程。
- 编辑页的“导出 PDF”会打开浏览器打印窗口，选择“存储为 PDF”即可分享完整路书。导出内容包含封面、所有天数和地点，不包含编辑界面。
- 高德路线结果会按起终点坐标、路线策略缓存 24 小时；浏览器先读取本地缓存，配置 `AMAP_WEB_SERVICE_KEY` 和 `ROADBOOK_KV` 后 Worker 还会使用共享 KV 缓存。左栏会补齐全部路段以汇总每日与全程里程；只有地点坐标或顺序变化后才重新计算。

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Email and name are intended for display or contact purposes.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
