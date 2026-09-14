/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { daxinganlingDays, initialDays as importedInitialDays, tibetDays } from "../app/roadbook-data";
import { inputTipsToPois, rankAmapPois } from "./amap-search";
import { extractHighwayPath, rankRouteServiceAreas, sampleRouteSearchPoints } from "./service-areas";

interface Env {
  ASSETS: Fetcher;
  AMAP_JS_KEY?: string;
  AMAP_SECURITY_CODE?: string;
  AMAP_WEB_SERVICE_KEY?: string;
  ALLOWREGISTER?: string;
  allowregister?: string;
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
const SESSION_COOKIE = "roadbook_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const ROADBOOK_STORAGE_KEY = "roadbooks:default";
const ROADBOOK_USER_STORAGE_PREFIX = "roadbooks:user:";
const ADMIN_STARTER_BINDING_KEY = "roadbooks:admin-starters-v1";
const STARTER_ROADBOOK_IDS = new Set([
  "roadbook-69defbdbf04061086bd0cf71",
  "roadbook-amap-686f74ae52f2600e6d48cbdd",
  "roadbook-amap-6a6ac8888244b107b7cfb234",
]);
const SHARE_STORAGE_PREFIX = "roadbook-share:";
const SHARE_INDEX_KEY = "roadbook-shares:index";
const SHARE_LINK_TTL = 60 * 60 * 24 * 30;
const AMAP_ROUTE_CACHE_TTL = 60 * 60 * 24;
const AMAP_ROUTE_CACHE_PREFIX = "amap-route-v1:";
const AMAP_ROUTE_MAX_POINTS = 480;
const AMAP_SEARCH_CACHE_TTL = 60 * 10;
const AMAP_SEARCH_CACHE_PREFIX = "amap-search-v2:";
const AMAP_SERVICE_AREA_CACHE_TTL = 60 * 60 * 6;
const AMAP_SERVICE_AREA_CACHE_PREFIX = "amap-service-areas-v1:";
const USERNAME_STORAGE_PREFIX = "roadbook-user:username:";
const USER_STORAGE_PREFIX = "roadbook-user:id:";
const SESSION_STORAGE_PREFIX = "roadbook-session:";
const ADMIN_USERNAME = "admin";
// Cloudflare Workers Web Crypto currently caps PBKDF2 at 100,000 iterations.
const PASSWORD_HASH_ITERATIONS = 100_000;

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
  roadbook: { id?: string; title?: string; days: Array<{ stops?: ShareStop[] }> };
  legs: Record<string, { distance?: number; duration?: number; tolls?: number }>;
  paths?: Record<string, Array<[number, number]>>;
  createdAt: string;
};
type ShareLinkRecord = { token: string; roadbookId: string; roadbookTitle: string; createdAt: string; expiresAt: string; permanent?: boolean; ownerId?: string };
type AMapSearchPayload = { status?: string; info?: string; pois?: unknown[]; [key: string]: unknown };
type AMapCredentials = { jsKey: string; securityCode: string; webKey: string };
type UserRecord = {
  id: string;
  username: string;
  passwordHash: string;
  amap: AMapCredentials;
  createdAt: string;
};
type SessionRecord = { userId: string; createdAt: string };
type RoadbookRecord = {
  id: string;
  title: string;
  description: string;
  region: string;
  updated: string;
  startDate?: string;
  days: unknown[];
};
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

function samplePolyline(path: Array<[number, number]>, maxPoints = AMAP_ROUTE_MAX_POINTS) {
  if (path.length <= maxPoints) return path;
  const step = Math.max(1, Math.ceil((path.length - 1) / (maxPoints - 1)));
  return path.filter((_, index) => index % step === 0 || index === path.length - 1);
}

function routePayload(normalized: NormalizedRoute, includePath: boolean): NormalizedRoute {
  return {
    ...normalized,
    route: {
      ...normalized.route,
      path: includePath ? samplePolyline(normalized.route.path) : [],
    },
  };
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
      path: samplePolyline(path.steps?.flatMap((step) => parsePolyline(step.polyline)) ?? []),
    },
  };
}

function shareRouteCacheKey(origin: string, destination: string, cacheScope = "") {
  return `${AMAP_ROUTE_CACHE_PREFIX}${cacheScope}${origin}|${destination}|policy=0|ferry=0|waypoints=`;
}

async function fetchShareRoute(env: Env, credentials: AMapCredentials | undefined, from: ShareStop, to: ShareStop, cacheScope = "") {
  const webServiceKey = credentials?.webKey;
  const origin = normalizeCoordinate(`${from.lng},${from.lat}`);
  const destination = normalizeCoordinate(`${to.lng},${to.lat}`);
  if (!webServiceKey || !origin || !destination) return null;

  const cacheKey = shareRouteCacheKey(origin, destination, cacheScope);
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

function hasDetailedSharePath(path: Array<[number, number]> | undefined, stops: ShareStop[]) {
  // 旧分享中用地点直连作为临时占位；另一种旧数据会把整天的轨迹
  // 直接截断为前 500 个点。两者都不能当作完整路线。
  const destination = stops.at(-1);
  const finalPoint = path?.at(-1);
  if (!path || path.length <= Math.max(stops.length, 2) || !destination || !finalPoint
    || typeof destination.lng !== "number" || typeof destination.lat !== "number") return false;
  const lngDelta = (finalPoint[0] - destination.lng) * Math.cos(destination.lat * Math.PI / 180);
  const latDelta = finalPoint[1] - destination.lat;
  // 约 3.3 公里。高德路线的终点应远小于此误差；超过说明轨迹只保存了前半段。
  return Math.hypot(lngDelta, latDelta) < 0.03;
}

async function prepareShareSnapshot(env: Env, token: string, initial: ShareSnapshot, credentials?: AMapCredentials, cacheScope = "") {
  if (!env.ROADBOOK_KV || !credentials?.webKey) return;
  const snapshot = JSON.parse(JSON.stringify(initial)) as ShareSnapshot;
  const daysNeedingPath = snapshot.roadbook.days.filter((day) => {
    const stops = day.stops ?? [];
    return stops.length >= 2 && !hasDetailedSharePath(snapshot.paths?.[shareRouteKey(stops)], stops);
  });
  const tasks = snapshot.roadbook.days.flatMap((day) => (day.stops ?? []).slice(0, -1).flatMap((from, index) => {
    const to = day.stops?.[index + 1];
    if (!from.id || !to || typeof from.lng !== "number" || typeof from.lat !== "number" || typeof to.lng !== "number" || typeof to.lat !== "number") return [];
    const existing = snapshot.legs[from.id];
    const needsMetric = typeof existing?.distance !== "number" || typeof existing?.duration !== "number";
    const needsPath = daysNeedingPath.includes(day);
    return needsMetric || needsPath ? [{ from, to }] : [];
  }));
  if (!tasks.length) return;

  const results = await mapShareWithConcurrency(tasks, 4, async ({ from, to }) => ({ id: from.id!, route: await fetchShareRoute(env, credentials, from, to, cacheScope) }));
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
    const segments = stops.slice(0, -1).map((stop) => {
      const route = routeByStopId.get(stop.id ?? "");
      return route?.route.path ?? [];
    });
    // 一天里任意一段尚未返回时，不能把剩余片段拼成“完整”路线；
    // 留空以便分享页继续轮询，直到整天的真实轨迹都齐全。
    if (segments.length === stops.length - 1 && segments.every((segment) => segment.length >= 2)) {
      const path = segments.flatMap((segment, index) => index === 0 ? segment : segment.slice(1));
      // 必须从全程均匀取样，不能只保留起点附近的前 500 个点，
      // 否则长途日程在总览上会显示成一小截断线。
      snapshot.paths = { ...(snapshot.paths ?? {}), [shareRouteKey(stops)]: samplePolyline(path, AMAP_ROUTE_MAX_POINTS) };
    }
  });
  await env.ROADBOOK_KV.put(`${SHARE_STORAGE_PREFIX}${token}`, JSON.stringify(snapshot), { expirationTtl: 60 * 60 * 24 * 30 });
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

function isRegistrationAllowed(env: Env) {
  return (env.allowregister ?? env.ALLOWREGISTER)?.trim() === "1";
}

function normalizeUsername(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function validUsername(username: string) {
  return username.length >= 3 && username.length <= 80 && !/[\s/\\]/u.test(username);
}

function trimCredential(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 500) : "";
}

function envAmapCredentials(env: Env): AMapCredentials {
  return {
    jsKey: trimCredential(env.AMAP_JS_KEY),
    securityCode: trimCredential(env.AMAP_SECURITY_CODE),
    webKey: trimCredential(env.AMAP_WEB_SERVICE_KEY),
  };
}

function getAmapCredentials(env: Env, user?: UserRecord | null) {
  return user?.amap ?? envAmapCredentials(env);
}

function userByUsernameKey(username: string) {
  return `${USERNAME_STORAGE_PREFIX}${username}`;
}

function userByIdKey(userId: string) {
  return `${USER_STORAGE_PREFIX}${userId}`;
}

async function getUserByUsername(env: Env, username: string) {
  if (!env.ROADBOOK_KV) return null;
  return await env.ROADBOOK_KV.get(userByUsernameKey(username), "json") as UserRecord | null;
}

async function getUserById(env: Env, userId: string) {
  if (!env.ROADBOOK_KV || !userId) return null;
  return await env.ROADBOOK_KV.get(userByIdKey(userId), "json") as UserRecord | null;
}

async function putUser(env: Env, user: UserRecord) {
  if (!env.ROADBOOK_KV) return;
  const serialized = JSON.stringify(user);
  await Promise.all([
    env.ROADBOOK_KV.put(userByUsernameKey(user.username), serialized),
    env.ROADBOOK_KV.put(userByIdKey(user.id), serialized),
  ]);
}

async function hashPassword(password: string) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PASSWORD_HASH_ITERATIONS, hash: "SHA-256" },
    passwordKey,
    256,
  );
  return `pbkdf2-sha256$${PASSWORD_HASH_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(bits))}`;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function verifyPassword(password: string, encoded: string) {
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 1_000_000) return false;
  try {
    const salt = fromBase64Url(parts[2]);
    const expected = fromBase64Url(parts[3]);
    const passwordKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      passwordKey,
      expected.length * 8,
    );
    return constantTimeEqual(new Uint8Array(bits), expected);
  } catch {
    return false;
  }
}

function publicUser(user: UserRecord) {
  return { id: user.id, username: user.username, displayName: user.username };
}

async function ensureAdmin(env: Env) {
  if (!env.ROADBOOK_KV) return null;
  const existing = await getUserByUsername(env, ADMIN_USERNAME);
  const envCredentials = envAmapCredentials(env);
  if (!existing) {
    const user: UserRecord = {
      id: "u_admin",
      username: ADMIN_USERNAME,
      passwordHash: await hashPassword("nsnkarlxu"),
      amap: envCredentials,
      createdAt: new Date().toISOString(),
    };
    await putUser(env, user);
    await bindAdminStarterRoadbooks(env, user.id);
    await claimLegacyShareLinks(env, user.id);
    return user;
  }

  // Fill only missing values so a later personal edit in “配置地图” is not
  // overwritten by the deployment environment on every request.
  const next: UserRecord = {
    ...existing,
    username: ADMIN_USERNAME,
    amap: {
      jsKey: existing.amap?.jsKey || envCredentials.jsKey,
      securityCode: existing.amap?.securityCode || envCredentials.securityCode,
      webKey: existing.amap?.webKey || envCredentials.webKey,
    },
  };
  if (JSON.stringify(next) !== JSON.stringify(existing)) await putUser(env, next);
  await bindAdminStarterRoadbooks(env, next.id);
  await claimLegacyShareLinks(env, next.id);
  return next;
}

function adminStarterRoadbooks(): RoadbookRecord[] {
  return [
    {
      id: "roadbook-69defbdbf04061086bd0cf71",
      title: "五一伊犁",
      description: "从深圳出发，穿越河西走廊，游览赛里木湖、库尔德宁与那拉提草原后返程",
      region: "深圳 → 伊犁 → 深圳",
      updated: "已从高德路书导入",
      startDate: "2026-04-29",
      days: importedInitialDays,
    },
    {
      id: "roadbook-amap-686f74ae52f2600e6d48cbdd",
      title: "西藏",
      description: "从深圳出发，沿318国道进藏，串联拉萨、山南、日喀则、林芝与昌都后返程",
      region: "深圳 → 西藏 → 深圳",
      updated: "已从高德路书导入",
      startDate: "2025-09-20",
      days: tibetDays,
    },
    {
      id: "roadbook-amap-6a6ac8888244b107b7cfb234",
      title: "2026中秋国庆大兴安岭",
      description: "从深圳出发，经洛阳、乌兰察布、锡林郭勒、赤峰、阿尔山与呼伦贝尔后返程",
      region: "深圳 → 大兴安岭 → 深圳",
      updated: "已从高德路书导入",
      startDate: "2026-09-19",
      days: daxinganlingDays,
    },
  ];
}

async function bindAdminStarterRoadbooks(env: Env, adminId: string) {
  if (!env.ROADBOOK_KV || await env.ROADBOOK_KV.get(ADMIN_STARTER_BINDING_KEY)) return;
  const adminKey = userRoadbookStorageKey(adminId);
  const [existing, legacy] = await Promise.all([
    env.ROADBOOK_KV.get(adminKey, "json"),
    env.ROADBOOK_KV.get(ROADBOOK_STORAGE_KEY, "json"),
  ]);
  const base = Array.isArray(existing) && existing.length ? existing : Array.isArray(legacy) ? legacy : [];
  const existingIds = new Set(base.map((item) => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : ""));
  const additions = adminStarterRoadbooks().filter((roadbook) => !existingIds.has(roadbook.id));
  await env.ROADBOOK_KV.put(adminKey, JSON.stringify([...additions, ...base]));
  await env.ROADBOOK_KV.put(ADMIN_STARTER_BINDING_KEY, "1");
}

async function claimLegacyShareLinks(env: Env, ownerId: string) {
  if (!env.ROADBOOK_KV) return;
  const links = await readShareIndex(env);
  const unowned = links.some((link) => !link.ownerId);
  if (unowned) await writeShareIndex(env, links.map((link) => link.ownerId ? link : { ...link, ownerId }));
}

async function createSession(env: Env, user: UserRecord) {
  const token = randomToken(32);
  await env.ROADBOOK_KV?.put(`${SESSION_STORAGE_PREFIX}${token}`, JSON.stringify({ userId: user.id, createdAt: new Date().toISOString() } satisfies SessionRecord), { expirationTtl: SESSION_MAX_AGE });
  return token;
}

async function getSessionUser(request: Request, env: Env) {
  if (!env.ROADBOOK_KV) return null;
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  const session = await env.ROADBOOK_KV.get(`${SESSION_STORAGE_PREFIX}${token}`, "json") as SessionRecord | null;
  return session?.userId ? getUserById(env, session.userId) : null;
}

async function accountAuthEnabled(env: Env) {
  if (!env.ROADBOOK_KV) return false;
  if (isRegistrationAllowed(env)) return true;
  // A previously enabled account deployment remains account-protected after
  // registration is closed again. A bare KV binding still keeps the legacy
  // single-password mode for existing installations until registration is
  // explicitly enabled.
  return Boolean(await getUserByUsername(env, ADMIN_USERNAME));
}

function userRoadbookStorageKey(userId: string) {
  return `${ROADBOOK_USER_STORAGE_PREFIX}${userId}`;
}

function isUnmodifiedStarterCollection(value: unknown) {
  if (!Array.isArray(value) || value.length !== STARTER_ROADBOOK_IDS.size) return false;
  const ids = value.map((item) => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : "");
  return new Set(ids).size === STARTER_ROADBOOK_IDS.size && ids.every((id) => STARTER_ROADBOOK_IDS.has(id));
}

function amapCacheScope(user?: UserRecord | null) {
  return user ? `user:${user.id}:` : "";
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

async function readShareIndex(env: Env) {
  if (!env.ROADBOOK_KV) return [] as ShareLinkRecord[];
  const value = await env.ROADBOOK_KV.get(SHARE_INDEX_KEY, "json") as unknown;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ShareLinkRecord => Boolean(item && typeof item === "object"
    && typeof (item as ShareLinkRecord).token === "string"
    && typeof (item as ShareLinkRecord).roadbookTitle === "string"
    && typeof (item as ShareLinkRecord).createdAt === "string"
    && typeof (item as ShareLinkRecord).expiresAt === "string"));
}

async function writeShareIndex(env: Env, links: ShareLinkRecord[]) {
  if (env.ROADBOOK_KV) await env.ROADBOOK_KV.put(SHARE_INDEX_KEY, JSON.stringify(links));
}

function isPublicAssetPath(pathname: string) {
  return pathname.startsWith("/_next/") || pathname.startsWith("/_vinext/") || pathname === "/favicon.svg" || pathname === "/favicon.ico";
}

function isShareToken(value: string) {
  return /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

function isInlineShareSnapshot(value: string) {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    return isShareSnapshot(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return false;
  }
}

async function isPublicShareRequest(url: URL, method: string, env: Env) {
  if (method !== "GET") return false;
  if (url.pathname === "/api/amap-config") return true;

  const parameter = url.pathname === "/" ? url.searchParams.get("share") : url.pathname === "/api/shares" ? url.searchParams.get("token") : null;
  if (!parameter) return false;
  if (url.pathname === "/" && isInlineShareSnapshot(parameter)) return true;
  if (!isShareToken(parameter) || !env.ROADBOOK_KV) return false;

  const snapshot = await env.ROADBOOK_KV.get(`${SHARE_STORAGE_PREFIX}${parameter}`, "json");
  return isShareSnapshot(snapshot);
}

async function isAuthorized(request: Request, password: string) {
  const cookie = getCookie(request, ACCESS_COOKIE);
  if (!cookie) return false;
  return cookie === await createAccessToken(password);
}

function passwordPage() {
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>路书 · 私密访问</title><style>*,*:before,*:after{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f6f1;color:#17221f;font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif}.card{width:min(390px,calc(100% - 40px));padding:36px;border:1px solid #e3e6dc;border-radius:16px;background:#fffdf8;box-shadow:0 18px 45px rgba(30,50,42,.08)}.mark{width:42px;height:42px;display:grid;place-items:center;margin-bottom:25px;border-radius:12px 12px 12px 3px;background:#dc6b3f;color:#fff8ed;font-size:24px;font-weight:800;transform:rotate(-5deg)}.eyebrow{color:#dc6b3f;font-size:10px;font-weight:800;letter-spacing:.18em}.card h1{margin:12px 0 8px;font-family:Georgia,serif;font-size:28px;font-weight:500}.card p{margin:0 0 24px;color:#8b958c;font-size:12px;line-height:1.7}.field{width:100%;padding:13px;border:1px solid #dfe3da;border-radius:7px;outline:0;font-size:13px}.field:focus{border-color:#9eb59b;box-shadow:0 0 0 3px rgba(150,178,149,.12)}button{width:100%;margin-top:12px;padding:13px;border:0;border-radius:7px;background:#1c322c;color:#fff;font-size:12px;font-weight:700;cursor:pointer}button:hover{background:#2a4a40}.error{min-height:17px;margin-top:12px;color:#c66e4b;font-size:11px}</style></head><body><main class="card"><div class="mark">路</div><div class="eyebrow">PRIVATE ROADBOOK</div><h1>这是一个私密路书</h1><p>输入访问密码后，才能打开行程和地图。</p><form id="form"><input class="field" id="password" type="password" placeholder="访问密码" autocomplete="current-password" required><button type="submit">进入路书&nbsp; →</button><div class="error" id="error"></div></form></main><script>const form=document.getElementById("form"),input=document.getElementById("password"),error=document.getElementById("error");form.addEventListener("submit",async e=>{e.preventDefault();error.textContent="正在验证…";const r=await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:input.value})});if(r.ok){location.href="/"}else{error.textContent="密码不正确，请重试";input.select()}});input.focus();</script></body></html>`, { status: 401, headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store" } });
}

function accountPage(allowRegister: boolean) {
  const registerPanel = allowRegister
    ? `<section id="registerPanel" hidden><div class="panel-title"><span class="eyebrow">CREATE ACCOUNT</span><h2>注册你的路书账号</h2><p>每个账号拥有独立的路书、分享链接和高德 API 配置。</p></div><form id="registerForm"><label>用户名<input class="field" id="registerUsername" autocomplete="username" minlength="3" maxlength="80" required placeholder="例如：traveler01"></label><label>登录密码<input class="field" id="registerPassword" type="password" autocomplete="new-password" minlength="8" required placeholder="至少 8 位"></label><label>确认密码<input class="field" id="registerPasswordConfirm" type="password" autocomplete="new-password" minlength="8" required placeholder="再次输入密码"></label><div class="section-label">高德 API 配置</div><p class="hint">注册时需要填写下面 3 项，凭据会保存在你的账号记录中，只用于你的路书。</p><label>Web 端（JS API）Key<input class="field" id="registerJsKey" autocomplete="off" required placeholder="高德 Web 端（JS API）Key"></label><label>安全密钥 securityJsCode<input class="field" id="registerSecurityCode" type="password" autocomplete="off" required placeholder="高德 JS API 安全密钥"></label><label>Web 服务 Key<input class="field" id="registerWebKey" autocomplete="off" required placeholder="高德 Web 服务 Key"></label><button type="submit">注册并进入&nbsp; →</button><div class="error" id="registerError"></div></form><div class="help-box"><strong>怎么获取这 3 项？</strong><ol><li>登录<a href="https://console.amap.com/dev" target="_blank" rel="noreferrer">高德开放平台控制台</a>，进入「应用管理」并创建应用。</li><li>在应用中添加 Key，服务平台选择「Web 端（JS API）」，复制 Key 和安全密钥 securityJsCode。</li><li>继续添加一个 Key，服务平台选择「Web 服务」，复制这个 Web 服务 Key。</li></ol><div class="help-links"><a href="https://lbs.amap.com/api/javascript-api-v2/prerequisites" target="_blank" rel="noreferrer">JS API 获取说明 ↗</a><a href="https://lbs.amap.com/api/webservice/create-project-and-key" target="_blank" rel="noreferrer">Web 服务获取说明 ↗</a></div></div><button class="text-button" id="backToLogin" type="button">已有账号？返回登录</button></section>`
    : `<p class="closed-note">当前暂未开放注册。请联系管理员开启注册后再创建账号。</p>`;
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>路书 · 账号登录</title><style>*,*:before,*:after{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f6f6f1;color:#17221f;font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif}.shell{width:min(620px,calc(100% - 32px));margin:42px auto;padding:34px;border:1px solid #e3e6dc;border-radius:18px;background:#fffdf8;box-shadow:0 18px 45px rgba(30,50,42,.08)}.mark{width:42px;height:42px;display:grid;place-items:center;margin-bottom:22px;border-radius:12px 12px 12px 3px;background:#dc6b3f;color:#fff8ed;font-size:24px;font-weight:800;transform:rotate(-5deg)}.eyebrow{color:#dc6b3f;font-size:10px;font-weight:800;letter-spacing:.18em}.panel-title h1,.panel-title h2{margin:11px 0 8px;font-family:Georgia,serif;font-size:28px;font-weight:500}.panel-title p,.hint,.closed-note{color:#8b958c;font-size:12px;line-height:1.7}.panel-title p{margin:0 0 24px}.field{display:block;width:100%;padding:12px;margin-top:7px;border:1px solid #dfe3da;border-radius:7px;background:#fff;outline:0;font-size:13px}.field:focus{border-color:#9eb59b;box-shadow:0 0 0 3px rgba(150,178,149,.12)}label{display:block;margin:13px 0;color:#52625a;font-size:11px;font-weight:700}.section-label{margin-top:25px;padding-top:20px;border-top:1px solid #eceee7;color:#1c322c;font-size:12px;font-weight:800}.hint{margin:6px 0 12px}.help-box{margin-top:22px;padding:15px 17px;border:1px solid #e6eadf;border-radius:10px;background:#f7f8f1;color:#5f6d65;font-size:11px;line-height:1.7}.help-box strong{color:#1c322c}.help-box ol{padding-left:20px;margin:8px 0}.help-box a,.help-links a{color:#315e51}.help-links{display:flex;flex-wrap:wrap;gap:8px 18px}.button-row{display:flex;gap:10px}.button-row button{flex:1}button{width:100%;margin-top:12px;padding:13px;border:0;border-radius:7px;background:#1c322c;color:#fff;font-size:12px;font-weight:700;cursor:pointer}button:hover{background:#2a4a40}.text-button{background:transparent;color:#315e51}.text-button:hover{background:#eef2e9}.error{min-height:17px;margin-top:12px;color:#c66e4b;font-size:11px}.switch{margin:20px 0 0;padding-top:18px;border-top:1px solid #eceee7;text-align:center;color:#68766e;font-size:11px}.switch button{width:auto;margin:0 0 0 4px;padding:0;background:none;color:#315e51}.closed-note{margin:24px 0}.footer-note{margin-top:18px;color:#a0aaa2;font-size:10px;line-height:1.6;text-align:center}@media(max-width:520px){.shell{margin:16px auto;padding:24px 20px}.help-links{display:block}.help-links a{display:block;margin-top:5px}}</style></head><body><main class="shell"><div class="mark">路</div><section id="loginPanel"><div class="panel-title"><span class="eyebrow">ROAM NOTE</span><h1>登录你的路书</h1><p>登录后，你的行程和高德配置只对当前账号可见。</p></div><form id="loginForm"><label>用户名<input class="field" id="username" autocomplete="username" required placeholder="用户名"></label><label>密码<input class="field" id="password" type="password" autocomplete="current-password" required placeholder="登录密码"></label><button type="submit">进入路书&nbsp; →</button><div class="error" id="loginError"></div></form>${allowRegister ? `<div class="switch">还没有账号？<button id="showRegister" type="button">立即注册</button></div>` : ""}</section>${registerPanel}<div class="footer-note">高德 Key 仅用于地图、地点搜索和路线规划，请不要提交他人的凭据。</div></main><script>const loginForm=document.getElementById("loginForm"),loginError=document.getElementById("loginError");loginForm.addEventListener("submit",async e=>{e.preventDefault();loginError.textContent="正在登录…";const r=await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:document.getElementById("username").value,password:document.getElementById("password").value})});if(r.ok){location.href="/"}else{const p=await r.json().catch(()=>({}));loginError.textContent=p.error==="invalid_credentials"?"用户名或密码不正确":p.error==="storage_unconfigured"?"账号存储未配置，请联系管理员":"登录失败，请稍后重试";}});${allowRegister ? `const loginPanel=document.getElementById("loginPanel"),registerPanel=document.getElementById("registerPanel");document.getElementById("showRegister").addEventListener("click",()=>{loginPanel.hidden=true;registerPanel.hidden=false;window.scrollTo(0,0)});document.getElementById("backToLogin").addEventListener("click",()=>{registerPanel.hidden=true;loginPanel.hidden=false;window.scrollTo(0,0)});document.getElementById("registerForm").addEventListener("submit",async e=>{e.preventDefault();const error=document.getElementById("registerError"),password=document.getElementById("registerPassword").value,confirm=document.getElementById("registerPasswordConfirm").value;if(password!==confirm){error.textContent="两次输入的密码不一致";return}error.textContent="正在创建账号…";const body={username:document.getElementById("registerUsername").value,password,passwordConfirm:confirm,jsKey:document.getElementById("registerJsKey").value,securityCode:document.getElementById("registerSecurityCode").value,webKey:document.getElementById("registerWebKey").value};const r=await fetch("/api/auth/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});if(r.ok){location.href="/"}else{const p=await r.json().catch(()=>({}));error.textContent=p.error==="username_taken"?"这个用户名已被使用":p.error==="invalid_credentials"?"请填写完整且有效的 3 项高德凭据":p.error==="weak_password"?"密码至少需要 8 位":"注册失败，请检查填写内容后重试";}});` : ""}</script></body></html>`, { status: 401, headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store" } });
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
    const allowRegister = isRegistrationAllowed(env);
    const accountMode = await accountAuthEnabled(env);
    let currentUser = accountMode ? await getSessionUser(request, env) : null;

    if (accountMode) {
      const admin = await ensureAdmin(env);

      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        let body: { username?: unknown; password?: unknown };
        try {
          body = await request.json() as { username?: unknown; password?: unknown };
        } catch {
          return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
        }
        const username = normalizeUsername(body.username);
        const password = typeof body.password === "string" ? body.password : "";
        const user = username === ADMIN_USERNAME && admin ? admin : await getUserByUsername(env, username);
        if (!user || !password || !await verifyPassword(password, user.passwordHash)) {
          return Response.json({ ok: false, error: "invalid_credentials" }, { status: 401, headers: { "Cache-Control": "no-store" } });
        }
        const sessionToken = await createSession(env, user);
        currentUser = user;
        return Response.json({ ok: true, user: publicUser(user) }, { headers: { "Set-Cookie": `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`, "Cache-Control": "no-store" } });
      }

      if (url.pathname === "/api/auth/register" && request.method === "POST") {
        if (!allowRegister) return Response.json({ ok: false, error: "registration_closed" }, { status: 403 });
        let body: { username?: unknown; password?: unknown; passwordConfirm?: unknown; jsKey?: unknown; securityCode?: unknown; webKey?: unknown };
        try {
          body = await request.json() as { username?: unknown; password?: unknown; passwordConfirm?: unknown; jsKey?: unknown; securityCode?: unknown; webKey?: unknown };
        } catch {
          return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
        }
        const username = normalizeUsername(body.username);
        const password = typeof body.password === "string" ? body.password : "";
        const passwordConfirm = typeof body.passwordConfirm === "string" ? body.passwordConfirm : "";
        const amap = {
          jsKey: trimCredential(body.jsKey),
          securityCode: trimCredential(body.securityCode),
          webKey: trimCredential(body.webKey),
        } satisfies AMapCredentials;
        if (!validUsername(username) || username === ADMIN_USERNAME || password.length < 8 || password.length > 200 || password !== passwordConfirm) {
          return Response.json({ ok: false, error: password.length < 8 ? "weak_password" : "invalid_credentials" }, { status: 400 });
        }
        if (!amap.jsKey || !amap.securityCode || !amap.webKey) return Response.json({ ok: false, error: "invalid_credentials" }, { status: 400 });
        if (await getUserByUsername(env, username)) return Response.json({ ok: false, error: "username_taken" }, { status: 409 });
        const user: UserRecord = {
          id: `u_${randomToken(18)}`,
          username,
          passwordHash: await hashPassword(password),
          amap,
          createdAt: new Date().toISOString(),
        };
        await putUser(env, user);
        await env.ROADBOOK_KV?.put(userRoadbookStorageKey(user.id), "[]");
        const sessionToken = await createSession(env, user);
        currentUser = user;
        return Response.json({ ok: true, user: publicUser(user) }, { status: 201, headers: { "Set-Cookie": `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`, "Cache-Control": "no-store" } });
      }

      if (url.pathname === "/api/auth/logout" && (request.method === "GET" || request.method === "POST")) {
        const sessionToken = getCookie(request, SESSION_COOKIE);
        if (sessionToken) await env.ROADBOOK_KV?.delete(`${SESSION_STORAGE_PREFIX}${sessionToken}`);
        return Response.json({ ok: true }, { headers: { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, "Cache-Control": "no-store" } });
      }

      if (url.pathname === "/api/auth/me" && request.method === "GET") {
        return currentUser
          ? Response.json({ ok: true, user: publicUser(currentUser) }, { headers: { "Cache-Control": "no-store" } })
          : Response.json({ ok: false, error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
      }

      if (url.pathname === "/api/admin/users" && request.method === "GET") {
        if (!currentUser) return Response.json({ ok: false, error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
        if (currentUser.username !== ADMIN_USERNAME) return Response.json({ ok: false, error: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
        if (!env.ROADBOOK_KV) return Response.json({ ok: false, error: "storage_unconfigured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
        try {
          const users: UserRecord[] = [];
          let cursor = "";
          do {
            const page = await env.ROADBOOK_KV.list({ prefix: USERNAME_STORAGE_PREFIX, ...(cursor ? { cursor } : {}) });
            const records = await Promise.all(page.keys.map((key) => env.ROADBOOK_KV!.get(key.name, "json") as Promise<UserRecord | null>));
            records.forEach((user) => { if (user?.id && user.username) users.push(user); });
            cursor = page.list_complete ? "" : page.cursor ?? "";
          } while (cursor);
          users.sort((left, right) => left.username.localeCompare(right.username));
          return Response.json({
            ok: true,
            users: users.map((user) => ({
              id: user.id,
              username: user.username,
              createdAt: user.createdAt,
              amap: {
                jsKey: user.amap?.jsKey ?? "",
                securityCode: user.amap?.securityCode ?? "",
                webKey: user.amap?.webKey ?? "",
              },
            })),
          }, { headers: { "Cache-Control": "no-store" } });
        } catch {
          return Response.json({ ok: false, error: "storage_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
        }
      }

      if (!currentUser && !isPublicAssetPath(url.pathname) && !await isPublicShareRequest(url, request.method, env) && url.pathname !== "/api/amap-config") return accountPage(allowRegister);
    }

    if (!accountMode && configuredPassword && url.pathname === "/api/auth/login" && request.method === "POST") {
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

    if (!accountMode && configuredPassword && url.pathname === "/api/auth/logout") {
      return Response.json({ ok: true }, { headers: { "Set-Cookie": `${ACCESS_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } });
    }

    if (!accountMode && configuredPassword && !isPublicAssetPath(url.pathname) && !await isPublicShareRequest(url, request.method, env) && !await isAuthorized(request, configuredPassword)) return passwordPage();

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
      const expiresAt = new Date(Date.now() + SHARE_LINK_TTL * 1000).toISOString();
      await env.ROADBOOK_KV.put(`${SHARE_STORAGE_PREFIX}${token}`, JSON.stringify(snapshot), { expirationTtl: SHARE_LINK_TTL });
      const index = await readShareIndex(env);
      await writeShareIndex(env, [{ token, roadbookId: snapshot.roadbook.id ?? "", roadbookTitle: snapshot.roadbook.title ?? "未命名路书", createdAt: snapshot.createdAt, expiresAt, ...(currentUser ? { ownerId: currentUser.id } : {}) }, ...index.filter((link) => link.token !== token)]);
      ctx.waitUntil(prepareShareSnapshot(env, token, snapshot, currentUser ? getAmapCredentials(env, currentUser) : envAmapCredentials(env), amapCacheScope(currentUser)));
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
      const index = await readShareIndex(env);
      const existingLink = index.find((link) => link.token === token);
      if (accountMode && (!currentUser || existingLink?.ownerId !== currentUser.id)) return Response.json({ ok: false, error: "share_not_found" }, { status: 404 });
      // 固定分享链接由索引中的 permanent 标记控制；普通分享仍保持 30 天失效策略。
      await env.ROADBOOK_KV.put(
        `${SHARE_STORAGE_PREFIX}${token}`,
        JSON.stringify(snapshot),
        existingLink?.permanent ? undefined : { expirationTtl: SHARE_LINK_TTL },
      );
      await writeShareIndex(env, index.map((link) => link.token === token ? { ...link, roadbookId: snapshot.roadbook.id ?? link.roadbookId, roadbookTitle: snapshot.roadbook.title ?? link.roadbookTitle } : link));
      ctx.waitUntil(prepareShareSnapshot(env, token, snapshot, currentUser ? getAmapCredentials(env, currentUser) : envAmapCredentials(env), amapCacheScope(currentUser)).catch(() => undefined));
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/api/shares" && request.method === "GET") {
      if (!env.ROADBOOK_KV) return Response.json({ ok: false, error: "storage_unconfigured" }, { status: 503 });
      const token = url.searchParams.get("token")?.trim() ?? "";
      if (!token) {
        const links = await readShareIndex(env);
        return Response.json({ ok: true, links: accountMode && currentUser ? links.filter((link) => link.ownerId === currentUser.id) : links }, { headers: { "Cache-Control": "no-store" } });
      }
      if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return Response.json({ ok: false, error: "invalid_token" }, { status: 400 });
      const snapshot = await env.ROADBOOK_KV.get(`${SHARE_STORAGE_PREFIX}${token}`, "json");
      if (!isShareSnapshot(snapshot)) return Response.json({ ok: false, error: "share_not_found" }, { status: 404 });
      if (currentUser || !accountMode) ctx.waitUntil(prepareShareSnapshot(env, token, snapshot, currentUser ? getAmapCredentials(env, currentUser) : envAmapCredentials(env), amapCacheScope(currentUser)).catch(() => undefined));
      return Response.json({ ok: true, snapshot }, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/api/shares" && request.method === "DELETE") {
      if (!env.ROADBOOK_KV) return Response.json({ ok: false, error: "storage_unconfigured" }, { status: 503 });
      const token = url.searchParams.get("token")?.trim() ?? "";
      if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return Response.json({ ok: false, error: "invalid_token" }, { status: 400 });
      const existing = await env.ROADBOOK_KV.get(`${SHARE_STORAGE_PREFIX}${token}`);
      if (existing === null) return Response.json({ ok: false, error: "share_not_found" }, { status: 404 });
      const existingLink = (await readShareIndex(env)).find((link) => link.token === token);
      if (accountMode && (!currentUser || existingLink?.ownerId !== currentUser.id)) return Response.json({ ok: false, error: "share_not_found" }, { status: 404 });
      await env.ROADBOOK_KV.delete(`${SHARE_STORAGE_PREFIX}${token}`);
      await writeShareIndex(env, (await readShareIndex(env)).filter((link) => link.token !== token));
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/api/roadbooks" && request.method === "GET") {
      if (!env.ROADBOOK_KV) return Response.json({ ok: false, error: "storage_unconfigured" }, { status: 503 });
      const storageKey = accountMode && currentUser ? userRoadbookStorageKey(currentUser.id) : ROADBOOK_STORAGE_KEY;
      let roadbooks = await env.ROADBOOK_KV.get(storageKey, "json");
      // 将原来无账号版本的全局路书一次性归属给新建的 admin，其他用户从
      // 空白路书开始，避免把旧用户的数据带入新账号。
      if (accountMode && currentUser?.username === ADMIN_USERNAME && !Array.isArray(roadbooks)) {
        const legacyRoadbooks = await env.ROADBOOK_KV.get(ROADBOOK_STORAGE_KEY, "json");
        if (Array.isArray(legacyRoadbooks)) {
          roadbooks = legacyRoadbooks;
          await env.ROADBOOK_KV.put(storageKey, JSON.stringify(legacyRoadbooks));
        }
      }
      // 旧版本曾把三个内置示例写进每个新账号的 KV。只清理这组完全未修改的
      // 示例，避免误删用户后来创建或编辑过的自有路书。
      if (accountMode && currentUser && currentUser.username !== ADMIN_USERNAME && isUnmodifiedStarterCollection(roadbooks)) {
        roadbooks = [];
        await env.ROADBOOK_KV.put(storageKey, "[]");
      }
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
      if (accountMode && !currentUser) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      await env.ROADBOOK_KV.put(accountMode ? userRoadbookStorageKey(currentUser!.id) : ROADBOOK_STORAGE_KEY, JSON.stringify(roadbooks));
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/api/amap-config" && request.method === "PUT") {
      if (!accountMode || !currentUser || !env.ROADBOOK_KV) return Response.json({ ok: false, error: "account_required" }, { status: 401 });
      let body: { jsKey?: unknown; securityCode?: unknown; webKey?: unknown; clearWebKey?: unknown };
      try {
        body = await request.json() as { jsKey?: unknown; securityCode?: unknown; webKey?: unknown; clearWebKey?: unknown };
      } catch {
        return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
      }
      const amap = {
        jsKey: trimCredential(body.jsKey),
        securityCode: trimCredential(body.securityCode),
        webKey: trimCredential(body.webKey),
      } satisfies AMapCredentials;
      if (!amap.jsKey || !amap.securityCode) return Response.json({ ok: false, error: "invalid_credentials" }, { status: 400 });
      const nextUser: UserRecord = {
        ...currentUser,
        amap: {
          jsKey: amap.jsKey,
          securityCode: amap.securityCode,
          webKey: body.clearWebKey === true ? "" : amap.webKey || currentUser.amap.webKey,
        },
      };
      await putUser(env, nextUser);
      currentUser = nextUser;
      return Response.json({ ok: true, jsKey: nextUser.amap.jsKey, securityCode: nextUser.amap.securityCode, webKey: nextUser.amap.webKey }, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/api/amap/route" && request.method === "GET") {
      const webServiceKey = getAmapCredentials(env, currentUser).webKey;
      const origin = normalizeCoordinate(url.searchParams.get("origin"));
      const destination = normalizeCoordinate(url.searchParams.get("destination"));
      const policy = url.searchParams.get("policy") ?? "0";
      const includePath = url.searchParams.get("includePath") !== "0";
      const ferry = url.searchParams.get("ferry") ?? "0";
      const rawWaypoints = url.searchParams.get("waypoints") ?? "";
      const waypoints = rawWaypoints ? rawWaypoints.split(";").map(normalizeCoordinate) : [];
      if (!webServiceKey) return Response.json({ status: "0", info: "web service key is not configured" }, { status: 503 });
      if (!origin || !destination || !/^\d+$/.test(policy) || Number(policy) > 45 || !["0", "1"].includes(ferry) || waypoints.some((point) => !point) || waypoints.length > 16) {
        return Response.json({ status: "0", info: "invalid route parameters" }, { status: 400 });
      }

      const validWaypoints = waypoints.filter((point): point is string => Boolean(point));
      const cacheKey = `${AMAP_ROUTE_CACHE_PREFIX}${amapCacheScope(currentUser)}${origin}|${destination}|policy=${policy}|ferry=${ferry}|waypoints=${validWaypoints.join(";")}`;
      if (env.ROADBOOK_KV) {
        const cached = await env.ROADBOOK_KV.get(cacheKey, "json") as NormalizedRoute | null;
        if (cached?.status === "1" && cached.route) {
          return Response.json(routePayload(cached, includePath), { headers: { "Cache-Control": `${accountMode ? "private" : "public"}, max-age=${AMAP_ROUTE_CACHE_TTL}`, "X-Route-Cache": "HIT" } });
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
      const response = Response.json(routePayload(normalized, includePath), {
        headers: {
          "Cache-Control": `${accountMode ? "private" : "public"}, max-age=${AMAP_ROUTE_CACHE_TTL}`,
          "X-Route-Cache": env.ROADBOOK_KV ? "MISS" : "BYPASS",
        },
      });
      if (env.ROADBOOK_KV) ctx.waitUntil(env.ROADBOOK_KV.put(cacheKey, JSON.stringify(normalized), { expirationTtl: AMAP_ROUTE_CACHE_TTL }));
      return response;
    }

    if (url.pathname === "/api/amap/search" && request.method === "GET") {
      const keyword = url.searchParams.get("keywords")?.trim() ?? "";
      const city = url.searchParams.get("city")?.trim().slice(0, 80) ?? "";
      const location = normalizeCoordinate(url.searchParams.get("location"));
      const webServiceKey = getAmapCredentials(env, currentUser).webKey;
      if (!keyword) return Response.json({ status: "0", info: "keywords is required", pois: [] }, { status: 400 });
      if (!webServiceKey) return Response.json({ status: "0", info: "web service key is not configured", pois: [] }, { status: 503 });
      const searchCacheKey = `${AMAP_SEARCH_CACHE_PREFIX}${amapCacheScope(currentUser)}${keyword.replace(/\s+/g, " ").toLocaleLowerCase()}|${city.toLocaleLowerCase()}|${location ?? "national"}`;
      if (env.ROADBOOK_KV) {
        const cached = await env.ROADBOOK_KV.get(searchCacheKey, "json") as AMapSearchPayload | null;
        if (cached) return Response.json(cached, { headers: { "Cache-Control": `${accountMode ? "private" : "public"}, max-age=${AMAP_SEARCH_CACHE_TTL}`, "X-Search-Cache": "HIT" } });
      }

      const textUrl = new URL("https://restapi.amap.com/v3/place/text");
      textUrl.searchParams.set("key", webServiceKey);
      textUrl.searchParams.set("keywords", keyword);
      textUrl.searchParams.set("offset", "25");
      textUrl.searchParams.set("page", "1");
      textUrl.searchParams.set("extensions", "all");
      textUrl.searchParams.set("citylimit", "false");
      if (city) textUrl.searchParams.set("city", city);

      const requests: Array<Promise<{ kind: "text" | "around" | "tips"; response: Response }>> = [
        fetch(textUrl).then((response) => ({ kind: "text", response })),
      ];
      if (location) {
        const aroundUrl = new URL("https://restapi.amap.com/v3/place/around");
        aroundUrl.searchParams.set("key", webServiceKey);
        aroundUrl.searchParams.set("keywords", keyword);
        aroundUrl.searchParams.set("location", location);
        aroundUrl.searchParams.set("radius", "50000");
        aroundUrl.searchParams.set("sortrule", "weight");
        aroundUrl.searchParams.set("offset", "25");
        aroundUrl.searchParams.set("page", "1");
        aroundUrl.searchParams.set("extensions", "all");
        requests.push(fetch(aroundUrl).then((response) => ({ kind: "around", response })));
      }
      if (city || location) {
        const tipsUrl = new URL("https://restapi.amap.com/v3/assistant/inputtips");
        tipsUrl.searchParams.set("key", webServiceKey);
        tipsUrl.searchParams.set("keywords", keyword);
        tipsUrl.searchParams.set("datatype", "poi");
        tipsUrl.searchParams.set("citylimit", "false");
        if (city) tipsUrl.searchParams.set("city", city);
        if (location) tipsUrl.searchParams.set("location", location);
        requests.push(fetch(tipsUrl).then((response) => ({ kind: "tips", response })));
      }

      const settled = await Promise.allSettled(requests);
      const batches: Array<{ pois: unknown[]; sourcePriority: number }> = [];
      let successfulUpstream = false;
      for (const result of settled) {
        if (result.status !== "fulfilled" || !result.value.response.ok) continue;
        const payload = await result.value.response.json() as AMapSearchPayload & { tips?: unknown[] };
        if (payload.status !== "1") continue;
        successfulUpstream = true;
        if (result.value.kind === "tips") {
          batches.push({ pois: inputTipsToPois(payload), sourcePriority: 3 });
        } else {
          batches.push({ pois: Array.isArray(payload.pois) ? payload.pois : [], sourcePriority: result.value.kind === "around" ? 3 : 1 });
        }
      }
      if (!successfulUpstream) return Response.json({ status: "0", info: "amap search failed", pois: [] }, { status: 502 });

      const payload = { status: "1", info: "OK", pois: rankAmapPois(batches, keyword) } satisfies AMapSearchPayload;
      if (env.ROADBOOK_KV) ctx.waitUntil(env.ROADBOOK_KV.put(searchCacheKey, JSON.stringify(payload), { expirationTtl: AMAP_SEARCH_CACHE_TTL }));
      return Response.json(payload, { headers: { "Cache-Control": `${accountMode ? "private" : "public"}, max-age=${AMAP_SEARCH_CACHE_TTL}`, "X-Search-Cache": env.ROADBOOK_KV ? "MISS" : "BYPASS" } });
    }

    if (url.pathname === "/api/amap/service-areas" && request.method === "GET") {
      const webServiceKey = getAmapCredentials(env, currentUser).webKey;
      const origin = normalizeCoordinate(url.searchParams.get("origin"));
      const destination = normalizeCoordinate(url.searchParams.get("destination"));
      if (!webServiceKey) return Response.json({ status: "0", info: "web service key is not configured", highway: false, serviceAreas: [] }, { status: 503 });
      if (!origin || !destination) return Response.json({ status: "0", info: "invalid route parameters", highway: false, serviceAreas: [] }, { status: 400 });

      const cacheKey = `${AMAP_SERVICE_AREA_CACHE_PREFIX}${amapCacheScope(currentUser)}${origin}|${destination}|policy=0`;
      if (env.ROADBOOK_KV) {
        const cached = await env.ROADBOOK_KV.get(cacheKey, "json") as { status?: string; highway?: boolean; serviceAreas?: unknown[] } | null;
        if (cached?.status === "1") return Response.json(cached, { headers: { "Cache-Control": `${accountMode ? "private" : "public"}, max-age=${AMAP_SERVICE_AREA_CACHE_TTL}`, "X-Service-Area-Cache": "HIT" } });
      }

      const routeUrl = new URL("https://restapi.amap.com/v5/direction/driving");
      routeUrl.searchParams.set("key", webServiceKey);
      routeUrl.searchParams.set("origin", origin);
      routeUrl.searchParams.set("destination", destination);
      routeUrl.searchParams.set("strategy", "0");
      routeUrl.searchParams.set("ferry", "0");
      routeUrl.searchParams.set("show_fields", "cost,navi,polyline");
      routeUrl.searchParams.set("output", "json");
      const routeResponse = await fetch(routeUrl);
      if (!routeResponse.ok) return Response.json({ status: "0", info: "amap route failed", highway: false, serviceAreas: [] }, { status: 502 });
      const routePayload = await routeResponse.json() as { status?: string; info?: string };
      if (routePayload.status !== "1") return Response.json({ status: "0", info: routePayload.info || "amap route failed", highway: false, serviceAreas: [] }, { status: 502 });
      const highwayPath = extractHighwayPath(routePayload);
      if (highwayPath.length < 2) {
        const payload = { status: "1", info: "OK", highway: false, serviceAreas: [] };
        if (env.ROADBOOK_KV) ctx.waitUntil(env.ROADBOOK_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: AMAP_SERVICE_AREA_CACHE_TTL }));
        return Response.json(payload, { headers: { "Cache-Control": `${accountMode ? "private" : "public"}, max-age=${AMAP_SERVICE_AREA_CACHE_TTL}` } });
      }

      const searchPoints = sampleRouteSearchPoints(highwayPath);
      const poiBatches = await mapShareWithConcurrency(searchPoints, 3, async ([lng, lat]) => {
        const aroundUrl = new URL("https://restapi.amap.com/v3/place/around");
        aroundUrl.searchParams.set("key", webServiceKey);
        aroundUrl.searchParams.set("location", `${lng.toFixed(6)},${lat.toFixed(6)}`);
        aroundUrl.searchParams.set("keywords", "服务区");
        aroundUrl.searchParams.set("radius", "50000");
        aroundUrl.searchParams.set("sortrule", "distance");
        aroundUrl.searchParams.set("offset", "25");
        aroundUrl.searchParams.set("page", "1");
        aroundUrl.searchParams.set("extensions", "all");
        aroundUrl.searchParams.set("output", "json");
        try {
          const response = await fetch(aroundUrl);
          if (!response.ok) return [] as unknown[];
          const payload = await response.json() as { status?: string; pois?: unknown[] };
          return payload.status === "1" && Array.isArray(payload.pois) ? payload.pois : [];
        } catch {
          return [] as unknown[];
        }
      });
      const serviceAreas = rankRouteServiceAreas(poiBatches.flat(), highwayPath);
      const payload = { status: "1", info: "OK", highway: true, serviceAreas };
      if (env.ROADBOOK_KV) ctx.waitUntil(env.ROADBOOK_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: AMAP_SERVICE_AREA_CACHE_TTL }));
      return Response.json(payload, { headers: { "Cache-Control": `${accountMode ? "private" : "public"}, max-age=${AMAP_SERVICE_AREA_CACHE_TTL}`, "X-Service-Area-Cache": env.ROADBOOK_KV ? "MISS" : "BYPASS" } });
    }

    if (url.pathname === "/api/amap-config") {
      const credentials = currentUser ? getAmapCredentials(env, currentUser) : envAmapCredentials(env);
      return Response.json({
        jsKey: credentials.jsKey,
        securityCode: credentials.securityCode,
        webKey: currentUser ? credentials.webKey : "",
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
