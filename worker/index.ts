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
const AMAP_ROUTE_CACHE_TTL = 60 * 60 * 24;
const AMAP_ROUTE_CACHE_PREFIX = "amap-route-v1:";
const AMAP_SEARCH_CACHE_TTL = 60 * 10;
const AMAP_SEARCH_CACHE_PREFIX = "amap-search-v1:";

type NormalizedRoute = {
  status: "1";
  info: "OK";
  route: {
    distance: number;
    duration: number;
    tolls: number | null;
    path: Array<[number, number]>;
  };
};
type ShareStop = { id?: string; lng?: number; lat?: number };
type ShareSnapshot = {
  version: 1;
  roadbook: { days: Array<{ stops?: ShareStop[] }> };
  legs: Record<string, { distance?: number; duration?: number; tolls?: number }>;
  paths?: Record<string, Array<[number, number]>>;
  createdAt: string;
};
type AMapSearchPayload = { status?: string; info?: string; pois?: unknown[]; [key: string]: unknown };
function normalizeCoordinate(value: string | null) {
  if (!value) return null;
  const [lng, lat] = value.split(",").map(Number);
  return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90
    ? `${lng.toFixed(6)},${lat.toFixed(6)}`
    : null;
}

function numberValue(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function parsePolyline(value: unknown) {
  if (typeof value !== "string") return [] as Array<[number, number]>;
  return value.split(";").flatMap((point) => {
    const [lng, lat] = point.split(",").map(Number);
    return Number.isFinite(lng) && Number.isFinite(lat) ? [[lng, lat] as [number, number]] : [];
  });
}

function normalizeAmapRoute(payload: unknown): NormalizedRoute | null {
  if (!payload || typeof payload !== "object") return null;
  const response = payload as { status?: string; route?: { paths?: Array<{ distance?: unknown; cost?: { duration?: unknown; tolls?: unknown }; steps?: Array<{ polyline?: unknown }> }> } };
  if (response.status !== "1" || !response.route?.paths?.length) return null;
  const path = response.route.paths[0];
  const distance = numberValue(path.distance);
  const duration = numberValue(path.cost?.duration);
  if (distance === null || duration === null) return null;
  return {
    status: "1",
    info: "OK",
    route: {
      distance,
      duration,
      tolls: numberValue(path.cost?.tolls),
      path: path.steps?.flatMap((step) => parsePolyline(step.polyline)) ?? [],
    },
  };
}

function shareRouteCacheKey(origin: string, destination: string) {
  return `${AMAP_ROUTE_CACHE_PREFIX}${origin}|${destination}|policy=0|ferry=0|waypoints=`;
}

async function fetchShareRoute(env: Env, from: ShareStop, to: ShareStop) {
  const webServiceKey = env.AMAP_WEB_SERVICE_KEY?.trim();
  const origin = normalizeCoordinate(`${from.lng},${from.lat}`);
  const destination = normalizeCoordinate(`${to.lng},${to.lat}`);
  if (!webServiceKey || !origin || !destination) return null;

  const cacheKey = shareRouteCacheKey(origin, destination);
  if (env.ROADBOOK_KV) {
    const cached = await env.ROADBOOK_KV.get(cacheKey, "json") as NormalizedRoute | null;
    if (cached?.status === "1" && cached.route) return cached;
  }

  const routeUrl = new URL("https://restapi.amap.com/v5/direction/driving");
  routeUrl.searchParams.set("key", webServiceKey);
  routeUrl.searchParams.set("origin", origin);
  routeUrl.searchParams.set("destination", destination);
  routeUrl.searchParams.set("strategy", "0");
  routeUrl.searchParams.set("ferry", "0");
  routeUrl.searchParams.set("show_fields", "cost,navi,polyline");
  routeUrl.searchParams.set("output", "json");

  try {
    const upstream = await fetch(routeUrl);
    const payload = await upstream.json();
    const normalized = normalizeAmapRoute(payload);
    if (!upstream.ok || !normalized) return null;
    if (env.ROADBOOK_KV) await env.ROADBOOK_KV.put(cacheKey, JSON.stringify(normalized), { expirationTtl: AMAP_ROUTE_CACHE_TTL });
    return normalized;
  } catch {
    return null;
  }
}

async function mapShareWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function shareRouteKey(stops: ShareStop[]) {
  return stops.map((stop) => `${Number(stop.lng).toFixed(6)},${Number(stop.lat).toFixed(6)}`).join("|");
}

async function prepareShareSnapshot(env: Env, token: string, initial: ShareSnapshot) {
  if (!env.ROADBOOK_KV) return;
  const snapshot = JSON.parse(JSON.stringify(initial)) as ShareSnapshot;
  const daysNeedingPath = snapshot.roadbook.days.filter((day) => {
    const stops = day.stops ?? [];
    return stops.length >= 2 && !snapshot.paths?.[shareRouteKey(stops)];
  });
  if (daysNeedingPath.length) {
    snapshot.paths = {
      ...(snapshot.paths ?? {}),
      ...Object.fromEntries(daysNeedingPath.map((day) => [
        shareRouteKey(day.stops ?? []),
        (day.stops ?? []).map((stop) => [Number(stop.lng), Number(stop.lat)] as [number, number]),
      ])),
    };
    await env.ROADBOOK_KV.put(`${SHARE_STORAGE_PREFIX}${token}`, JSON.stringify(snapshot), { expirationTtl: 60 * 60 * 24 * 30 });
  }
  const tasks = snapshot.roadbook.days.flatMap((day) => (day.stops ?? []).slice(0, -1).flatMap((from, index) => {
    const to = day.stops?.[index + 1];
    if (!from.id || !to || typeof from.lng !== "number" || typeof from.lat !== "number" || typeof to.lng !== "number" || typeof to.lat !== "number") return [];
    const existing = snapshot.legs[from.id];
    const needsMetric = typeof existing?.distance !== "number" || typeof existing?.duration !== "number";
    const needsPath = daysNeedingPath.includes(day);
    return needsMetric || needsPath ? [{ from, to }] : [];
  }));
  if (!tasks.length) return;

  const results = await mapShareWithConcurrency(tasks, 4, async ({ from, to }) => ({ id: from.id!, route: await fetchShareRoute(env, from, to) }));
  const routeByStopId = new Map<string, NormalizedRoute>();
  results.forEach(({ id, route }) => {
    if (!route) return;
    routeByStopId.set(id, route);
    snapshot.legs[id] = {
      distance: route.route.distance,
      duration: route.route.duration,
      ...(typeof route.route.tolls === "number" ? { tolls: route.route.tolls } : {}),
    };
  });
  snapshot.roadbook.days.forEach((day) => {
    const stops = day.stops ?? [];
    const path = stops.slice(0, -1).flatMap((stop, index) => {
      const route = routeByStopId.get(stop.id ?? "");
      const points = route?.route.path ?? [];
      return index === 0 ? points : points.slice(1);
    });
    if (path.length >= 2) {
      snapshot.paths = { ...(snapshot.paths ?? {}), [shareRouteKey(stops)]: path.slice(0, 500) };
    }
  });
  await env.ROADBOOK_KV.put(`${SHARE_STORAGE_PREFIX}${token}`, JSON.stringify(snapshot), { expirationTtl: 60 * 60 * 24 * 30 });
}

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

function isShareSnapshot(value: unknown): value is ShareSnapshot {
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
      ctx.waitUntil(prepareShareSnapshot(env, token, snapshot));
      return Response.json({ ok: true, token }, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/api/shares" && request.method === "PUT") {
      if (!env.ROADBOOK_KV) return Response.json({ ok: false, error: "storage_unconfigured" }, { status: 503 });
      const token = url.searchParams.get("token")?.trim() ?? "";
      if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return Response.json({ ok: false, error: "invalid_token" }, { status: 400 });
      let snapshot: unknown;
      try {
        snapshot = await request.json();
      } catch {
        return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
      }
      if (!isShareSnapshot(snapshot)) return Response.json({ ok: false, error: "invalid_snapshot" }, { status: 400 });
      const existing = await env.ROADBOOK_KV.get(`${SHARE_STORAGE_PREFIX}${token}`);
      if (existing === null) return Response.json({ ok: false, error: "share_not_found" }, { status: 404 });
      await env.ROADBOOK_KV.put(`${SHARE_STORAGE_PREFIX}${token}`, JSON.stringify(snapshot), { expirationTtl: 60 * 60 * 24 * 30 });
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/api/shares" && request.method === "GET") {
      if (!env.ROADBOOK_KV) return Response.json({ ok: false, error: "storage_unconfigured" }, { status: 503 });
      const token = url.searchParams.get("token")?.trim() ?? "";
      if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return Response.json({ ok: false, error: "invalid_token" }, { status: 400 });
      const snapshot = await env.ROADBOOK_KV.get(`${SHARE_STORAGE_PREFIX}${token}`, "json");
      if (!isShareSnapshot(snapshot)) return Response.json({ ok: false, error: "share_not_found" }, { status: 404 });
      ctx.waitUntil(prepareShareSnapshot(env, token, snapshot).catch(() => undefined));
      return Response.json({ ok: true, snapshot }, { headers: { "Cache-Control": "no-store" } });
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

    if (url.pathname === "/api/amap/route" && request.method === "GET") {
      const webServiceKey = env.AMAP_WEB_SERVICE_KEY?.trim();
      const origin = normalizeCoordinate(url.searchParams.get("origin"));
      const destination = normalizeCoordinate(url.searchParams.get("destination"));
      const policy = url.searchParams.get("policy") ?? "0";
      const ferry = url.searchParams.get("ferry") ?? "0";
      const rawWaypoints = url.searchParams.get("waypoints") ?? "";
      const waypoints = rawWaypoints ? rawWaypoints.split(";").map(normalizeCoordinate) : [];
      if (!webServiceKey) return Response.json({ status: "0", info: "web service key is not configured" }, { status: 503 });
      if (!origin || !destination || !/^\d+$/.test(policy) || Number(policy) > 45 || !["0", "1"].includes(ferry) || waypoints.some((point) => !point) || waypoints.length > 16) {
        return Response.json({ status: "0", info: "invalid route parameters" }, { status: 400 });
      }

      const validWaypoints = waypoints.filter((point): point is string => Boolean(point));
      const cacheKey = `${AMAP_ROUTE_CACHE_PREFIX}${origin}|${destination}|policy=${policy}|ferry=${ferry}|waypoints=${validWaypoints.join(";")}`;
      if (env.ROADBOOK_KV) {
        const cached = await env.ROADBOOK_KV.get(cacheKey, "json") as NormalizedRoute | null;
        if (cached?.status === "1" && cached.route) {
          return Response.json(cached, { headers: { "Cache-Control": `public, max-age=${AMAP_ROUTE_CACHE_TTL}`, "X-Route-Cache": "HIT" } });
        }
      }

      const routeUrl = new URL("https://restapi.amap.com/v5/direction/driving");
      routeUrl.searchParams.set("key", webServiceKey);
      routeUrl.searchParams.set("origin", origin);
      routeUrl.searchParams.set("destination", destination);
      routeUrl.searchParams.set("strategy", policy);
      routeUrl.searchParams.set("ferry", ferry);
      routeUrl.searchParams.set("show_fields", "cost,navi,polyline");
      routeUrl.searchParams.set("output", "json");
      if (validWaypoints.length) routeUrl.searchParams.set("waypoints", validWaypoints.join(";"));

      const upstream = await fetch(routeUrl);
      let upstreamPayload: unknown;
      try {
        upstreamPayload = await upstream.json();
      } catch {
        return Response.json({ status: "0", info: "invalid amap response" }, { status: 502 });
      }
      const normalized = normalizeAmapRoute(upstreamPayload);
      if (!upstream.ok || !normalized) {
        const payload = upstreamPayload && typeof upstreamPayload === "object" ? upstreamPayload as { info?: unknown; infocode?: unknown } : {};
        const info = typeof payload.info === "string" ? payload.info : "amap route failed";
        const infocode = typeof payload.infocode === "string" ? payload.infocode : undefined;
        return Response.json({ status: "0", info, ...(infocode ? { infocode } : {}) }, { status: 502, headers: { "Cache-Control": "no-store" } });
      }
      const response = Response.json(normalized, {
        headers: {
          "Cache-Control": `public, max-age=${AMAP_ROUTE_CACHE_TTL}`,
          "X-Route-Cache": env.ROADBOOK_KV ? "MISS" : "BYPASS",
        },
      });
      if (env.ROADBOOK_KV) ctx.waitUntil(env.ROADBOOK_KV.put(cacheKey, JSON.stringify(normalized), { expirationTtl: AMAP_ROUTE_CACHE_TTL }));
      return response;
    }

    if (url.pathname === "/api/amap/search" && request.method === "GET") {
      const keyword = url.searchParams.get("keywords")?.trim() ?? "";
      const webServiceKey = env.AMAP_WEB_SERVICE_KEY?.trim();
      if (!keyword) return Response.json({ status: "0", info: "keywords is required", pois: [] }, { status: 400 });
      if (!webServiceKey) return Response.json({ status: "0", info: "web service key is not configured", pois: [] }, { status: 503 });
      const searchCacheKey = `${AMAP_SEARCH_CACHE_PREFIX}${keyword.replace(/\s+/g, " ").toLocaleLowerCase()}`;
      if (env.ROADBOOK_KV) {
        const cached = await env.ROADBOOK_KV.get(searchCacheKey, "json") as AMapSearchPayload | null;
        if (cached) return Response.json(cached, { headers: { "Cache-Control": `public, max-age=${AMAP_SEARCH_CACHE_TTL}`, "X-Search-Cache": "HIT" } });
      }

      const searchUrl = new URL("https://restapi.amap.com/v3/place/text");
      searchUrl.searchParams.set("key", webServiceKey);
      searchUrl.searchParams.set("keywords", keyword);
      searchUrl.searchParams.set("offset", "20");
      searchUrl.searchParams.set("page", "1");
      searchUrl.searchParams.set("extensions", "all");
      searchUrl.searchParams.set("citylimit", "false");
      const response = await fetch(searchUrl);
      if (!response.ok) return Response.json({ status: "0", info: "amap search failed", pois: [] }, { status: 502 });
      const payload = await response.json() as AMapSearchPayload;
      if (env.ROADBOOK_KV) ctx.waitUntil(env.ROADBOOK_KV.put(searchCacheKey, JSON.stringify(payload), { expirationTtl: AMAP_SEARCH_CACHE_TTL }));
      return Response.json(payload, { headers: { "Cache-Control": `public, max-age=${AMAP_SEARCH_CACHE_TTL}`, "X-Search-Cache": env.ROADBOOK_KV ? "MISS" : "BYPASS" } });
    }

    if (url.pathname === "/api/amap-config") {
      return Response.json({
        jsKey: env.AMAP_JS_KEY ?? "",
        securityCode: env.AMAP_SECURITY_CODE ?? "",
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
