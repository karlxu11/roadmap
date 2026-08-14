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
| `AMAP_JS_KEY` | 变量 | 高德“Web端（JS API）”Key |
| `AMAP_SECURITY_CODE` | 加密机密 | 高德 JS API 安全密钥 |
| `AMAP_WEB_SERVICE_KEY` | 加密机密 | 高德“Web服务”Key |
| `SITE_PASSWORD` | 加密机密 | 打开编辑网站时使用的访问密码；只读分享链接不需要密码 |

保存变量后重新部署。网站会通过 `/api/amap-config` 自动读取配置；也可以继续在网页设置里使用当前浏览器本地配置。

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

部署后，网站会优先从 KV 读取路书；第一次连接时会把现有浏览器里的路书迁移到 KV。之后点击“保存路书”会写入云端，浏览器本地只作为临时缓存。

## 使用说明

- 顶部“我的路书”可以在多条行程之间切换；“＋ 新路书”可以创建一条独立保存的新行程。
- 编辑页“分享路书”会复制一个只读分享链接。部署配置 KV 时，分享快照保存到 KV、链接只携带短 token；本地未配置 KV 时兼容内嵌快照链接。快照包含分享时的地点路径、每段距离与驾驶时间、高速费；打开分享链接不会加载或调用高德，也不能编辑行程。
- 编辑页的“导出 PDF”会打开浏览器打印窗口，选择“存储为 PDF”即可分享完整路书。导出内容包含封面、所有天数和地点，不包含编辑界面。
- 高德路线结果会按起终点坐标、路线策略缓存 24 小时；浏览器先读取本地缓存，配置 `AMAP_WEB_SERVICE_KEY` 和 `ROADBOOK_KV` 后 Worker 还会使用共享 KV 缓存。首次只计算当前天，打开累计高速费时才补算前面天数；只有地点坐标或顺序变化后才重新计算。

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
