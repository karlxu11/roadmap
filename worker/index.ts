/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  AMAP_JS_KEY?: string;
  AMAP_SECURITY_CODE?: string;
  AMAP_WEB_SERVICE_KEY?: string;
  SITE_PASSWORD?: string;
  ROADBOOK_KV?: KVNamespace;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const ACCESS_COOKIE = "roadbook_access";
const ACCESS_MAX_AGE = 60 * 60 * 24 * 30;
const ROADBOOK_STORAGE_KEY = "roadbooks:default";
const SHARE_STORAGE_PREFIX = "roadbook-share:";

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function createAccessToken(password: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("roadbook-access"));
  return toBase64Url(new Uint8Array(signature));
}

function getCookie(request: Request, name: string) {
  const cookieHeader = request.headers.get("Cookie") ?? "";
  return cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function isShareSnapshot(value: unknown): value is { version: 1; roadbook: { days: unknown[] }; legs: Record<string, unknown>; createdAt: string } {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return snapshot.version === 1 && typeof snapshot.createdAt === "string" && Boolean(snapshot.roadbook && typeof snapshot.roadbook === "object" && Array.isArray((snapshot.roadbook as { days?: unknown }).days)) && Boolean(snapshot.legs && typeof snapshot.legs === "object");
}

function isPublicAssetPath(pathname: string) {
  return pathname.startsWith("/_next/") || pathname.startsWith("/_vinext/") || pathname === "/favicon.svg" || pathname === "/favicon.ico";
}

function isPublicShareRequest(url: URL, method: string) {
  return method === "GET" && ((url.pathname === "/" && url.searchParams.has("share")) || (url.pathname === "/api/shares" && url.searchParams.has("token")));
}

async function isAuthorized(request: Request, password: string) {
  const cookie = getCookie(request, ACCESS_COOKIE);
  if (!cookie) return false;
  return cookie === await createAccessToken(password);
}

function passwordPage() {
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>路书 · 私密访问</title><style>*,*:before,*:after{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f6f1;color:#17221f;font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif}.card{width:min(390px,calc(100% - 40px));padding:36px;border:1px solid #e3e6dc;border-radius:16px;background:#fffdf8;box-shadow:0 18px 45px rgba(30,50,42,.08)}.mark{width:42px;height:42px;display:grid;place-items:center;margin-bottom:25px;border-radius:12px 12px 12px 3px;background:#dc6b3f;color:#fff8ed;font-size:24px;font-weight:800;transform:rotate(-5deg)}.eyebrow{color:#dc6b3f;font-size:10px;font-weight:800;letter-spacing:.18em}.card h1{margin:12px 0 8px;font-family:Georgia,serif;font-size:28px;font-weight:500}.card p{margin:0 0 24px;color:#8b958c;font-size:12px;line-height:1.7}.field{width:100%;padding:13px;border:1px solid #dfe3da;border-radius:7px;outline:0;font-size:13px}.field:focus{border-color:#9eb59b;box-shadow:0 0 0 3px rgba(150,178,149,.12)}button{width:100%;margin-top:12px;padding:13px;border:0;border-radius:7px;background:#1c322c;color:#fff;font-size:12px;font-weight:700;cursor:pointer}button:hover{background:#2a4a40}.error{min-height:17px;margin-top:12px;color:#c66e4b;font-size:11px}</style></head><body><main class="card"><div class="mark">路</div><div class="eyebrow">PRIVATE ROADBOOK</div><h1>这是一个私密路书</h1><p>输入访问密码后，才能打开行程和地图。</p><form id="form"><input class="field" id="password" type="password" placeholder="访问密码" autocomplete="current-password" required><button type="submit">进入路书&nbsp; →</button><div class="error" id="error"></div></form></main><script>const form=document.getElementById("form"),input=document.getElementById("password"),error=document.getElementById("error");form.addEventListener("submit",async e=>{e.preventDefault();error.textContent="正在验证…";const r=await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:input.value})});if(r.ok){location.href="/"}else{error.textContent="密码不正确，请重试";input.select()}});input.focus();</script></body></html>`, { status: 401, headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store" } });
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const configuredPassword = env.SITE_PASSWORD?.trim();

    if (configuredPassword && url.pathname === "/api/auth/login" && request.method === "POST") {
      let submittedPassword = "";
      try {
        const body = await request.json() as { password?: string };
        submittedPassword = (body.password ?? "").trim();
      } catch {
        return Response.json({ ok: false }, { status: 400 });
      }
      if (submittedPassword !== configuredPassword) return Response.json({ ok: false }, { status: 401 });
      const token = await createAccessToken(configuredPassword);
      return Response.json({ ok: true }, { headers: { "Set-Cookie": `${ACCESS_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ACCESS_MAX_AGE}`, "Cache-Control": "no-store" } });
    }

    if (configuredPassword && url.pathname === "/api/auth/logout") {
      return Response.json({ ok: true }, { headers: { "Set-Cookie": `${ACCESS_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } });
    }

    if (configuredPassword && !isPublicAssetPath(url.pathname) && !isPublicShareRequest(url, request.method) && !await isAuthorized(request, configuredPassword)) return passwordPage();

    if (url.pathname === "/api/shares" && request.method === "POST") {
      if (!env.ROADBOOK_KV) return Response.json({ ok: false, error: "storage_unconfigured" }, { status: 503 });
      let snapshot: unknown;
      try {
        snapshot = await request.json();
      } catch {
        return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
      }
      if (!isShareSnapshot(snapshot)) return Response.json({ ok: false, error: "invalid_snapshot" }, { status: 400 });
      const tokenBytes = new Uint8Array(18);
      crypto.getRandomValues(tokenBytes);
      const token = toBase64Url(tokenBytes);
      await env.ROADBOOK_KV.put(`${SHARE_STORAGE_PREFIX}${token}`, JSON.stringify(snapshot), { expirationTtl: 60 * 60 * 24 * 30 });
      return Response.json({ ok: true, token }, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/api/shares" && request.method === "GET") {
      if (!env.ROADBOOK_KV) return Response.json({ ok: false, error: "storage_unconfigured" }, { status: 503 });
      const token = url.searchParams.get("token")?.trim() ?? "";
      if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return Response.json({ ok: false, error: "invalid_token" }, { status: 400 });
      const snapshot = await env.ROADBOOK_KV.get(`${SHARE_STORAGE_PREFIX}${token}`, "json");
      if (!isShareSnapshot(snapshot)) return Response.json({ ok: false, error: "share_not_found" }, { status: 404 });
      return Response.json({ ok: true, snapshot }, { headers: { "Cache-Control": "public, max-age=60" } });
    }

    if (url.pathname === "/api/roadbooks" && request.method === "GET") {
      if (!env.ROADBOOK_KV) return Response.json({ ok: false, error: "storage_unconfigured" }, { status: 503 });
      const roadbooks = await env.ROADBOOK_KV.get(ROADBOOK_STORAGE_KEY, "json");
      return Response.json({ ok: true, roadbooks: Array.isArray(roadbooks) ? roadbooks : null }, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/api/roadbooks" && request.method === "PUT") {
      if (!env.ROADBOOK_KV) return Response.json({ ok: false, error: "storage_unconfigured" }, { status: 503 });
      let roadbooks: unknown;
      try {
        roadbooks = await request.json();
      } catch {
        return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
      }
      if (!Array.isArray(roadbooks) || roadbooks.length === 0) return Response.json({ ok: false, error: "invalid_roadbooks" }, { status: 400 });
      await env.ROADBOOK_KV.put(ROADBOOK_STORAGE_KEY, JSON.stringify(roadbooks));
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/api/amap/search" && request.method === "GET") {
      const keyword = url.searchParams.get("keywords")?.trim() ?? "";
      const webServiceKey = env.AMAP_WEB_SERVICE_KEY?.trim();
      if (!keyword) return Response.json({ status: "0", info: "keywords is required", pois: [] }, { status: 400 });
      if (!webServiceKey) return Response.json({ status: "0", info: "web service key is not configured", pois: [] }, { status: 503 });

      const searchUrl = new URL("https://restapi.amap.com/v3/place/text");
      searchUrl.searchParams.set("key", webServiceKey);
      searchUrl.searchParams.set("keywords", keyword);
      searchUrl.searchParams.set("offset", "20");
      searchUrl.searchParams.set("page", "1");
      searchUrl.searchParams.set("extensions", "all");
      searchUrl.searchParams.set("citylimit", "false");
      const response = await fetch(searchUrl);
      if (!response.ok) return Response.json({ status: "0", info: "amap search failed", pois: [] }, { status: 502 });
      const payload = await response.json();
      return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/api/amap-config") {
      return Response.json({
        jsKey: env.AMAP_JS_KEY ?? "",
        securityCode: env.AMAP_SECURITY_CODE ?? "",
        webKey: env.AMAP_WEB_SERVICE_KEY ?? "",
      }, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
