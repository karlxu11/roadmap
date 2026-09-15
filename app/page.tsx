"use client";
/* eslint-disable jsx-a11y/no-autofocus -- the note editor opens for immediate keyboard entry. */

import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { daxinganlingDays, initialDays as importedDays, tibetDays } from "./roadbook-data";
import { combineRoutePaths, hasDrawableRoutePath, normalizeRoutePath } from "./route-path";

type StopKind = "出发" | "途经" | "住宿" | "景点";

type Stop = {
  id: string;
  name: string;
  area: string;
  kind: StopKind;
  lat: number;
  lng: number;
  duration: string;
  note?: string;
};
type MapMarkerStop = Stop & { mapLabel?: string };

type DayPlan = {
  id: string;
  date: string;
  title: string;
  subtitle: string;
  stops: Stop[];
};

type Roadbook = {
  id: string;
  title: string;
  description: string;
  region: string;
  updated: string;
  startDate?: string;
  days: DayPlan[];
};

type SharedLegMetric = { distance?: number; duration?: number; tolls?: number };
type SharedSnapshot = {
  version: 1;
  roadbook: Roadbook;
  legs: Record<string, SharedLegMetric>;
  paths?: Record<string, Array<[number, number]>>;
  createdAt: string;
};
type ShareLink = {
  token?: string;
  url: string;
  roadbookId: string;
  roadbookTitle: string;
  createdAt: string;
  expiresAt: string;
  permanent?: boolean;
  storage: "cloud" | "browser";
};

type SearchLocation = { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number };
type SearchResult = { id: string; name: string; address: string; location?: { lng: number; lat: number }; type: string; distance?: number };
type AMapWebSearchPoi = { id?: string; name?: string; address?: string; location?: string; type?: string; pname?: string; cityname?: string; adname?: string; distance?: number | string };
type AMapWebSearchPayload = { status?: string; info?: string; pois?: AMapWebSearchPoi[] };
type RouteServiceArea = { id?: string; name: string; address: string; type: string; lng: number; lat: number; distanceFromStart: number; distanceToRoute: number };
type ServiceAreaLegState = { status: "loading" } | { status: "ready"; highway: boolean; items: RouteServiceArea[] } | { status: "error" };
type ServiceAreaPayload = { status?: string; info?: string; highway?: boolean; serviceAreas?: RouteServiceArea[] };
type AppUser = { id: string; username: string; displayName: string };
type AdminUserSummary = {
  id: string;
  username: string;
  createdAt: string;
  amap: { jsKey: string; securityCode: string; webKey: string };
};

type AMapInstance = {
  Map: new (container: HTMLElement, options: Record<string, unknown>) => AMapMap;
  LngLat: new (lng: number, lat: number) => unknown;
  Marker: new (options: Record<string, unknown>) => AMapMarker;
  Polyline: new (options: Record<string, unknown>) => AMapPolyline;
  Driving: new (options: Record<string, unknown>) => AMapDriving;
  PlaceSearch: new (options: Record<string, unknown>) => AMapPlaceSearch;
};

type AMapMap = {
  add: (items: unknown[]) => void;
  remove: (items: unknown[]) => void;
  setFitView: (items?: unknown[]) => void;
  setCenter: (center: unknown) => void;
  destroy: () => void;
};

type AMapMarker = { setMap: (map: AMapMap | null) => void };
type AMapPolyline = { setMap: (map: AMapMap | null) => void };
type AMapRoutePoint = { getLng?: () => number; getLat?: () => number; lng?: number; lat?: number };
type AMapDrivingRoute = { distance?: number; time?: number; tolls?: number; steps?: Array<{ path?: AMapRoutePoint[] }> };
type AMapDriving = {
  search: (origin: unknown, destination: unknown, options: Record<string, unknown>, callback: (status: string, result: { routes?: AMapDrivingRoute[] } | string) => void) => void;
  clear: () => void;
};
type AMapPlaceSearch = {
  setCity?: (city: string) => void;
  setCityLimit?: (cityLimit: boolean) => void;
  search: (keyword: string, callback: (status: string, result: { poiList?: { pois?: Array<{ id?: string; name: string; address?: string; location?: SearchLocation; type?: string }> } }) => void) => void;
};

declare global {
  interface Window {
    AMap?: AMapInstance;
    _AMapSecurityConfig?: { securityJsCode?: string };
  }
}

const initialDays: DayPlan[] = importedDays as unknown as DayPlan[];
const importedTibetDays: DayPlan[] = tibetDays as unknown as DayPlan[];

const ROADBOOK_LIBRARY_KEY = "roadbook-library-v1";
const ROADBOOK_DRAFT_META_KEY = "roadbook-library-v1-draft";
const ACTIVE_ROADBOOK_KEY = "roadbook-last-active-v1";
const LEGACY_ROADBOOK_KEY = "roadbook-days-v2";
const ROUTE_CACHE_KEY = "roadbook-route-cache-v1";
const STARTER_ROADBOOK_IDS = new Set([
  "roadbook-69defbdbf04061086bd0cf71",
  "roadbook-amap-686f74ae52f2600e6d48cbdd",
  "roadbook-amap-6a6ac8888244b107b7cfb234",
]);
const ROUTE_CACHE_TTL = 24 * 60 * 60 * 1000;
// 高德偶发限流或网络抖动时，短暂退避后自动补拉，避免路段永远停在“正在计算”。
const ROUTE_FAILURE_RETRY_TTL = 15 * 1000;
const ROUTE_REQUEST_CONCURRENCY = 4;
const ROUTE_CACHE_PATH_MAX_POINTS = 240;
const ROUTE_CACHE_SAVE_DELAY = 750;
const ROADBOOK_LOCAL_SAVE_DELAY = 350;
const BACKGROUND_ROUTE_DELAY = 4000;
const DEFAULT_EDITOR_WIDTH = 67;
const SEARCH_CACHE_TTL = 10 * 60 * 1000;
const SHARE_QUERY_KEY = "share";
const SHARE_LINKS_KEY = "roadbook-share-links-v1";
const SHARE_LINK_TTL = 30 * 24 * 60 * 60 * 1000;

function scopedStorageKey(key: string, scope = "legacy") {
  return scope === "legacy" ? key : `${key}:${scope}`;
}

type CachedLeg = { distance?: number; duration?: number; tolls?: number | null; path?: Array<[number, number]>; cachedAt: number };
type RouteCache = { legs: Record<string, CachedLeg>; paths: Record<string, Array<[number, number]>>; errors: Record<string, number> };
type RouteApiPayload = { status?: string; info?: string; route?: { distance?: number; duration?: number; tolls?: number | null; path?: Array<[number, number]> } };
type RoadbookDraftMeta = { dirty: boolean; updatedAt: number };

// 高德偶尔会返回完整的距离/时长，但不返回 tolls。用 null 记录这种结果，
// 否则每次刷新都会把同一路段误判为未缓存并再次请求。

function routeCacheKey(stops: Stop[]) {
  return stops.map((stop) => `${stop.lng.toFixed(6)},${stop.lat.toFixed(6)}`).join("|");
}

function legCacheKey(from: Stop, to: Stop) {
  return `${from.lng.toFixed(6)},${from.lat.toFixed(6)}>${to.lng.toFixed(6)},${to.lat.toFixed(6)}|policy:0`;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>) {
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

function loadRouteCache(storageScope = "legacy"): RouteCache {
  if (typeof window === "undefined") return { legs: {}, paths: {}, errors: {} };
  try {
    const now = Date.now();
    const parsed = JSON.parse(window.localStorage.getItem(scopedStorageKey(ROUTE_CACHE_KEY, storageScope)) ?? "null") as Partial<RouteCache> | null;
    const legs = Object.fromEntries(Object.entries(parsed?.legs ?? {}).flatMap(([key, value]) => {
      if (!value || typeof value !== "object") return [];
      const candidate = value as Partial<CachedLeg>;
      if (typeof candidate.cachedAt !== "number" || !Number.isFinite(candidate.cachedAt)
        || now - candidate.cachedAt >= ROUTE_CACHE_TTL
        || typeof candidate.distance !== "number" || !Number.isFinite(candidate.distance)
        || typeof candidate.duration !== "number" || !Number.isFinite(candidate.duration)) return [];
      const tolls = typeof candidate.tolls === "number" && Number.isFinite(candidate.tolls) ? candidate.tolls : null;
      const path = sampleRoutePath(normalizeRoutePath(candidate.path), ROUTE_CACHE_PATH_MAX_POINTS);
      return [[key, { distance: candidate.distance, duration: candidate.duration, tolls, path: path.length >= 2 ? path : undefined, cachedAt: candidate.cachedAt } satisfies CachedLeg]];
    }));
    const paths = Object.fromEntries(Object.entries(parsed?.paths ?? {}).flatMap(([key, value]) => {
      if (!Array.isArray(value) || value.length < 2) return [];
      const path = sampleRoutePath(normalizeRoutePath(value), ROUTE_CACHE_PATH_MAX_POINTS);
      return path.length >= 2 ? [[key, path]] : [];
    }));
    const errors = Object.fromEntries(Object.entries(parsed?.errors ?? {}).filter(([, retryAt]) => typeof retryAt === "number" && Number.isFinite(retryAt)));
    return { legs, paths, errors };
  } catch {
    return { legs: {}, paths: {}, errors: {} };
  }
}

function saveRouteCache(cache: RouteCache, storageScope = "legacy") {
  const compactLegs = Object.fromEntries(Object.entries(cache.legs).map(([key, leg]) => [key, {
    distance: leg.distance,
    duration: leg.duration,
    tolls: leg.tolls,
    path: leg.path?.length ? sampleRoutePath(leg.path, ROUTE_CACHE_PATH_MAX_POINTS) : undefined,
    cachedAt: leg.cachedAt,
  }]));
  const compactPaths = Object.fromEntries(Object.entries(cache.paths).map(([key, path]) => [key, sampleRoutePath(path, ROUTE_CACHE_PATH_MAX_POINTS)]));
  const compactCache: RouteCache = { legs: compactLegs, paths: compactPaths, errors: cache.errors };
  try {
    window.localStorage.setItem(scopedStorageKey(ROUTE_CACHE_KEY, storageScope), JSON.stringify(compactCache));
  } catch {
    // 轨迹点可能让 localStorage 超限；清掉旧的大对象后只保留指标，避免刷新后全部重算。
    try {
      window.localStorage.removeItem(scopedStorageKey(ROUTE_CACHE_KEY, storageScope));
      const metricsOnly = {
        legs: Object.fromEntries(Object.entries(compactLegs).map(([key, leg]) => [key, { distance: leg.distance, duration: leg.duration, tolls: leg.tolls, cachedAt: leg.cachedAt }])),
        paths: {},
        errors: cache.errors,
      } satisfies RouteCache;
      window.localStorage.setItem(scopedStorageKey(ROUTE_CACHE_KEY, storageScope), JSON.stringify(metricsOnly));
    } catch {
      // Route data is only a disposable optimization cache.
    }
  }
}

function isFreshCachedLeg(leg: CachedLeg | undefined, now = Date.now(), requirePath = false) {
  return Boolean(
    leg
    && Number.isFinite(leg.cachedAt)
    && now - leg.cachedAt < ROUTE_CACHE_TTL
    && Number.isFinite(leg.distance)
    && Number.isFinite(leg.duration)
    && (!requirePath || hasDrawableRoutePath(leg.path)),
  );
}

function displayCachedLeg(leg: CachedLeg) {
  return {
    distance: leg.distance,
    duration: leg.duration,
    tolls: typeof leg.tolls === "number" ? leg.tolls : undefined,
  };
}

function routePathFromResult(route?: AMapDrivingRoute) {
  return route?.steps?.flatMap((step) => step.path ?? []).map((point) => {
    const lng = typeof point.getLng === "function" ? point.getLng() : point.lng;
    const lat = typeof point.getLat === "function" ? point.getLat() : point.lat;
    return typeof lng === "number" && typeof lat === "number" ? [lng, lat] as [number, number] : null;
  }).filter((point): point is [number, number] => point !== null) ?? [];
}

function sampleRoutePath(path: Array<[number, number]>, maxPoints = 500) {
  if (path.length <= maxPoints) return path;
  const step = Math.max(1, Math.ceil((path.length - 1) / (maxPoints - 1)));
  return path.filter((_, index) => index % step === 0 || index === path.length - 1);
}

async function fetchRouteLeg(stop: Stop, destination: Stop, includePath: boolean) {
  const requestWithJsApi = () => new Promise<CachedLeg | null>((resolve) => {
    if (!window.AMap?.Driving) {
      resolve(null);
      return;
    }
    const driving = new window.AMap.Driving({ policy: 0 });
    const timeout = window.setTimeout(() => {
      driving.clear();
      resolve(null);
    }, 12000);
    try {
      // 普通路线只取基础字段；分享准备阶段才请求完整路径。
      driving.search(new window.AMap.LngLat(stop.lng, stop.lat), new window.AMap.LngLat(destination.lng, destination.lat), { extensions: includePath ? "all" : "base" }, (status, result) => {
        window.clearTimeout(timeout);
        const route = typeof result === "object" ? result.routes?.[0] : undefined;
        const path = includePath ? sampleRoutePath(routePathFromResult(route), ROUTE_CACHE_PATH_MAX_POINTS) : [];
        resolve(status === "complete" && route && Number.isFinite(route.distance) && Number.isFinite(route.time)
          ? { distance: route.distance, duration: route.time, tolls: typeof route.tolls === "number" && Number.isFinite(route.tolls) ? route.tolls : null, path: path.length >= 2 ? path : undefined, cachedAt: Date.now() }
          : null);
      });
    } catch {
      window.clearTimeout(timeout);
      resolve(null);
    }
  });

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const params = new URLSearchParams({
      origin: `${stop.lng.toFixed(6)},${stop.lat.toFixed(6)}`,
      destination: `${destination.lng.toFixed(6)},${destination.lat.toFixed(6)}`,
      policy: "0",
      includePath: includePath ? "1" : "0",
    });
    const response = await fetch(`/api/amap/route?${params.toString()}`, { headers: { Accept: "application/json" }, signal: controller.signal, cache: "force-cache" });
    // Worker 上游高德返回 5xx/限流时，回退到已经加载的 JS API，避免整段路线被判失败。
    if (!response.ok) return response.status === 404 || response.status === 429 || response.status >= 500 ? requestWithJsApi() : null;
    const payload = await response.json() as RouteApiPayload;
    if (payload.status !== "1" || !payload.route || typeof payload.route.distance !== "number" || typeof payload.route.duration !== "number") return null;
    const metric = {
      distance: payload.route.distance,
      duration: payload.route.duration,
      tolls: typeof payload.route.tolls === "number" ? payload.route.tolls : null,
      path: includePath ? sampleRoutePath(normalizeRoutePath(payload.route.path), ROUTE_CACHE_PATH_MAX_POINTS) : [],
      cachedAt: Date.now(),
    };
    if (includePath && !hasDrawableRoutePath(metric.path)) return requestWithJsApi();
    return metric;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function requestRouteLeg(stop: Stop, destination: Stop, key: string, pendingLegs: Map<string, Promise<CachedLeg | null>>, includePath = false) {
  const pendingKey = `${key}|path:${includePath ? "1" : "0"}`;
  const pending = pendingLegs.get(pendingKey);
  if (pending) return pending;
  const promise = fetchRouteLeg(stop, destination, includePath);
  pendingLegs.set(pendingKey, promise);
  void promise.finally(() => pendingLegs.delete(pendingKey));
  return promise;
}

function encodeShareSnapshot(snapshot: SharedSnapshot) {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeShareSnapshot(value: string): SharedSnapshot | null {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<SharedSnapshot>;
    if (parsed.version !== 1 || !parsed.roadbook || !Array.isArray(parsed.roadbook.days) || !parsed.legs || typeof parsed.legs !== "object") return null;
    return parsed as SharedSnapshot;
  } catch {
    return null;
  }
}

async function loadShareSnapshot() {
  if (typeof window === "undefined") return null;
  const encoded = new URLSearchParams(window.location.search).get(SHARE_QUERY_KEY);
  if (!encoded) return null;
  const inline = decodeShareSnapshot(encoded);
  if (inline) return inline;
  try {
    const response = await fetch(`/api/shares?token=${encodeURIComponent(encoded)}`, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return null;
    const payload = await response.json() as { snapshot?: SharedSnapshot };
    return payload.snapshot ?? null;
  } catch {
    return null;
  }
}

function hasShareQuery() {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).has(SHARE_QUERY_KEY);
}

function isCloudShareToken(value: string) {
  return /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

function expectedShareLegCount(roadbook: Roadbook) {
  return roadbook.days.reduce((count, day) => count + Math.max(day.stops.length - 1, 0), 0);
}

function hasDetailedSharePath(path: Array<[number, number]> | undefined, stops: Stop[]) {
  // 地点数量相同的路径是早期分享快照的直连兜底；旧版本还会把
  // 整天的长路线截断在前 500 个点。两者都等待后台补齐后再绘制。
  const destination = stops.at(-1);
  const finalPoint = path?.at(-1);
  if (!path || path.length <= Math.max(stops.length, 2) || !destination || !finalPoint) return false;
  const lngDelta = (finalPoint[0] - destination.lng) * Math.cos(destination.lat * Math.PI / 180);
  const latDelta = finalPoint[1] - destination.lat;
  return Math.hypot(lngDelta, latDelta) < 0.03;
}

function isCompleteShareSnapshot(snapshot: SharedSnapshot) {
  return Object.keys(snapshot.legs).length >= expectedShareLegCount(snapshot.roadbook)
    && snapshot.roadbook.days.filter((day) => day.stops.length >= 2).every((day) => hasDetailedSharePath(snapshot.paths?.[routeCacheKey(day.stops)], day.stops));
}

function projectMapPoint(point: [number, number], points: Array<[number, number]>) {
  const longitudes = points.map(([lng]) => lng);
  const latitudes = points.map(([, lat]) => lat);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const lngRange = Math.max(maxLng - minLng, 0.000001);
  const latRange = Math.max(maxLat - minLat, 0.000001);
  return {
    x: 8 + ((point[0] - minLng) / lngRange) * 84,
    y: 92 - ((point[1] - minLat) / latRange) * 84,
  };
}

function projectRoutePaths(paths: Array<Array<[number, number]>>, markerStops: Stop[], boundaryStops = markerStops) {
  const points = [...paths.flat(), ...boundaryStops.map((stop) => [stop.lng, stop.lat] as [number, number])];
  if (points.length < 2) return { lines: [] as string[], markers: [] as Array<{ x: number; y: number }> };
  const maxPoints = 280;
  return {
    lines: paths.map((path) => {
      const step = Math.max(1, Math.ceil(path.length / maxPoints));
      return path.filter((_, index) => index % step === 0 || index === path.length - 1).map((point) => {
        const projected = projectMapPoint(point, points);
        return `${projected.x},${projected.y}`;
      }).join(" ");
    }),
    markers: markerStops.map((stop) => projectMapPoint([stop.lng, stop.lat], points)),
  };
}

function defaultRoadbook(): Roadbook {
  return {
    id: "roadbook-69defbdbf04061086bd0cf71",
    title: "五一伊犁",
    description: "从深圳出发，穿越河西走廊，游览赛里木湖、库尔德宁与那拉提草原后返程",
    region: "深圳 → 伊犁 → 深圳",
    updated: "已从高德路书导入",
    startDate: "2026-04-29",
    days: initialDays,
  };
}

function tibetRoadbook(): Roadbook {
  return {
    id: "roadbook-amap-686f74ae52f2600e6d48cbdd",
    title: "西藏",
    description: "从深圳出发，沿318国道进藏，串联拉萨、山南、日喀则、林芝与昌都后返程",
    region: "深圳 → 西藏 → 深圳",
    updated: "已从高德路书导入",
    startDate: "2025-09-20",
    days: importedTibetDays,
  };
}

function daxinganlingRoadbook(): Roadbook {
  return {
    id: "roadbook-amap-6a6ac8888244b107b7cfb234",
    title: "2026中秋国庆大兴安岭",
    description: "从深圳出发，经洛阳、乌兰察布、锡林郭勒、赤峰、阿尔山与呼伦贝尔后返程",
    region: "深圳 → 大兴安岭 → 深圳",
    updated: "已从高德路书导入",
    startDate: "2026-09-19",
    days: daxinganlingDays as unknown as DayPlan[],
  };
}

function parseMonthDay(value: string) {
  const match = value.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  return match ? { month: Number(match[1]), day: Number(match[2]) } : null;
}

function parseCalendarDate(value?: string) {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function formatCalendarDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getRoadbookStartDate(roadbook: Roadbook) {
  const configured = parseCalendarDate(roadbook.startDate);
  if (configured) return configured;
  const first = parseMonthDay(roadbook.days[0]?.date ?? "");
  const titleYear = Number(roadbook.title.match(/20\d{2}/)?.[0] ?? new Date().getFullYear());
  return first ? new Date(titleYear, first.month - 1, first.day) : new Date();
}

function normalizeSearchLocation(location?: SearchLocation | string) {
  if (typeof location === "string") {
    const [lng, lat] = location.split(",").map(Number);
    return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : undefined;
  }
  if (!location) return undefined;
  const lng = typeof location.getLng === "function" ? location.getLng() : location.lng;
  const lat = typeof location.getLat === "function" ? location.getLat() : location.lat;
  return typeof lng === "number" && Number.isFinite(lng) && typeof lat === "number" && Number.isFinite(lat) ? { lng, lat } : undefined;
}

function searchContextStop(day: DayPlan) {
  return [...day.stops].reverse().find((stop) => stop.area !== "点击右侧搜索添加" && !stop.name.startsWith("添加一个")) ?? day.stops.at(-1);
}

function isRoutePlaceholder(stop: Stop) {
  return stop.area === "点击右侧搜索添加" || stop.name.startsWith("添加一个");
}

function fallbackDay(): DayPlan {
  return { id: uid("day"), date: "待安排", title: "第一天", subtitle: "先把想去的地方放进来", stops: [] };
}

function normalizeStoredStop(value: unknown): Stop | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<Stop>;
  const lat = typeof raw.lat === "number" ? raw.lat : Number(raw.lat);
  const lng = typeof raw.lng === "number" ? raw.lng : Number(raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const kind: StopKind = raw.kind === "出发" || raw.kind === "途经" || raw.kind === "住宿" || raw.kind === "景点" ? raw.kind : "景点";
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : uid("stop"),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : "未命名地点",
    area: typeof raw.area === "string" ? raw.area : "已添加地点",
    kind,
    lat,
    lng,
    duration: typeof raw.duration === "string" && raw.duration.trim() ? raw.duration : "待安排",
    ...(typeof raw.note === "string" && raw.note.trim() ? { note: raw.note } : {}),
  };
}

function normalizeStoredDay(value: unknown, index: number): DayPlan | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<DayPlan>;
  const stops = Array.isArray(raw.stops) ? raw.stops.map(normalizeStoredStop).filter((stop): stop is Stop => Boolean(stop)) : [];
  const migratedStops = stops.length === 1 && stops[0].name === "添加出发点" && stops[0].area === "点击“添加地点”搜索" ? [] : stops;
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : uid("day"),
    date: typeof raw.date === "string" && raw.date.trim() ? raw.date : "待安排",
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : `第 ${index + 1} 天`,
    subtitle: typeof raw.subtitle === "string" ? raw.subtitle : "先把想去的地方放进来",
    stops: migratedStops,
  };
}

function normalizeStoredRoadbook(value: unknown): Roadbook | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<Roadbook>;
  const days = Array.isArray(raw.days) ? raw.days.map(normalizeStoredDay).filter((day): day is DayPlan => Boolean(day)) : [];
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : uid("roadbook"),
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : "未命名路书",
    description: typeof raw.description === "string" ? raw.description : "一段新的旅程",
    region: typeof raw.region === "string" ? raw.region : "自定义行程",
    updated: typeof raw.updated === "string" ? raw.updated : "刚刚更新",
    ...(typeof raw.startDate === "string" ? { startDate: raw.startDate } : {}),
    days: days.length ? days : [fallbackDay()],
  };
}

function normalizeStoredRoadbooks(value: unknown): Roadbook[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeStoredRoadbook).filter((roadbook): roadbook is Roadbook => Boolean(roadbook));
}

function searchCityHint(stop?: Stop) {
  if (!stop) return "";
  return stop.area.split("·")[0]?.trim() ?? "";
}

function formatMonthDay(date: Date) {
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function normalizeDayDates(days: DayPlan[]) {
  if (!days.length) return days;
  const first = parseMonthDay(days[0].date) ?? { month: 9, day: 19 };
  // 只需要计算月日顺延，不依赖真实年份；使用闰年避免跨月时出现日期异常。
  const base = new Date(2024, first.month - 1, first.day);
  return days.map((day, index) => {
    const date = new Date(base);
    date.setDate(base.getDate() + index);
    return { ...day, date: formatMonthDay(date) };
  });
}

function normalizeRoadbookDates(roadbooks: Roadbook[]) {
  return normalizeStoredRoadbooks(roadbooks).map((roadbook) => {
    const startDate = getRoadbookStartDate(roadbook);
    return {
      ...roadbook,
      startDate: formatCalendarDate(startDate),
      days: roadbook.days.map((day, index) => {
        const date = new Date(startDate);
        date.setDate(startDate.getDate() + index);
        return { ...day, date: formatMonthDay(date) };
      }),
    };
  });
}

function ensureImportedRoadbook(roadbooks: Roadbook[]) {
  const imported = defaultRoadbook();
  const tibet = tibetRoadbook();
  const daxinganling = daxinganlingRoadbook();
  const existingIds = new Set(roadbooks.map((roadbook) => roadbook.id));
  const additions = [daxinganling, tibet, imported].filter((roadbook) => !existingIds.has(roadbook.id));
  return { roadbooks: [...additions, ...roadbooks], added: additions.length > 0 };
}

function isUnmodifiedStarterCollection(roadbooks: Roadbook[]) {
  return roadbooks.length === STARTER_ROADBOOK_IDS.size
    && new Set(roadbooks.map((roadbook) => roadbook.id)).size === STARTER_ROADBOOK_IDS.size
    && roadbooks.every((roadbook) => STARTER_ROADBOOK_IDS.has(roadbook.id));
}

function loadRoadbooks(storageScope = "legacy"): Roadbook[] {
  if (typeof window === "undefined") return [defaultRoadbook()];
  const libraryKey = scopedStorageKey(ROADBOOK_LIBRARY_KEY, storageScope);
  const draftMetaKey = scopedStorageKey(ROADBOOK_DRAFT_META_KEY, storageScope);
  const legacyKey = storageScope === "legacy" ? LEGACY_ROADBOOK_KEY : scopedStorageKey(LEGACY_ROADBOOK_KEY, storageScope);
  const savedLibrary = window.localStorage.getItem(libraryKey);
  if (savedLibrary) {
    try {
      const parsed = normalizeStoredRoadbooks(JSON.parse(savedLibrary));
      if (parsed.length) {
        if (storageScope !== "legacy" && isUnmodifiedStarterCollection(parsed)) return [makeFirstRoadbook()];
        return normalizeRoadbookDates(storageScope === "legacy" ? ensureImportedRoadbook(parsed).roadbooks : parsed);
      }
    } catch {
      window.localStorage.removeItem(libraryKey);
      window.localStorage.removeItem(draftMetaKey);
    }
  }
  const legacy = storageScope === "legacy" ? window.localStorage.getItem(legacyKey) : null;
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy);
      const days = Array.isArray(parsed) ? parsed.map(normalizeStoredDay).filter((day): day is DayPlan => Boolean(day)) : [];
      if (days.length) return [{ ...defaultRoadbook(), days: normalizeDayDates(days) }];
    } catch {
      window.localStorage.removeItem(LEGACY_ROADBOOK_KEY);
    }
  }
  return storageScope === "legacy"
    ? normalizeRoadbookDates(ensureImportedRoadbook([defaultRoadbook()]).roadbooks)
    : [makeFirstRoadbook()];
}

function loadRoadbookDraftMeta(storageScope = "legacy"): RoadbookDraftMeta {
  if (typeof window === "undefined") return { dirty: false, updatedAt: 0 };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(scopedStorageKey(ROADBOOK_DRAFT_META_KEY, storageScope)) ?? "null") as Partial<RoadbookDraftMeta> | null;
    return {
      dirty: parsed?.dirty === true,
      updatedAt: typeof parsed?.updatedAt === "number" && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
    };
  } catch {
    window.localStorage.removeItem(scopedStorageKey(ROADBOOK_DRAFT_META_KEY, storageScope));
    return { dirty: false, updatedAt: 0 };
  }
}

function preferredRoadbookId(roadbooks: Roadbook[], storageScope = "legacy") {
  if (typeof window === "undefined") return roadbooks[0]?.id ?? "";
  const savedId = window.localStorage.getItem(scopedStorageKey(ACTIVE_ROADBOOK_KEY, storageScope));
  return roadbooks.some((roadbook) => roadbook.id === savedId) ? savedId! : roadbooks[0]?.id ?? "";
}

function rememberActiveRoadbook(id: string, storageScope = "legacy") {
  if (typeof window === "undefined" || !id) return;
  try {
    window.localStorage.setItem(scopedStorageKey(ACTIVE_ROADBOOK_KEY, storageScope), id);
  } catch {
    // 当前路书只是设备偏好；存储不可用时仍可正常编辑。
  }
}

function saveRoadbooks(roadbooks: Roadbook[], dirty = true, storageScope = "legacy") {
  try {
    window.localStorage.setItem(scopedStorageKey(ROADBOOK_LIBRARY_KEY, storageScope), JSON.stringify(roadbooks));
    window.localStorage.setItem(scopedStorageKey(ROADBOOK_DRAFT_META_KEY, storageScope), JSON.stringify({ dirty, updatedAt: Date.now() } satisfies RoadbookDraftMeta));
    return true;
  } catch {
    return false;
  }
}

function loadLocalShareLinks(storageScope = "legacy"): ShareLink[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(scopedStorageKey(SHARE_LINKS_KEY, storageScope)) ?? "[]") as ShareLink[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item.url === "string" && typeof item.roadbookTitle === "string");
  } catch {
    return [];
  }
}

function saveLocalShareLinks(links: ShareLink[], storageScope = "legacy") {
  try {
    window.localStorage.setItem(scopedStorageKey(SHARE_LINKS_KEY, storageScope), JSON.stringify(links));
  } catch {
    // Share management is a convenience cache; the cloud index remains authoritative when configured.
  }
}

async function fetchRemoteRoadbooks(storageScope = "legacy") {
  const response = await fetch("/api/roadbooks", { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`roadbook-storage-${response.status}`);
  const payload = await response.json() as { roadbooks?: unknown };
  if (!Array.isArray(payload.roadbooks)) return null;
  const normalized = normalizeRoadbookDates(payload.roadbooks as Roadbook[]);
  if (!normalized.length) return { roadbooks: [makeFirstRoadbook()], added: true };
  if (storageScope !== "legacy") return { roadbooks: normalized, added: false };
  const seeded = ensureImportedRoadbook(normalized);
  return { roadbooks: seeded.roadbooks, added: seeded.added };
}

async function saveRemoteRoadbooks(roadbooks: Roadbook[]) {
  const response = await fetch("/api/roadbooks", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(roadbooks),
  });
  return response.ok;
}

function makeNewRoadbook(title: string, description: string): Roadbook {
  const startDate = new Date();
  const firstDay: DayPlan = {
    id: uid("day"),
    date: formatMonthDay(startDate),
    title: "新的第一天",
    subtitle: "先把想去的地方放进来",
    stops: [],
  };
  return {
    id: uid("roadbook"),
    title: title.trim() || "未命名路书",
    description: description.trim() || "一段新的旅程",
    region: "自定义行程",
    updated: "刚刚创建",
    startDate: formatCalendarDate(startDate),
    days: [firstDay],
  };
}

function makeFirstRoadbook() {
  return makeNewRoadbook("我的第一条路书", "开始规划你的旅程");
}

function makeCopiedRoadbook(source: Roadbook, title: string): Roadbook {
  return {
    ...source,
    id: uid("roadbook"),
    title: title.trim() || `${source.title} 副本`,
    updated: "刚刚复制",
    // 路段缓存以坐标为 key，因此保留地点坐标即可让副本直接复用已有的高德结果；
    // 但编辑界面使用 day/stop id 管理状态，副本必须拥有独立的 id。
    days: source.days.map((day) => ({
      ...day,
      id: uid("day"),
      stops: day.stops.map((stop) => ({ ...stop, id: uid("stop") })),
    })),
  };
}

function makeImportedRoadbook(source: Roadbook, title: string): Roadbook {
  return {
    ...source,
    id: uid("roadbook"),
    title: title.trim() || source.title || "未命名路书",
    updated: "刚刚从分享导入",
  };
}

function shareHasIndependentSource(link: ShareLink, links: ShareLink[], editableRoadbooks: Roadbook[]) {
  if (!editableRoadbooks.some((roadbook) => roadbook.id === link.roadbookId)) return false;
  // 多条历史分享若仍指向同一条路书，编辑其中一条会互相覆盖，不算独立可编辑。
  return links.filter((item) => item.roadbookId === link.roadbookId).length === 1;
}

async function fetchShareSnapshot(link: ShareLink) {
  if (link.token && (link.storage === "cloud" || isCloudShareToken(link.token))) {
    const response = await fetch(`/api/shares?token=${encodeURIComponent(link.token)}`, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return null;
    const payload = await response.json() as { snapshot?: SharedSnapshot };
    return payload.snapshot ?? null;
  }
  try {
    const encoded = new URL(link.url, typeof window === "undefined" ? "https://example.invalid" : window.location.origin).searchParams.get(SHARE_QUERY_KEY) ?? "";
    return encoded ? decodeShareSnapshot(encoded) : null;
  } catch {
    return null;
  }
}

function cacheImportedShareSnapshot(roadbook: Roadbook, snapshot: SharedSnapshot, cache: RouteCache) {
  cacheRoadbookPaths(roadbook, cache);
  Object.entries(snapshot.paths ?? {}).forEach(([key, path]) => {
    if (path.length >= 2) cache.paths[key] = path;
  });
}

function cacheRoadbookPaths(roadbook: Roadbook, cache: RouteCache) {
  roadbook.days.forEach((day) => {
    if (day.stops.length < 2) return;
    const path = combineRoutePaths(day.stops.slice(0, -1).map((stop, index) => cache.legs[legCacheKey(stop, day.stops[index + 1])]?.path));
    if (path.length >= 2) cache.paths[routeCacheKey(day.stops)] = path;
  });
}

function loadSavedSettings(storageScope = "legacy") {
  if (typeof window === "undefined") return { jsKey: "", securityCode: "", webKey: "" };
  const saved = window.localStorage.getItem(scopedStorageKey("roadbook-amap-settings", storageScope));
  if (!saved) return { jsKey: "", securityCode: "", webKey: "" };
  try {
    return JSON.parse(saved) as { jsKey: string; securityCode: string; webKey: string };
  } catch {
    return { jsKey: "", securityCode: "", webKey: "" };
  }
}

function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeInsertedDay(): DayPlan {
  return {
    id: uid("day"),
    date: "待安排",
    title: "留白的一天",
    subtitle: "放慢脚步，给旅程留一点弹性",
    stops: [],
  };
}

function formatDistance(meters?: number) {
  if (typeof meters !== "number" || !Number.isFinite(meters)) return "待计算";
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} 公里` : `${Math.round(meters)} 米`;
}

function formatKilometers(meters?: number) {
  if (typeof meters !== "number" || !Number.isFinite(meters)) return "待计算";
  return `${(meters / 1000).toFixed(1)} 公里`;
}

function formatSearchResultMeta(result: SearchResult) {
  const parts = [result.address, result.type];
  if (typeof result.distance === "number" && Number.isFinite(result.distance)) {
    parts.push(`距行程参考点 ${formatDistance(result.distance)}`);
  }
  return parts.join(" · ");
}

function formatDuration(seconds?: number) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "待计算";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
}

function formatTolls(tolls?: number) {
  if (typeof tolls !== "number" || !Number.isFinite(tolls)) return "待获取";
  return `${tolls.toFixed(2)} 元`;
}

function extractClock(value: string) {
  return value.match(/\b\d{1,2}:\d{2}\b/)?.[0] ?? "09:00";
}

function addDurationToClock(clock: string, seconds: number) {
  const [hours, minutes] = clock.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return "";
  const totalMinutes = (hours * 60 + minutes + Math.round(seconds / 60)) % (24 * 60);
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
}

function amapNavigationUrl(stops: Stop[]) {
  if (stops.length < 2) return "https://www.amap.com/";
  const start = stops[0];
  const end = stops.at(-1)!;
  return `https://uri.amap.com/navigation?from=${start.lng},${start.lat},${encodeURIComponent(start.name)}&to=${end.lng},${end.lat},${encodeURIComponent(end.name)}&mode=car&policy=1`;
}

function amapStopNavigationUrl(stop: Stop) {
  return `https://uri.amap.com/navigation?to=${stop.lng},${stop.lat},${encodeURIComponent(stop.name)}&mode=car&policy=1`;
}

export default function Home() {
  const [roadbooks, setRoadbooksState] = useState<Roadbook[]>(() => [defaultRoadbook()]);
  const [activeRoadbookId, setActiveRoadbookId] = useState(() => defaultRoadbook().id);
  const [authUser, setAuthUser] = useState<AppUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const activeRoadbook = roadbooks.find((roadbook) => roadbook.id === activeRoadbookId) ?? roadbooks[0];
  const starterTrip = activeRoadbook;
  const days = activeRoadbook.days;
  const [sharedSnapshot, setSharedSnapshot] = useState<SharedSnapshot | null>(null);
  const [shareLoadError, setShareLoadError] = useState(false);
  const readOnly = Boolean(sharedSnapshot);
  const [shareMapMode, setShareMapMode] = useState<"overview" | "day">("overview");
  const [selectedDayId, setSelectedDayId] = useState(() => defaultRoadbook().days[0].id);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showAdminUsers, setShowAdminUsers] = useState(false);
  const [adminUsers, setAdminUsers] = useState<AdminUserSummary[]>([]);
  const [isLoadingAdminUsers, setIsLoadingAdminUsers] = useState(false);
  const [adminUsersError, setAdminUsersError] = useState("");
  const [deletingAdminUserId, setDeletingAdminUserId] = useState<string | null>(null);
  const [showAddPlace, setShowAddPlace] = useState(false);
  const [editingStopId, setEditingStopId] = useState<string | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showCopyRoadbook, setShowCopyRoadbook] = useState(false);
  const [showShareManager, setShowShareManager] = useState(false);
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [isLoadingShareLinks, setIsLoadingShareLinks] = useState(false);
  const [importingShareKey, setImportingShareKey] = useState<string | null>(null);
  const [showCumulativeTolls, setShowCumulativeTolls] = useState(false);
  const [editorMapMode, setEditorMapMode] = useState<"overview" | "day">("day");
  const [editingNoteStopId, setEditingNoteStopId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [showToast, setShowToast] = useState("");
  const [isPreparingShare, setIsPreparingShare] = useState(false);
  const [storageStatus, setStorageStatus] = useState<"loading" | "remote" | "saving" | "local" | "unavailable">("loading");
  const [amapLoaded, setAmapLoaded] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState("");
  const [legMetrics, setLegMetrics] = useState<Record<string, { status: "loading" | "ready" | "error"; distance?: number; duration?: number; tolls?: number }>>({});
  const [serviceAreaLegs, setServiceAreaLegs] = useState<Record<string, ServiceAreaLegState>>({});
  const [activeServiceAreaLeg, setActiveServiceAreaLeg] = useState<string | null>(null);
  const [routeCacheLegs, setRouteCacheLegs] = useState<Record<string, CachedLeg>>({});
  const [routeCacheVersion, setRouteCacheVersion] = useState(0);
  const [selectedRouteCacheVersion, setSelectedRouteCacheVersion] = useState(0);
  const [routeRetryVersion, setRouteRetryVersion] = useState(0);
  const [settings, setSettings] = useState({ jsKey: "", securityCode: "", webKey: "" });
  const [editorWidth, setEditorWidth] = useState(DEFAULT_EDITOR_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [printPayload, setPrintPayload] = useState<{ roadbook: Roadbook; routeCache: RouteCache } | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<AMapMap | null>(null);
  const markersRef = useRef<AMapMarker[]>([]);
  const routeLineRef = useRef<AMapPolyline | null>(null);
  const overviewRouteLinesRef = useRef<AMapPolyline[]>([]);
  const routeCacheRef = useRef<RouteCache>({ legs: {}, paths: {}, errors: {} });
  const pendingLegsRef = useRef(new Map<string, Promise<CachedLeg | null>>());
  const pendingServiceAreasRef = useRef(new Map<string, Promise<void>>());
  const routeCacheSaveHandleRef = useRef<{ kind: "idle" | "timeout"; id: number } | null>(null);
  const localRoadbookSaveTimerRef = useRef<number | null>(null);
  const pendingLocalRoadbooksRef = useRef<Roadbook[] | null>(null);
  const localDraftDirtyRef = useRef(false);
  const localDraftRevisionRef = useRef(0);
  const placeSearchRef = useRef<AMapPlaceSearch | null>(null);
  const searchCacheRef = useRef(new Map<string, { results: SearchResult[]; cachedAt: number }>());
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchRequestIdRef = useRef(0);
  const searchDebounceRef = useRef<number | null>(null);

  const storageScope = authUser?.id ?? "legacy";
  const storageScopeRef = useRef(storageScope);
  useEffect(() => {
    storageScopeRef.current = storageScope;
  }, [storageScope]);

  const selectedDay = days.find((day) => day.id === selectedDayId) ?? days[0];
  const selectedDayIndex = Math.max(days.findIndex((day) => day.id === selectedDayId), 0);
  const isShareOverview = readOnly && shareMapMode === "overview";
  const isRoadbookOverview = isShareOverview || (!readOnly && editorMapMode === "overview");
  const overviewStops = useMemo(() => days.flatMap((day) => day.stops), [days]);
  const overviewMapMarkers = useMemo(() => days.flatMap((day, index) => {
    const departure = day.stops[0];
    const finalStop = day.stops.at(-1);
    if (!departure) return [];
    const start = { ...departure, mapLabel: `D${index + 1}` };
    return index === days.length - 1 && finalStop && finalStop.id !== departure.id
      ? [start, { ...finalStop, mapLabel: "终点" }]
      : [start];
  }), [days]);
  const roadbookOverviewPaths = useMemo(() => days.flatMap((day) => {
    if (day.stops.length < 2) return [];
    if (readOnly) {
      const path = sharedSnapshot?.paths?.[routeCacheKey(day.stops)];
      return hasDetailedSharePath(path, day.stops) ? [path] : [];
    }
    const combinedPath = combineRoutePaths(day.stops.slice(0, -1).map((stop, index) => routeCacheLegs[legCacheKey(stop, day.stops[index + 1])]?.path));
    const path = combinedPath.length >= 2 ? combinedPath : routeCacheRef.current.paths[routeCacheKey(day.stops)];
    return path?.length && path.length >= 2 ? [path] : [];
  }), [days, readOnly, routeCacheLegs, sharedSnapshot]);
  const mapStops = isRoadbookOverview ? overviewStops : selectedDay.stops;
  const mapMarkerStops: MapMarkerStop[] = isRoadbookOverview ? overviewMapMarkers : selectedDay.stops;
  const mapRoutePaths = useMemo(() => {
    if (isRoadbookOverview) return roadbookOverviewPaths;
    if (!readOnly || !sharedSnapshot) return [] as Array<Array<[number, number]>>;
    const path = sharedSnapshot.paths?.[routeCacheKey(selectedDay.stops)];
    return hasDetailedSharePath(path, selectedDay.stops) ? [path] : [];
  }, [isRoadbookOverview, readOnly, roadbookOverviewPaths, selectedDay.stops, sharedSnapshot]);
  const sharedMapProjection = useMemo(() => projectRoutePaths(mapRoutePaths, mapMarkerStops, mapStops), [mapMarkerStops, mapRoutePaths, mapStops]);
  const mapMarkerDependencyKey = useMemo(() => mapMarkerStops.map((stop) => `${stop.id}:${stop.lng.toFixed(6)},${stop.lat.toFixed(6)}`).join("|"), [mapMarkerStops]);
  const deferredMapMarkerDependencyKey = useDeferredValue(mapMarkerDependencyKey);
  const totalStops = useMemo(() => days.reduce((sum, day) => sum + day.stops.length, 0), [days]);
  const selectedDayRouteDependencyKey = useMemo(() => `${selectedDay.id}:${selectedDay.stops.map((stop) => `${stop.id}:${stop.lng.toFixed(6)},${stop.lat.toFixed(6)}`).join("|")}`, [selectedDay]);
  const routePlanDependencyKey = useMemo(() => days.map((day) => `${day.id}:${day.stops.map((stop) => `${stop.id}:${stop.lng.toFixed(6)},${stop.lat.toFixed(6)}`).join("|")}`).join("||"), [days]);
  const deferredSelectedDayRouteDependencyKey = useDeferredValue(selectedDayRouteDependencyKey);
  const deferredRoutePlanDependencyKey = useDeferredValue(routePlanDependencyKey);
  const displayLegMetrics = useMemo(() => {
    if (!sharedSnapshot) return legMetrics;
    return Object.fromEntries(Object.entries(sharedSnapshot.legs).map(([stopId, metric]) => [stopId, { status: "ready" as const, ...metric }])) as typeof legMetrics;
  }, [legMetrics, sharedSnapshot]);
  const dayDistanceSummaries = useMemo(() => {
    const cacheRevision = routeCacheVersion;
    return days.map((day) => {
      const metrics = day.stops.slice(0, -1).map((stop, index) => {
        const displayed = displayLegMetrics[stop.id];
        if (displayed?.status === "ready" && typeof displayed.distance === "number") return displayed;
        if (sharedSnapshot) return undefined;
        return routeCacheLegs[legCacheKey(stop, day.stops[index + 1])];
      });
      const complete = metrics.length > 0 && metrics.every((metric) => metric && typeof metric.distance === "number");
      return {
        dayId: day.id,
        complete,
        distance: complete ? metrics.reduce((sum, metric) => sum + (metric?.distance ?? 0), 0) : undefined,
        cacheRevision,
      };
    });
  }, [days, displayLegMetrics, routeCacheLegs, routeCacheVersion, sharedSnapshot]);
  const dayDistanceById = useMemo(() => Object.fromEntries(dayDistanceSummaries.map((summary) => [summary.dayId, summary])), [dayDistanceSummaries]);
  const roadbookDistanceSummary = useMemo(() => {
    const complete = dayDistanceSummaries.every((summary) => summary.complete);
    return {
      complete,
      distance: complete ? dayDistanceSummaries.reduce((sum, summary) => sum + (summary.distance ?? 0), 0) : undefined,
    };
  }, [dayDistanceSummaries]);
  const cumulativeDistanceSummary = useMemo(() => {
    const summaries = dayDistanceSummaries.slice(0, selectedDayIndex + 1);
    const complete = summaries.every((summary) => summary.complete);
    return {
      complete,
      distance: complete ? summaries.reduce((sum, summary) => sum + (summary.distance ?? 0), 0) : undefined,
    };
  }, [dayDistanceSummaries, selectedDayIndex]);
  const routeSummary = useMemo(() => {
    if (selectedDay.stops.length < 2) return null;
    const legs = selectedDay.stops.slice(0, -1).map((stop) => displayLegMetrics[stop.id]).filter((metric) => metric?.status === "ready");
    const expectedLegs = Math.max(selectedDay.stops.length - 1, 0);
    if (legs.length !== expectedLegs) return null;
    return {
      distance: legs.reduce((sum, leg) => sum + (leg.distance ?? 0), 0),
      duration: legs.reduce((sum, leg) => sum + (leg.duration ?? 0), 0),
      tolls: legs.every((leg) => typeof leg.tolls === "number") ? legs.reduce((sum, leg) => sum + (leg.tolls ?? 0), 0) : undefined,
    };
  }, [displayLegMetrics, selectedDay.stops]);
  const selectedDayHasRouteError = !readOnly && selectedDay.stops.slice(0, -1).some((stop) => displayLegMetrics[stop.id]?.status === "error");
  const allRoadbookTolls = useMemo(() => {
    const cachedLegs = days.flatMap((day) => day.stops.slice(0, -1).map((stop, index) => sharedSnapshot
      ? sharedSnapshot.legs[stop.id]
      : routeCacheLegs[legCacheKey(stop, day.stops[index + 1])]));
    const complete = cachedLegs.length > 0 && cachedLegs.every((leg) => leg && typeof leg.tolls === "number");
    return {
      complete,
      amount: complete ? cachedLegs.reduce((sum, leg) => sum + (leg?.tolls ?? 0), 0) : undefined,
      cacheVersion: routeCacheVersion,
    };
  }, [days, routeCacheLegs, routeCacheVersion, sharedSnapshot]);
  const cumulativeTollDays = useMemo(() => {
    const cacheRevision = routeCacheVersion;
    return days.slice(0, selectedDayIndex + 1).map((day) => {
      const metrics = day.stops.slice(0, -1).map((stop, index) => {
        if (sharedSnapshot) return sharedSnapshot.legs[stop.id];
        const current = day.id === selectedDay.id ? displayLegMetrics[stop.id] : undefined;
        if (current?.status === "ready") return current;
        return routeCacheLegs[legCacheKey(stop, day.stops[index + 1])];
      });
      const complete = metrics.length > 0 && metrics.every((metric) => metric && typeof metric.tolls === "number");
      return {
        day,
        complete,
        amount: complete ? metrics.reduce((sum, metric) => sum + (metric?.tolls ?? 0), 0) : undefined,
        cacheRevision,
      };
    });
  }, [days, displayLegMetrics, routeCacheLegs, routeCacheVersion, selectedDay, selectedDayIndex, sharedSnapshot]);
  const cumulativeTollsComplete = cumulativeTollDays.every(({ complete }) => complete);
  const cumulativeTollsAmount = cumulativeTollsComplete ? cumulativeTollDays.reduce((sum, item) => sum + (item.amount ?? 0), 0) : undefined;
  const routeDistance = routeSummary ? formatDistance(routeSummary.distance) : selectedDay.stops.length < 2 ? "待规划" : readOnly ? "未记录" : selectedDayHasRouteError ? "正在重试…" : mapReady ? "正在计算" : "待规划";
  const routeDuration = routeSummary ? formatDuration(routeSummary.duration) : selectedDay.stops.length < 2 ? "待规划" : readOnly ? "未记录" : selectedDayHasRouteError ? "正在重试…" : mapReady ? "正在计算" : "待规划";
  const departureStop = selectedDay.stops.find((stop) => stop.kind === "出发");
  const departureTime = departureStop ? extractClock(departureStop.duration) : "09:00";
  const stopArrivalTimes = useMemo(() => {
    let elapsedSeconds = 0;
    let canCalculate = true;
    const arrivalTimes = selectedDay.stops.map(() => "");
    selectedDay.stops.slice(0, -1).forEach((stop, index) => {
      const metric = displayLegMetrics[stop.id];
      if (!canCalculate || metric?.status !== "ready" || typeof metric.duration !== "number") {
        canCalculate = false;
        return;
      }
      elapsedSeconds += metric.duration;
      arrivalTimes[index + 1] = addDurationToClock(departureTime, elapsedSeconds);
    });
    return arrivalTimes;
  }, [departureTime, displayLegMetrics, selectedDay.stops]);
  const selectedDayCalendarDate = new Date(getRoadbookStartDate(starterTrip));
  selectedDayCalendarDate.setDate(selectedDayCalendarDate.getDate() + selectedDayIndex);
  const selectedDayDateValue = formatCalendarDate(selectedDayCalendarDate);

  function flushScheduledRoadbookSave() {
    if (localRoadbookSaveTimerRef.current !== null) window.clearTimeout(localRoadbookSaveTimerRef.current);
    localRoadbookSaveTimerRef.current = null;
    const pending = pendingLocalRoadbooksRef.current;
    pendingLocalRoadbooksRef.current = null;
    if (pending && !saveRoadbooks(pending, true, storageScopeRef.current)) setStorageStatus("unavailable");
  }

  function scheduleLocalRoadbookSave(next: Roadbook[]) {
    pendingLocalRoadbooksRef.current = next;
    if (localRoadbookSaveTimerRef.current !== null) window.clearTimeout(localRoadbookSaveTimerRef.current);
    localRoadbookSaveTimerRef.current = window.setTimeout(() => {
      localRoadbookSaveTimerRef.current = null;
      const pending = pendingLocalRoadbooksRef.current;
      pendingLocalRoadbooksRef.current = null;
      if (pending && !saveRoadbooks(pending, true, storageScopeRef.current)) setStorageStatus("unavailable");
    }, ROADBOOK_LOCAL_SAVE_DELAY);
  }

  function setRoadbooks(updater: Roadbook[] | ((current: Roadbook[]) => Roadbook[])) {
    if (readOnly) return;
    localDraftDirtyRef.current = true;
    localDraftRevisionRef.current += 1;
    setStorageStatus((current) => current === "loading" ? current : "local");
    setRoadbooksState((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      scheduleLocalRoadbookSave(next);
      return next;
    });
  }

  function flushScheduledRouteCacheSave() {
    const handle = routeCacheSaveHandleRef.current;
    if (!handle) return;
    if (handle.kind === "idle") window.cancelIdleCallback(handle.id);
    else window.clearTimeout(handle.id);
    routeCacheSaveHandleRef.current = null;
    saveRouteCache(routeCacheRef.current, storageScopeRef.current);
  }

  function scheduleRouteCacheSave() {
    if (routeCacheSaveHandleRef.current) return;
    const persist = () => {
      routeCacheSaveHandleRef.current = null;
      saveRouteCache(routeCacheRef.current, storageScopeRef.current);
    };
    if (typeof window.requestIdleCallback === "function") {
      routeCacheSaveHandleRef.current = {
        kind: "idle",
        id: window.requestIdleCallback(persist, { timeout: 2500 }),
      };
      return;
    }
    routeCacheSaveHandleRef.current = { kind: "timeout", id: window.setTimeout(persist, ROUTE_CACHE_SAVE_DELAY) };
  }

  useEffect(() => {
    if (hasShareQuery()) {
      queueMicrotask(() => setAuthReady(true));
      return;
    }
    let cancelled = false;
    fetch("/api/auth/me", { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as { user?: AppUser } : null)
      .then((payload) => {
        if (cancelled) return;
        if (payload?.user?.id && payload.user.username) setAuthUser(payload.user);
        setAuthReady(true);
      })
      .catch(() => {
        if (!cancelled) setAuthReady(true);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!authReady) return;
    if (hasShareQuery()) {
      const encodedShare = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get(SHARE_QUERY_KEY) ?? "";
      const inlineShare = decodeShareSnapshot(encodedShare);
      const canPollShare = Boolean(encodedShare && !inlineShare && isCloudShareToken(encodedShare));
      let applied = false;
      let pollAttempts = 0;
      let pollTimer: number | null = null;
      const applySharedSnapshot = (fromShare: SharedSnapshot | null) => {
        if (cancelled || !fromShare) {
          if (!cancelled) {
            setStorageStatus("unavailable");
            setShareLoadError(true);
            if (pollTimer !== null) {
              window.clearInterval(pollTimer);
              pollTimer = null;
            }
          }
          return;
        }
        setSharedSnapshot(fromShare);
        setRoadbooksState([fromShare.roadbook]);
        if (!applied) {
          setActiveRoadbookId(fromShare.roadbook.id);
          setSelectedDayId(fromShare.roadbook.days[0]?.id ?? "");
          applied = true;
        }
        setStorageStatus("local");
        if (isCompleteShareSnapshot(fromShare) && pollTimer !== null) {
          window.clearInterval(pollTimer);
          pollTimer = null;
        }
      };
      void loadShareSnapshot().then(applySharedSnapshot);
      if (canPollShare) {
        pollTimer = window.setInterval(() => {
          pollAttempts += 1;
          void loadShareSnapshot().then((fromShare) => {
            applySharedSnapshot(fromShare);
            if (pollAttempts >= 40 && pollTimer !== null) {
              window.clearInterval(pollTimer);
              pollTimer = null;
            }
          });
        }, 3000);
      }
      return () => {
        cancelled = true;
        if (pollTimer !== null) window.clearInterval(pollTimer);
      };
    }
    const localRoadbooks = loadRoadbooks(storageScope);
    const localDraft = loadRoadbookDraftMeta(storageScope);
    localDraftDirtyRef.current = localDraft.dirty;
    queueMicrotask(() => {
      if (cancelled) return;
      const preferredId = preferredRoadbookId(localRoadbooks, storageScope);
      const preferredRoadbook = localRoadbooks.find((roadbook) => roadbook.id === preferredId) ?? localRoadbooks[0];
      setRoadbooksState(localRoadbooks);
      setActiveRoadbookId(preferredRoadbook.id);
      setSelectedDayId(preferredRoadbook.days[0]?.id ?? "");
    });
    fetchRemoteRoadbooks(storageScope).then(async (remotePayload) => {
      if (cancelled) return;
      if (remotePayload) {
        // 未点击“保存路书”的本地草稿优先于云端快照，避免刷新时丢失编辑。
        if (localDraftDirtyRef.current) {
          setStorageStatus("local");
          return;
        }
        const remoteRoadbooks = remotePayload.roadbooks;
        const preferredId = preferredRoadbookId(remoteRoadbooks, storageScope);
        const preferredRoadbook = remoteRoadbooks.find((roadbook) => roadbook.id === preferredId) ?? remoteRoadbooks[0];
        setRoadbooksState(remoteRoadbooks);
        saveRoadbooks(remoteRoadbooks, false, storageScope);
        localDraftDirtyRef.current = false;
        setActiveRoadbookId(preferredRoadbook.id);
        setSelectedDayId(preferredRoadbook.days[0]?.id ?? "");
        setStorageStatus("remote");
        if (remotePayload.added) void saveRemoteRoadbooks(remoteRoadbooks);
        return;
      }
      if (localDraftDirtyRef.current) {
        setStorageStatus("local");
        return;
      }
      saveRoadbooks(localRoadbooks, false, storageScope);
      const seeded = await saveRemoteRoadbooks(localRoadbooks);
      if (cancelled) return;
      if (seeded) {
        saveRoadbooks(localRoadbooks, false, storageScope);
        localDraftDirtyRef.current = false;
      }
      setStorageStatus(seeded ? "remote" : "unavailable");
    }).catch(() => {
      if (!cancelled) setStorageStatus(localDraftDirtyRef.current ? "local" : "unavailable");
    });
    return () => { cancelled = true; };
  }, [authReady, storageScope]);

  useEffect(() => {
    queueMicrotask(() => {
      setSettings(loadSavedSettings(storageScope));
      const cache = loadRouteCache(storageScope);
      routeCacheRef.current = cache;
      setRouteCacheLegs(cache.legs);
      setRouteCacheVersion((version) => version + 1);
    });
  }, [storageScope]);

  useEffect(() => {
    const handleBeforePrint = () => {
      flushSync(() => setPrintPayload({ roadbook: activeRoadbook, routeCache: routeCacheRef.current }));
    };
    const handleAfterPrint = () => setPrintPayload(null);
    window.addEventListener("beforeprint", handleBeforePrint);
    window.addEventListener("afterprint", handleAfterPrint);
    return () => {
      window.removeEventListener("beforeprint", handleBeforePrint);
      window.removeEventListener("afterprint", handleAfterPrint);
    };
  }, [activeRoadbook]);

  useEffect(() => {
    const handlePageHide = () => {
      flushScheduledRoadbookSave();
      flushScheduledRouteCacheSave();
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      flushScheduledRoadbookSave();
      flushScheduledRouteCacheSave();
      markersRef.current.forEach((marker) => marker.setMap(null));
      routeLineRef.current?.setMap(null);
      mapRef.current?.destroy();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => () => {
    if (searchDebounceRef.current !== null) window.clearTimeout(searchDebounceRef.current);
    searchAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      setServiceAreaLegs({});
      setActiveServiceAreaLeg(null);
    });
  }, [selectedDayRouteDependencyKey]);

  useEffect(() => {
    fetch("/api/amap-config")
      .then((response) => response.ok ? response.json() as Promise<{ jsKey?: string; securityCode?: string; webKey?: string }> : null)
      .then((remote) => {
        if (!remote) return;
        setSettings((current) => ({
          jsKey: remote.jsKey ?? current.jsKey,
          securityCode: remote.securityCode ?? current.securityCode,
          webKey: remote.webKey ?? current.webKey,
        }));
      })
      .catch(() => undefined);
  }, [storageScope]);

  useEffect(() => {
    if (!settings.jsKey || !mapContainer.current) return;
    window._AMapSecurityConfig = { securityJsCode: settings.securityCode };
    const existing = document.querySelector<HTMLScriptElement>('script[data-amap="roadbook"]');
    if (existing) {
      if (window.AMap) queueMicrotask(() => setAmapLoaded(true));
      else existing.addEventListener("load", () => setAmapLoaded(true), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.dataset.amap = "roadbook";
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(settings.jsKey)}&plugin=AMap.PlaceSearch,AMap.Driving`;
    script.async = true;
    script.onload = () => setAmapLoaded(true);
    script.onerror = () => setMapError("高德地图加载失败，请检查 JS API Key 和安全密钥。 ");
    document.head.appendChild(script);
  }, [settings.jsKey, settings.securityCode]);

  useEffect(() => {
    if (storageStatus === "loading" || !amapLoaded || !window.AMap || !mapContainer.current) return;
    const AMap = window.AMap;
    // AMap marker construction and setFitView can be expensive. Moving them to the
    // next frame lets React close the add-place modal and paint the new day first.
    const frame = window.requestAnimationFrame(() => {
      try {
        if (!mapRef.current) {
          mapRef.current = new AMap.Map(mapContainer.current!, {
            zoom: 7,
            center: [102.3, 30.05],
            resizeEnable: true,
          });
          placeSearchRef.current = new AMap.PlaceSearch({ pageSize: 20, pageIndex: 1, city: "全国", citylimit: false, extensions: "all" });
        }
        const map = mapRef.current;
        if (!map) throw new Error("AMap.Map 未创建");
        const nextMarkers = mapMarkerStops.map((stop, index) => new AMap.Marker({
          map,
          position: [stop.lng, stop.lat],
          title: stop.name,
          label: isRoadbookOverview
            ? { content: `<span class="amap-overview-day">${stop.mapLabel ?? `D${index + 1}`}</span>`, direction: "top" }
            : { content: `<span class="amap-label">${index + 1}. ${stop.name}</span>`, direction: "top" },
        }));
        markersRef.current.forEach((marker) => marker.setMap(null));
        markersRef.current = nextMarkers;
        map.setFitView(nextMarkers);
        setMapReady(true);
      } catch (error) {
        setMapReady(false);
        setMapError(`高德地图初始化失败：${error instanceof Error ? error.message : "请检查 JS API Key 和安全密钥"}`);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  // 地点顺序或坐标变化时才重建标记；路线指标更新不应反复重建整张地图。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amapLoaded, isRoadbookOverview, storageStatus, deferredMapMarkerDependencyKey]);

  useEffect(() => {
    // The map instance is created in the marker effect's animation frame. On a
    // refreshed share page this effect can otherwise run first, return, and never
    // draw the snapshot paths. Waiting for mapReady makes the first completed map
    // initialization reliably trigger a route render.
    if (storageStatus === "loading" || !amapLoaded || !mapReady || !window.AMap || !mapRef.current) return;
    const map = mapRef.current;
    const routeKey = routeCacheKey(selectedDay.stops);
    const combinedPath = selectedDay.stops.length >= 2
      ? combineRoutePaths(selectedDay.stops.slice(0, -1).map((stop, index) => routeCacheRef.current.legs[legCacheKey(stop, selectedDay.stops[index + 1])]?.path))
      : [];
    const cachedPath = !readOnly ? combinedPath : mapRoutePaths[0] ?? [];
    if (!readOnly) {
      if (combinedPath.length >= 2) routeCacheRef.current.paths[routeKey] = combinedPath;
      else delete routeCacheRef.current.paths[routeKey];
      scheduleRouteCacheSave();
    }
    const frame = window.requestAnimationFrame(() => {
      routeLineRef.current?.setMap(null);
      routeLineRef.current = null;
      overviewRouteLinesRef.current.forEach((line) => line.setMap(null));
      overviewRouteLinesRef.current = [];
      if (isRoadbookOverview) {
        overviewRouteLinesRef.current = mapRoutePaths.map((path, index) => {
          const line = new window.AMap!.Polyline({ path, strokeColor: index % 2 ? "#5a78df" : "#3559d9", strokeWeight: 5, strokeOpacity: 0.78, lineJoin: "round" });
          line.setMap(map);
          return line;
        });
        if (overviewRouteLinesRef.current.length) map.setFitView([...markersRef.current, ...overviewRouteLinesRef.current]);
      } else if (cachedPath.length >= 2) {
        routeLineRef.current = new window.AMap!.Polyline({ path: cachedPath, strokeColor: "#dc6b3f", strokeWeight: 5, strokeOpacity: 0.82, lineJoin: "round" });
        routeLineRef.current.setMap(map);
        map.setFitView([...markersRef.current, routeLineRef.current]);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amapLoaded, isRoadbookOverview, mapReady, readOnly, deferredRoutePlanDependencyKey, deferredSelectedDayRouteDependencyKey, mapRoutePaths, selectedRouteCacheVersion, storageStatus]);

  useEffect(() => {
    if (readOnly || hasShareQuery() || storageStatus === "loading") {
      queueMicrotask(() => setLegMetrics({}));
      return;
    }
    let cancelled = false;
    let retryTimer: number | null = null;
    const now = Date.now();
    const initialMetrics = Object.fromEntries(selectedDay.stops.slice(0, -1).map((stop, index) => {
      const destination = selectedDay.stops[index + 1];
      const key = legCacheKey(stop, destination);
      const cached = routeCacheRef.current.legs[key];
      const fresh = isFreshCachedLeg(cached, now);
      const retryAt = routeCacheRef.current.errors[key];
      return [stop.id, isRoutePlaceholder(stop) || isRoutePlaceholder(destination) ? { status: "error" as const } : fresh ? { status: "ready" as const, ...displayCachedLeg(cached) } : retryAt > now ? { status: "error" as const } : { status: "loading" as const }];
    }));
    setLegMetrics(initialMetrics);

    const selectedLegs = selectedDay.stops.slice(0, -1).map((stop, index) => ({
      stop,
      destination: selectedDay.stops[index + 1],
      key: legCacheKey(stop, selectedDay.stops[index + 1]),
    })).filter(({ stop, destination }) => !isRoutePlaceholder(stop) && !isRoutePlaceholder(destination));
    const scheduleNextRetry = () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      const retryAt = Math.min(...selectedLegs.map(({ key }) => routeCacheRef.current.errors[key] ?? Infinity));
      if (!Number.isFinite(retryAt)) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (!cancelled) setRouteRetryVersion((version) => version + 1);
      }, Math.max(0, retryAt - Date.now()));
    };
    const missingLegs = selectedLegs.filter(({ key }) => {
      const cached = routeCacheRef.current.legs[key];
      return !isFreshCachedLeg(cached, now, true) && (routeCacheRef.current.errors[key] ?? 0) <= now;
    });
    scheduleNextRetry();
    if (missingLegs.length) {
      void mapWithConcurrency(missingLegs, ROUTE_REQUEST_CONCURRENCY, async ({ stop, destination, key }) => ({
        stopId: stop.id,
        key,
        metric: await requestRouteLeg(stop, destination, key, pendingLegsRef.current, true),
      })).then((entries) => {
        if (cancelled) return;
      entries.forEach(({ key, metric }) => {
        if (metric) {
          routeCacheRef.current.legs[key] = metric;
          delete routeCacheRef.current.errors[key];
        } else {
          routeCacheRef.current.errors[key] = Date.now() + ROUTE_FAILURE_RETRY_TTL;
        }
      });
      if (entries.length) {
          scheduleRouteCacheSave();
          startTransition(() => {
            setRouteCacheLegs({ ...routeCacheRef.current.legs });
            setRouteCacheVersion((version) => version + 1);
            setSelectedRouteCacheVersion((version) => version + 1);
          });
      }
      scheduleNextRetry();
        startTransition(() => setLegMetrics((current) => ({ ...current, ...Object.fromEntries(entries.map(({ stopId, key }) => {
        const cached = routeCacheRef.current.legs[key];
        return [stopId, isFreshCachedLeg(cached) ? { status: "ready" as const, ...displayCachedLeg(cached) } : { status: "error" as const }];
        })) })));
      });
    }
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  // 当前天单独计算，不再被整本路书的预热队列拖住。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amapLoaded, readOnly, deferredSelectedDayRouteDependencyKey, routeRetryVersion, storageStatus]);

  useEffect(() => {
    if (readOnly || hasShareQuery() || storageStatus === "loading") return;
    let cancelled = false;
    let startTimer: number | null = null;
    let retryTimer: number | null = null;
    const backgroundLegs = days.flatMap((day) => day.id === selectedDay.id ? [] : day.stops.slice(0, -1).map((stop, index) => ({
      stop,
      destination: day.stops[index + 1],
      key: legCacheKey(stop, day.stops[index + 1]),
    })).filter(({ stop, destination }) => !isRoutePlaceholder(stop) && !isRoutePlaceholder(destination)));

    const warmRoutes = async () => {
      let updatesSinceRender = 0;
      for (const { stop, destination, key } of backgroundLegs) {
        if (cancelled) return;
        const now = Date.now();
        if (isFreshCachedLeg(routeCacheRef.current.legs[key], now) || (routeCacheRef.current.errors[key] ?? 0) > now) continue;
        const metric = await requestRouteLeg(stop, destination, key, pendingLegsRef.current, false);
        if (cancelled) return;
        if (metric) {
          routeCacheRef.current.legs[key] = metric;
          delete routeCacheRef.current.errors[key];
        } else {
          routeCacheRef.current.errors[key] = Date.now() + ROUTE_FAILURE_RETRY_TTL;
        }
        updatesSinceRender += 1;
        scheduleRouteCacheSave();
        if (updatesSinceRender >= 4) {
          updatesSinceRender = 0;
          startTransition(() => {
            setRouteCacheLegs({ ...routeCacheRef.current.legs });
            setRouteCacheVersion((version) => version + 1);
          });
        }
      }
      if (cancelled) return;
      if (updatesSinceRender) startTransition(() => {
        setRouteCacheLegs({ ...routeCacheRef.current.legs });
        setRouteCacheVersion((version) => version + 1);
      });
      const retryAt = Math.min(...backgroundLegs.map(({ key }) => routeCacheRef.current.errors[key] ?? Infinity));
      if (Number.isFinite(retryAt)) {
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          if (!cancelled) setRouteRetryVersion((version) => version + 1);
        }, Math.max(0, retryAt - Date.now()));
      }
    };

    // 先留出几秒给用户完成添加、切换等交互，再串行预热其他天的基础指标。
    startTimer = window.setTimeout(() => {
      startTimer = null;
      void warmRoutes();
    }, BACKGROUND_ROUTE_DELAY);
    return () => {
      cancelled = true;
      if (startTimer !== null) window.clearTimeout(startTimer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amapLoaded, readOnly, deferredRoutePlanDependencyKey, selectedDay.id, routeRetryVersion, storageStatus]);

  function updateEditorWidth(clientX: number) {
    const workspace = workspaceRef.current;
    const sidebar = workspace?.querySelector<HTMLElement>(".sidebar");
    if (!workspace || !sidebar) return;
    const workspaceRect = workspace.getBoundingClientRect();
    const sidebarWidth = sidebar.getBoundingClientRect().width;
    const contentWidth = workspaceRect.width - sidebarWidth - 8;
    if (contentWidth <= 0) return;
    const next = ((clientX - workspaceRect.left - sidebarWidth) / contentWidth) * 100;
    const min = Math.max(32, (410 / contentWidth) * 100);
    const max = Math.min(68, 100 - (420 / contentWidth) * 100);
    setEditorWidth(Math.min(max, Math.max(min, next)));
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    updateEditorWidth(event.clientX);
  }

  function finishResize(event: ReactPointerEvent<HTMLDivElement>) {
    setIsResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function flash(message: string) {
    setShowToast(message);
    window.setTimeout(() => setShowToast(""), 2200);
  }

  function shareUrlForToken(token: string) {
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set(SHARE_QUERY_KEY, token);
    url.hash = "";
    return url.toString();
  }

  function rememberShareLink(link: ShareLink) {
    const next = [link, ...loadLocalShareLinks(storageScope).filter((item) => item.token !== link.token && item.url !== link.url)];
    saveLocalShareLinks(next, storageScope);
    setShareLinks(next);
  }

  async function refreshShareLinks() {
    setIsLoadingShareLinks(true);
    const localLinks = loadLocalShareLinks(storageScope);
    setShareLinks(localLinks);
    try {
      const response = await fetch("/api/shares", { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json() as { links?: Array<Omit<ShareLink, "url" | "storage"> & { token: string }> };
      const cloudLinks: ShareLink[] = (payload.links ?? []).map((link) => ({ ...link, url: shareUrlForToken(link.token), storage: "cloud" }));
      const browserLinks = localLinks.filter((link) => link.storage === "browser");
      const next = [...cloudLinks, ...browserLinks.filter((link) => !cloudLinks.some((cloudLink) => cloudLink.token === link.token))];
      saveLocalShareLinks(next, storageScope);
      setShareLinks(next);
    } catch {
      // The local cache still makes link management useful during local development without KV.
    } finally {
      setIsLoadingShareLinks(false);
    }
  }

  function openShareManager() {
    setShowShareManager(true);
    void refreshShareLinks();
  }

  async function copyShareLink(link: ShareLink) {
    try {
      await navigator.clipboard.writeText(link.url);
      flash("分享链接已复制");
    } catch {
      flash("复制失败，请检查浏览器剪贴板权限");
    }
  }

  async function revokeShareLink(link: ShareLink) {
    if (link.storage === "browser" || !link.token) {
      const next = loadLocalShareLinks(storageScope).filter((item) => item.url !== link.url);
      saveLocalShareLinks(next, storageScope);
      setShareLinks(next);
      flash("已从当前设备移除链接记录");
      return;
    }
    try {
      const response = await fetch(`/api/shares?token=${encodeURIComponent(link.token)}`, { method: "DELETE", cache: "no-store" });
      if (!response.ok) throw new Error("revoke-failed");
      const next = loadLocalShareLinks(storageScope).filter((item) => item.token !== link.token);
      saveLocalShareLinks(next, storageScope);
      setShareLinks(next);
      flash("分享链接已失效");
    } catch {
      flash("链接失效失败，请稍后重试");
    }
  }

  function shareLinkKey(link: ShareLink) {
    return link.token ?? link.url;
  }

  async function relinkShareToRoadbook(link: ShareLink, snapshot: SharedSnapshot, roadbook: Roadbook) {
    if (link.storage !== "cloud" || !link.token) return false;
    const response = await fetch(`/api/shares?token=${encodeURIComponent(link.token)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        ...snapshot,
        roadbook: { ...snapshot.roadbook, id: roadbook.id, title: roadbook.title },
      } satisfies SharedSnapshot),
      cache: "no-store",
    });
    return response.ok;
  }

  function openImportedRoadbook(roadbook: Roadbook) {
    setActiveRoadbookId(roadbook.id);
    rememberActiveRoadbook(roadbook.id, storageScope);
    setSelectedDayId(roadbook.days[0]?.id ?? "");
    setShowShareManager(false);
    setShowLibrary(false);
  }

  async function importShareSnapshots(links: ShareLink[], successMessage: (count: number) => string) {
    if (importingShareKey || readOnly || !links.length) return;
    setImportingShareKey(links.length === 1 ? shareLinkKey(links[0]) : "all");
    try {
      const imported: Roadbook[] = [];
      const nextShareLinks = shareLinks.map((item) => ({ ...item }));
      for (const link of links) {
        const snapshot = await fetchShareSnapshot(link);
        if (!snapshot?.roadbook?.days.length) {
          flash(`无法读取「${link.roadbookTitle}」的分享快照`);
          continue;
        }
        const roadbook = makeImportedRoadbook(snapshot.roadbook, link.roadbookTitle || snapshot.roadbook.title);
        cacheImportedShareSnapshot(roadbook, snapshot, routeCacheRef.current);
        imported.push(roadbook);
        if (await relinkShareToRoadbook(link, snapshot, roadbook)) {
          const index = nextShareLinks.findIndex((item) => shareLinkKey(item) === shareLinkKey(link));
          if (index >= 0) nextShareLinks[index] = { ...nextShareLinks[index], roadbookId: roadbook.id, roadbookTitle: roadbook.title };
        }
      }
      if (!imported.length) {
        flash("没有成功导入的分享快照");
        return;
      }
      saveRouteCache(routeCacheRef.current, storageScope);
      setRouteCacheLegs({ ...routeCacheRef.current.legs });
      setRouteCacheVersion((version) => version + 1);
      saveLocalShareLinks(nextShareLinks, storageScope);
      setShareLinks(nextShareLinks);
      const next = [...imported, ...roadbooks];
      openImportedRoadbook(imported[0]);
      await commitRoadbooks(next, successMessage(imported.length));
    } catch {
      flash("导入失败，请稍后重试");
    } finally {
      setImportingShareKey(null);
    }
  }

  function importShareAsEditable(link: ShareLink) {
    void importShareSnapshots([link], () => `「${link.roadbookTitle}」已导入，可以继续编辑`);
  }

  function importAllSharesAsEditable() {
    const targets = shareLinks.filter((link) => !shareHasIndependentSource(link, shareLinks, roadbooks));
    if (!targets.length) {
      flash("这些分享都已经有独立的可编辑路书");
      return;
    }
    void importShareSnapshots(targets, (count) => `已导入 ${count} 条分享为可编辑路书`);
  }

  function openShareEditableSource(link: ShareLink) {
    const target = roadbooks.find((roadbook) => roadbook.id === link.roadbookId);
    if (!target) {
      flash("当前库中没有对应的可编辑路书");
      return;
    }
    openRoadbook(target.id);
  }

  function updateActiveDays(updater: (days: DayPlan[]) => DayPlan[]) {
    if (readOnly) return;
    setRoadbooks((current) => current.map((roadbook) => roadbook.id === activeRoadbookId ? { ...roadbook, days: updater(roadbook.days) } : roadbook));
  }

  function updateActiveDaysInTransition(updater: (days: DayPlan[]) => DayPlan[]) {
    if (readOnly) return;
    startTransition(() => {
      setRoadbooks((current) => current.map((roadbook) => roadbook.id === activeRoadbookId ? { ...roadbook, days: updater(roadbook.days) } : roadbook));
    });
  }

  function updateSelectedDay(updater: (day: DayPlan) => DayPlan) {
    updateActiveDays((current) => current.map((day) => (day.id === selectedDayId ? updater(day) : day)));
  }

  function updateSelectedDayInTransition(updater: (day: DayPlan) => DayPlan) {
    updateActiveDaysInTransition((current) => current.map((day) => (day.id === selectedDayId ? updater(day) : day)));
  }

  function updateStop(stopId: string, updater: (stop: Stop) => Stop) {
    updateSelectedDay((day) => ({ ...day, stops: day.stops.map((stop) => stop.id === stopId ? updater(stop) : stop) }));
  }

  function startNoteEdit(stop: Stop) {
    setEditingNoteStopId(stop.id);
    setNoteDraft(stop.note ?? "");
  }

  function cancelNoteEdit() {
    setEditingNoteStopId(null);
    setNoteDraft("");
  }

  function saveStopNote(stopId: string) {
    const note = noteDraft.trim();
    updateStop(stopId, (stop) => note ? { ...stop, note } : { ...stop, note: undefined });
    cancelNoteEdit();
    flash(note ? "备注已更新，点击“保存路书”后同步" : "备注已清除，点击“保存路书”后同步");
  }

  function updateDepartureTime(stopId: string, time: string) {
    updateStop(stopId, (stop) => ({ ...stop, duration: `${time} 出发` }));
  }

  function updateRoadbookStartDate(value: string) {
    const startDate = parseCalendarDate(value);
    if (!startDate || readOnly) return;
    setRoadbooks((current) => current.map((roadbook) => {
      if (roadbook.id !== activeRoadbookId) return roadbook;
      return {
        ...roadbook,
        startDate: formatCalendarDate(startDate),
        days: roadbook.days.map((day, index) => {
          const date = new Date(startDate);
          date.setDate(startDate.getDate() + index);
          return { ...day, date: formatMonthDay(date) };
        }),
      };
    }));
  }

  function updateSelectedDayDate(value: string) {
    const selectedDate = parseCalendarDate(value);
    if (!selectedDate || readOnly) return;
    const startDate = new Date(selectedDate);
    startDate.setDate(selectedDate.getDate() - selectedDayIndex);
    updateRoadbookStartDate(formatCalendarDate(startDate));
  }

  function insertDay(afterId = selectedDayId) {
    const index = days.findIndex((day) => day.id === afterId);
    const inserted = makeInsertedDay();
    const insertAt = index >= 0 ? index + 1 : days.length;
    startTransition(() => {
      updateActiveDays((current) => normalizeDayDates([...current.slice(0, insertAt), inserted, ...current.slice(insertAt)]));
      setSelectedDayId(inserted.id);
    });
    flash("已插入新的一天");
  }

  function removeDay(id: string) {
    if (days.length === 1) return flash("至少保留一天行程");
    const next = days.filter((day) => day.id !== id);
    updateActiveDays(() => normalizeDayDates(next));
    if (id === selectedDayId) setSelectedDayId(next[0].id);
    flash("已删除这一天");
  }

  function moveDay(id: string, direction: -1 | 1) {
    updateActiveDaysInTransition((current) => {
      const index = current.findIndex((day) => day.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return normalizeDayDates(next);
    });
    flash(direction < 0 ? "已提前这一天" : "已顺延这一天");
  }

  function moveStop(stopId: string, direction: -1 | 1) {
    updateSelectedDayInTransition((day) => {
      const index = day.stops.findIndex((stop) => stop.id === stopId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= day.stops.length) return day;
      const stops = [...day.stops];
      [stops[index], stops[nextIndex]] = [stops[nextIndex], stops[index]];
      return { ...day, stops };
    });
  }

  function insertServiceArea(afterStopId: string, area: RouteServiceArea) {
    setActiveServiceAreaLeg(null);
    startTransition(() => {
      updateSelectedDay((day) => {
        const index = day.stops.findIndex((stop) => stop.id === afterStopId);
        if (index < 0) return day;
        const inserted: Stop = {
          id: uid("stop"),
          name: area.name,
          area: area.address,
          kind: "途经",
          lat: area.lat,
          lng: area.lng,
          duration: "服务区停靠",
        };
        return { ...day, stops: [...day.stops.slice(0, index + 1), inserted, ...day.stops.slice(index + 1)] };
      });
    });
    flash(`已把「${area.name}」加入两个地点之间`);
  }

  function loadLegServiceAreas(from: Stop, to: Stop) {
    const key = legCacheKey(from, to);
    const current = serviceAreaLegs[key];
    if (current?.status === "loading" || current?.status === "ready") return pendingServiceAreasRef.current.get(key) ?? Promise.resolve();
    const existing = pendingServiceAreasRef.current.get(key);
    if (existing) return existing;
    setServiceAreaLegs((states) => ({ ...states, [key]: { status: "loading" } }));
    const task = (async () => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 25_000);
      try {
        const params = new URLSearchParams({
          origin: `${from.lng.toFixed(6)},${from.lat.toFixed(6)}`,
          destination: `${to.lng.toFixed(6)},${to.lat.toFixed(6)}`,
        });
        const response = await fetch(`/api/amap/service-areas?${params.toString()}`, { headers: { Accept: "application/json" }, signal: controller.signal, cache: "force-cache" });
        if (!response.ok) throw new Error("service-area-search-failed");
        const payload = await response.json() as ServiceAreaPayload;
        if (payload.status !== "1") throw new Error(payload.info || "service-area-search-failed");
        setServiceAreaLegs((states) => ({ ...states, [key]: { status: "ready", highway: Boolean(payload.highway), items: payload.serviceAreas ?? [] } }));
      } catch {
        setServiceAreaLegs((states) => ({ ...states, [key]: { status: "error" } }));
      } finally {
        window.clearTimeout(timeout);
        pendingServiceAreasRef.current.delete(key);
      }
    })();
    pendingServiceAreasRef.current.set(key, task);
    return task;
  }

  function setStopAsDeparture(stopId: string) {
    updateSelectedDay((day) => {
      const selected = day.stops.find((stop) => stop.id === stopId);
      if (!selected || selected.kind === "出发") return day;
      const previousDeparture = day.stops.find((stop) => stop.kind === "出发");
      const departureDuration = previousDeparture?.duration ?? "09:00 出发";
      const stops = day.stops
        .filter((stop) => stop.id !== stopId)
        .map((stop) => stop.id === previousDeparture?.id ? { ...stop, kind: "途经" as const, duration: "顺路停靠" } : stop);
      return { ...day, stops: [{ ...selected, kind: "出发", duration: departureDuration }, ...stops] };
    });
    flash("已将该地点设为出发点");
  }

  function removeStop(stopId: string) {
    updateSelectedDay((day) => {
      const stops = day.stops.filter((stop) => stop.id !== stopId);
      if (stops.length > 0 && !stops.some((stop) => stop.kind === "出发")) {
        return { ...day, stops: [{ ...stops[0], kind: "出发", duration: "09:00 出发" }, ...stops.slice(1)] };
      }
      return { ...day, stops };
    });
    flash("已移除地点");
  }

  function openPlaceSearch(stopId?: string) {
    if (readOnly) return;
    const target = stopId ? selectedDay.stops.find((stop) => stop.id === stopId) : undefined;
    setEditingStopId(target?.id ?? null);
    setQuery(target?.name ?? "");
    setSearchResults([]);
    setShowAddPlace(true);
    if (target) void searchPlaces(target.name);
  }

  function closePlaceSearch() {
    setShowAddPlace(false);
    setEditingStopId(null);
    setQuery("");
    setSearchResults([]);
  }

  async function searchPlaces(rawKeyword = query) {
    if (readOnly) return;
    const keyword = rawKeyword.trim();
    if (!keyword) return;
    const contextStop = searchContextStop(selectedDay);
    const cityHint = searchCityHint(contextStop);
    const locationHint = contextStop ? `${contextStop.lng.toFixed(6)},${contextStop.lat.toFixed(6)}` : "";
    const searchKey = `${keyword.replace(/\s+/g, " ").toLocaleLowerCase()}|${cityHint.toLocaleLowerCase()}|${locationHint}`;
    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    searchAbortRef.current?.abort();
    const cachedSearch = searchCacheRef.current.get(searchKey);
    if (cachedSearch && Date.now() - cachedSearch.cachedAt < SEARCH_CACHE_TTL) {
      setSearchResults(cachedSearch.results);
      return;
    }
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearchResults([]);
    setMapError("");

    // 优先走服务端 Web 服务搜索：结果更多、信息更完整，且不会把 Web 服务 Key 暴露到浏览器。
    try {
      const params = new URLSearchParams({ keywords: keyword });
      if (cityHint) params.set("city", cityHint);
      if (locationHint) params.set("location", locationHint);
      const response = await fetch(`/api/amap/search?${params.toString()}`, { headers: { Accept: "application/json" }, signal: controller.signal, cache: "no-store" });
      if (requestId !== searchRequestIdRef.current) return;
      if (response.ok) {
        const payload = await response.json() as AMapWebSearchPayload;
        const webResults = (payload.pois ?? []).reduce<SearchResult[]>((results, poi, index) => {
          const location = normalizeSearchLocation(poi.location);
          const address = poi.address || [poi.pname, poi.cityname, poi.adname].filter(Boolean).join(" · ") || "高德地点";
          const distance = typeof poi.distance === "number" ? poi.distance : typeof poi.distance === "string" ? Number(poi.distance) : undefined;
          if (location) results.push({ id: poi.id ?? `web-poi-${index}`, name: poi.name ?? keyword, address, location, type: poi.type ?? "地点", distance: typeof distance === "number" && Number.isFinite(distance) ? distance : undefined });
          return results;
        }, []);
        if (webResults.length) {
          searchCacheRef.current.set(searchKey, { results: webResults, cachedAt: Date.now() });
          setSearchResults(webResults);
          return;
        }
        // Web 服务没有可用坐标时继续走浏览器 JS API，而不是把空结果缓存下来。
      }
    } catch {
      // Web 服务 Key 未配置或网络异常时，继续使用 JS API 搜索。
    }

    if (requestId !== searchRequestIdRef.current) return;
    if (!placeSearchRef.current) {
      setSearchResults([{ id: "demo-1", name: keyword, address: "示例地点 · 配置高德 Key 后可搜索真实 POI", type: "搜索结果" }]);
      return;
    }
    placeSearchRef.current.setCity?.(cityHint || "全国");
    placeSearchRef.current.setCityLimit?.(false);
    placeSearchRef.current.search(keyword, (status, result) => {
      if (requestId !== searchRequestIdRef.current) return;
      if (status !== "complete" || !result.poiList?.pois?.length) {
        setSearchResults([]);
        setMapError("没有找到这个地点，可以换个关键词试试。");
        return;
      }
      const results = result.poiList.pois.map((poi, index) => ({
        id: poi.id ?? `poi-${index}`,
        name: poi.name,
        address: poi.address ?? "高德地点",
        location: normalizeSearchLocation(poi.location),
        type: poi.type ?? "地点",
      }));
      searchCacheRef.current.set(searchKey, { results, cachedAt: Date.now() });
      setSearchResults(results);
    });
  }

  function schedulePlaceSearch(value: string) {
    if (searchDebounceRef.current !== null) window.clearTimeout(searchDebounceRef.current);
    if (!value.trim()) {
      searchRequestIdRef.current += 1;
      searchAbortRef.current?.abort();
      setSearchResults([]);
      return;
    }
    searchDebounceRef.current = window.setTimeout(() => {
      searchDebounceRef.current = null;
      void searchPlaces(value);
    }, 400);
  }

  function searchPlacesImmediately(value = query) {
    if (searchDebounceRef.current !== null) {
      window.clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
    void searchPlaces(value);
  }

  function addSearchResult(result: SearchResult) {
    if (readOnly) return;
    const editingStop = editingStopId ? selectedDay.stops.find((stop) => stop.id === editingStopId) : undefined;
    const fallback = editingStop ?? selectedDay.stops.at(-1);
    const isFirstStop = !editingStop && selectedDay.stops.length === 0;
    const stop: Stop = {
      id: editingStop?.id ?? uid("stop"),
      name: result.name,
      area: result.address || "已添加地点",
      kind: editingStop?.kind ?? (isFirstStop ? "出发" : "景点"),
      lat: result.location?.lat ?? fallback?.lat ?? 30.657,
      lng: result.location?.lng ?? fallback?.lng ?? 104.066,
      duration: editingStop?.duration ?? (isFirstStop ? "09:00 出发" : "待安排"),
      ...(editingStop?.note ? { note: editingStop.note } : {}),
    };
    const replacingId = editingStop?.id;
    closePlaceSearch();
    startTransition(() => {
      updateSelectedDay((day) => replacingId
        ? { ...day, stops: day.stops.map((item) => item.id === replacingId ? stop : item) }
        : { ...day, stops: [...day.stops, stop] });
    });
    flash(replacingId ? `已把地点修改为「${result.name}」` : `已把「${result.name}」加入第 ${days.findIndex((day) => day.id === selectedDayId) + 1} 天`);
  }

  async function commitRoadbooks(next: Roadbook[], successMessage: string, afterRemoteSave?: () => Promise<string | null>) {
    const saveRevision = localDraftRevisionRef.current;
    if (localRoadbookSaveTimerRef.current !== null) window.clearTimeout(localRoadbookSaveTimerRef.current);
    localRoadbookSaveTimerRef.current = null;
    pendingLocalRoadbooksRef.current = null;
    localDraftDirtyRef.current = true;
    setRoadbooksState(next);
    saveRoadbooks(next, true, storageScope);
    setStorageStatus("saving");
    try {
      const saved = await saveRemoteRoadbooks(next);
      if (!saved) {
        setStorageStatus("unavailable");
        flash("云端保存失败，暂时保存在当前设备");
        return;
      }
      if (localDraftRevisionRef.current === saveRevision) {
        saveRoadbooks(next, false, storageScope);
        localDraftDirtyRef.current = false;
        setStorageStatus("remote");
      } else {
        setStorageStatus("local");
      }
      let message = successMessage;
      if (afterRemoteSave) {
        try {
          message = await afterRemoteSave() ?? message;
        } catch {
          message = "路书已保存，但分享链接同步失败";
        }
      }
      flash(message);
    } catch {
      setStorageStatus("unavailable");
      flash("云端保存失败，暂时保存在当前设备");
    }
  }

  function saveTrip() {
    if (readOnly) return;
    const next = roadbooks.map((roadbook) => roadbook.id === activeRoadbookId ? { ...roadbook, updated: "刚刚保存" } : roadbook);
    const updatedRoadbook = next.find((roadbook) => roadbook.id === activeRoadbookId);
    void commitRoadbooks(next, "路书已保存到云端", updatedRoadbook ? () => syncCloudShareSnapshots(updatedRoadbook) : undefined);
  }

  function openRoadbook(id: string) {
    const target = roadbooks.find((roadbook) => roadbook.id === id);
    if (!target) return;
    setActiveRoadbookId(id);
    rememberActiveRoadbook(id, storageScope);
    setSelectedDayId(target.days[0]?.id ?? "");
    setShowLibrary(false);
    flash(`已切换到「${target.title}」`);
  }

  function createRoadbook(title: string, description: string) {
    const created = makeNewRoadbook(title, description);
    const next = [created, ...roadbooks];
    setActiveRoadbookId(created.id);
    rememberActiveRoadbook(created.id, storageScope);
    setSelectedDayId(created.days[0].id);
    setShowLibrary(false);
    void commitRoadbooks(next, "新路书已创建并保存到云端");
  }

  function deleteRoadbook(id: string) {
    const target = roadbooks.find((roadbook) => roadbook.id === id);
    if (!target) return;
    if (roadbooks.length === 1) {
      flash("至少保留一条路书");
      return;
    }
    if (!window.confirm(`确定删除「${target.title}」吗？此操作会删除这条路书的所有行程安排。`)) return;
    const next = roadbooks.filter((roadbook) => roadbook.id !== id);
    if (id === activeRoadbookId) {
      const replacement = next[0];
      setActiveRoadbookId(replacement.id);
      rememberActiveRoadbook(replacement.id, storageScope);
      setSelectedDayId(replacement.days[0]?.id ?? "");
    }
    void commitRoadbooks(next, `「${target.title}」已删除并同步到云端`);
  }

  function copyRoadbook(title: string) {
    if (readOnly) return;
    const copied = makeCopiedRoadbook(activeRoadbook, title);
    // 副本的坐标与原路书一致，提前把已有轨迹写回本地缓存；后续路线计算会
    // 命中相同的坐标 key，不会为复制操作额外消耗高德 API。
    cacheRoadbookPaths(copied, routeCacheRef.current);
    saveRouteCache(routeCacheRef.current, storageScope);
    const next = [copied, ...roadbooks];
    setActiveRoadbookId(copied.id);
    rememberActiveRoadbook(copied.id, storageScope);
    setSelectedDayId(copied.days[0]?.id ?? "");
    setShowCopyRoadbook(false);
    void commitRoadbooks(next, "路书副本已创建并保存到云端");
  }

  function exportPdf() {
    flushSync(() => setPrintPayload({ roadbook: activeRoadbook, routeCache: routeCacheRef.current }));
    window.requestAnimationFrame(() => window.print());
  }

  function buildSharePaths(roadbook: Roadbook) {
    return Object.fromEntries(roadbook.days.flatMap((day) => {
      if (day.stops.length < 2) return [];
      const path = combineRoutePaths(day.stops.slice(0, -1).map((stop, index) => routeCacheRef.current.legs[legCacheKey(stop, day.stops[index + 1])]?.path));
      // 总览中不能把未计算的路线伪装成直线：这会让跨省行程看起来像断裂或走错路。
      // 分享前会优先补齐轨迹；仍失败的天数只显示地点和缺失状态。
      if (path.length < 2) return [];
      const key = routeCacheKey(day.stops);
      return [[key, sampleRoutePath(path)]];
    }));
  }

  async function prepareShareData(roadbook: Roadbook) {
    const allLegs = roadbook.days.flatMap((day) => day.stops.slice(0, -1).map((stop, index) => ({
      day,
      stop,
      destination: day.stops[index + 1],
      key: legCacheKey(stop, day.stops[index + 1]),
    })));
    const now = Date.now();
    const missingLegs = allLegs.filter(({ key }) => {
      const cached = routeCacheRef.current.legs[key];
      return !isFreshCachedLeg(cached, now, true);
    });
    const entries = await mapWithConcurrency(missingLegs, ROUTE_REQUEST_CONCURRENCY, async ({ stop, destination, key }) => ({
      key,
      metric: await requestRouteLeg(stop, destination, key, pendingLegsRef.current, true),
    }));
    entries.forEach(({ key, metric }) => {
      if (metric) {
        routeCacheRef.current.legs[key] = metric;
        delete routeCacheRef.current.errors[key];
      } else {
        routeCacheRef.current.errors[key] = Date.now() + ROUTE_FAILURE_RETRY_TTL;
      }
    });
    if (entries.length) {
      saveRouteCache(routeCacheRef.current, storageScope);
      setRouteCacheLegs({ ...routeCacheRef.current.legs });
      setRouteCacheVersion((version) => version + 1);
    }
    const paths = buildSharePaths(roadbook);
    const incompleteLegs = allLegs.filter(({ key }) => !isFreshCachedLeg(routeCacheRef.current.legs[key], Date.now(), true));
    return {
      complete: incompleteLegs.length === 0,
      missingCount: incompleteLegs.length,
      paths,
    };
  }

  function buildShareSnapshot(roadbook: Roadbook) {
    const legs = Object.fromEntries(roadbook.days.flatMap((day) => day.stops.slice(0, -1).map((stop, index) => {
      const metric = routeCacheRef.current.legs[legCacheKey(stop, day.stops[index + 1])];
      return isFreshCachedLeg(metric) ? [[stop.id, { distance: metric.distance, duration: metric.duration, tolls: typeof metric.tolls === "number" ? metric.tolls : undefined }]] : [];
    })));
    const missingCount = roadbook.days.reduce((count, day) => count + day.stops.slice(0, -1).filter((stop, index) => !isFreshCachedLeg(routeCacheRef.current.legs[legCacheKey(stop, day.stops[index + 1])])).length, 0);
    return {
      snapshot: {
        version: 1 as const,
        roadbook,
        legs,
        paths: buildSharePaths(roadbook),
        createdAt: new Date().toISOString(),
      } satisfies SharedSnapshot,
      missingCount,
    };
  }

  async function syncCloudShareSnapshots(roadbook: Roadbook) {
    const listResponse = await fetch("/api/shares", { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!listResponse.ok) return null;
    const payload = await listResponse.json() as { links?: Array<{ token?: string; roadbookId?: string; expiresAt?: string; permanent?: boolean }> };
    const now = Date.now();
    const links = (payload.links ?? []).filter((link): link is { token: string; roadbookId?: string; expiresAt?: string } => Boolean(
      link.token
      && link.roadbookId === roadbook.id
      && (link.permanent || !link.expiresAt || new Date(link.expiresAt).getTime() > now),
    ));
    if (!links.length) return null;

    const snapshot = buildShareSnapshot(roadbook).snapshot;
    const results = await mapWithConcurrency(links, ROUTE_REQUEST_CONCURRENCY, async (link) => {
      try {
        const response = await fetch(`/api/shares?token=${encodeURIComponent(link.token)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(snapshot),
          cache: "no-store",
        });
        return response.ok;
      } catch {
        return false;
      }
    });
    const updatedCount = results.filter(Boolean).length;
    if (updatedCount !== links.length) return `路书已保存，${links.length - updatedCount} 个分享链接同步失败`;
    return `路书已保存，并同步 ${updatedCount} 个分享链接`;
  }

  async function shareRoadbook() {
    if (readOnly) {
      try {
        await navigator.clipboard.writeText(window.location.href);
        flash("分享链接已复制，可直接粘贴发送");
      } catch {
        flash("复制失败，请检查浏览器剪贴板权限");
      }
      return;
    }
    if (isPreparingShare) return;
    setIsPreparingShare(true);
    try {
      // 先复用本地缓存，仅为缺少轨迹的路段补拉高德路径，保证分享页不会退化为地点直连线。
      const preparation = await prepareShareData(activeRoadbook);
      const { snapshot } = buildShareSnapshot(activeRoadbook);
      const missingCount = preparation.missingCount;
      let shareUrl = "";
      let shareToken = "";
      try {
        const response = await fetch("/api/shares", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(snapshot),
        });
        if (response.ok) {
          const payload = await response.json() as { token?: string };
          if (payload.token) {
            shareToken = payload.token;
            const url = new URL(window.location.href);
            url.search = "";
            url.searchParams.set(SHARE_QUERY_KEY, payload.token);
            url.hash = "";
            shareUrl = url.toString();
          }
        }
      } catch {
        // Local development without KV falls back to the legacy inline snapshot link.
      }
      if (!shareUrl) {
        shareUrl = shareUrlForToken(encodeShareSnapshot(snapshot));
      }
      rememberShareLink({
        token: shareToken || undefined,
        url: shareUrl,
        roadbookId: activeRoadbook.id,
        roadbookTitle: activeRoadbook.title,
        createdAt: snapshot.createdAt,
        expiresAt: new Date(Date.now() + SHARE_LINK_TTL).toISOString(),
        storage: shareToken ? "cloud" : "browser",
      });
      try {
        await navigator.clipboard.writeText(shareUrl);
        flash(missingCount ? `分享链接已复制，${missingCount} 条路线暂未能获取` : "分享链接已复制，可直接粘贴发送");
      } catch {
        flash("复制失败，请检查浏览器剪贴板权限");
      }
    } finally {
      setIsPreparingShare(false);
    }
  }

  function saveSettings(next: typeof settings) {
    if (readOnly) return;
    setSettings(next);
    window.localStorage.setItem(scopedStorageKey("roadbook-amap-settings", storageScope), JSON.stringify(next));
    setShowSettings(false);
    if (next.jsKey) setMapError("");
    if (!authUser) {
      flash("高德地图配置已保存");
      return;
    }
    void fetch("/api/amap-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(next),
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({})) as { jsKey?: string; securityCode?: string; webKey?: string };
      if (!response.ok) {
        flash("高德配置已保存在本机，但云端保存失败");
        return;
      }
      setSettings((current) => ({ ...current, jsKey: payload.jsKey ?? current.jsKey, securityCode: payload.securityCode ?? current.securityCode, webKey: payload.webKey ?? current.webKey }));
      window.localStorage.setItem(scopedStorageKey("roadbook-amap-settings", storageScope), JSON.stringify({ ...next, ...payload }));
      flash("高德配置已保存到云端");
    }).catch(() => flash("高德配置已保存在本机，但云端保存失败"));
  }

  function logoutAccount() {
    if (!authUser) return;
    void fetch("/api/auth/logout", { method: "POST", cache: "no-store" }).finally(() => { window.location.href = "/"; });
  }

  async function loadAdminUsers() {
    if (authUser?.username !== "admin") return;
    setIsLoadingAdminUsers(true);
    setAdminUsersError("");
    try {
      const response = await fetch("/api/admin/users", { headers: { Accept: "application/json" }, cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as { users?: AdminUserSummary[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "admin-users-load-failed");
      setAdminUsers(Array.isArray(payload.users) ? payload.users : []);
    } catch {
      setAdminUsersError("暂时无法读取用户资料，请稍后刷新重试。");
    } finally {
      setIsLoadingAdminUsers(false);
    }
  }

  async function deleteAdminUser(user: AdminUserSummary) {
    if (authUser?.username !== "admin" || user.username === "admin" || deletingAdminUserId) return;
    if (!window.confirm(`确定删除用户“${user.username}”吗？该用户的路书、登录会话、分享记录和高德缓存都会被永久删除。`)) return;
    setDeletingAdminUserId(user.id);
    try {
      const response = await fetch(`/api/admin/users?userId=${encodeURIComponent(user.id)}`, { method: "DELETE", headers: { Accept: "application/json" }, cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "admin-user-delete-failed");
      setAdminUsers((current) => current.filter((item) => item.id !== user.id));
      flash(`用户“${user.username}”已删除`);
    } catch {
      flash("删除失败，请刷新后重试");
    } finally {
      setDeletingAdminUserId(null);
    }
  }

  function openAdminUsers() {
    if (readOnly || authUser?.username !== "admin") return;
    setShowAdminUsers(true);
    void loadAdminUsers();
  }

  const storageStatusLabel = storageStatus === "remote"
    ? "已同步到云端"
    : storageStatus === "saving"
      ? "正在保存到云端"
      : storageStatus === "loading"
        ? "正在连接云端"
        : storageStatus === "local"
          ? "已自动保存到本机"
          : "云端当前不可用";
  const routeConnectionLabel = readOnly ? (mapReady ? "高德地图已接入" : "正在加载高德地图") : mapReady ? "高德路线已接入" : "示例路线预览";

  if (shareLoadError) {
    return <main className="share-error-page"><div className="share-error-card"><div className="brand-mark" aria-hidden="true">路</div><div className="eyebrow">SHARE LINK UNAVAILABLE</div><h1>分享链接无效</h1><p>链接可能被截短、已过期，或已经被创建者撤销。请向分享者重新获取完整链接。</p><Link className="primary-button" href="/">返回首页 <span>→</span></Link></div></main>;
  }

  return (
    <main className={`app-shell ${isResizing ? "is-resizing" : ""} ${readOnly ? "read-only-view" : ""} ${isShareOverview ? "share-overview-view" : ""}`}>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">路</div>
          <div>
            <div className="brand-name">路书 <span>ROAM NOTE</span></div>
            <div className="brand-tagline">把路上的每一个想法，排成一段好走的旅程</div>
          </div>
        </div>
        <div className="top-actions">
          {readOnly ? <><div className="share-mode-label"><span>分享路书</span><small>路径 · 费用 · 时间已记录</small></div><span className="route-connection-status"><span className={`route-status-dot ${mapReady ? "connected" : ""}`} />{routeConnectionLabel}</span></> : <><button className="library-button" type="button" onClick={() => setShowLibrary(true)}>☷ 我的路书 <span>{roadbooks.length}</span></button><button className="share-manager-button" type="button" onClick={openShareManager}>↗ 分享管理</button>{authUser?.username === "admin" && <button className="admin-users-button" type="button" onClick={openAdminUsers}>用户管理</button>}<div className="top-system-status"><button className="sync-status" type="button" onClick={saveTrip}><span className="status-dot" />{storageStatusLabel}</button><span className="route-connection-status"><span className={`route-status-dot ${mapReady ? "connected" : ""}`} />{routeConnectionLabel}</span></div><button className="map-settings-button" type="button" onClick={() => setShowSettings(true)}>配置地图</button><button className="new-roadbook-button" type="button" onClick={() => setShowLibrary(true)}>＋ 新路书</button><button className="avatar" type="button" onClick={logoutAccount} aria-label={authUser ? `退出 ${authUser.username}` : "用户菜单"} title={authUser ? `当前账号：${authUser.username}，点击退出` : undefined}>{authUser?.username.slice(0, 1).toUpperCase() ?? "Y"}</button></>}
        </div>
      </header>

      <div ref={workspaceRef} className={`workspace ${isRoadbookOverview ? "share-overview-workspace" : ""}`} style={{ "--editor-track": `${editorWidth}fr`, "--map-track": `${100 - editorWidth}fr` } as CSSProperties}>
        <aside className="sidebar">
          <div className="sidebar-intro">
            <div className="eyebrow">MY ROADBOOK / {String(roadbooks.findIndex((roadbook) => roadbook.id === activeRoadbookId) + 1).padStart(2, "0")}</div>
            <h1>{starterTrip.title}</h1>
            <p>{starterTrip.description}</p>
            <div className="trip-meta"><span>⌖ {starterTrip.region} · {days.length} 天</span><span>◇ {totalStops} 个地点</span></div>
          </div>

          <button className={`roadbook-distance-summary ${roadbookDistanceSummary.complete ? "ready" : "pending"} ${isRoadbookOverview ? "selected" : ""}`} type="button" onClick={() => readOnly ? setShareMapMode("overview") : setEditorMapMode("overview")} aria-pressed={isRoadbookOverview} aria-label="查看全程地图总览">
            <span className="roadbook-overview-icon" aria-hidden="true">⌁</span><span className="roadbook-distance-summary-label">全程地图总览</span>
            <strong>{roadbookDistanceSummary.complete ? formatKilometers(roadbookDistanceSummary.distance) : readOnly ? "未完整记录" : amapLoaded ? "计算中…" : "待连接高德"}</strong>
            <span className="roadbook-distance-summary-arrow" aria-hidden="true">{isRoadbookOverview ? "已查看" : "查看 →"}</span>
          </button>
          <div className="day-list-header"><span>行程安排</span><span className="day-count">{days.length} DAYS</span></div>
          <div className="day-list">
            {days.map((day, index) => {
              const distanceSummary = dayDistanceById[day.id];
              const distanceLabel = distanceSummary?.complete ? formatKilometers(distanceSummary.distance) : readOnly ? "未记录" : amapLoaded ? "计算中…" : "待计算";
              return <div className="day-wrap" key={day.id}>
                <button className={`day-card ${selectedDayId === day.id && !isRoadbookOverview ? "selected" : ""}`} type="button" onClick={() => { setSelectedDayId(day.id); if (readOnly) setShareMapMode("day"); else setEditorMapMode("day"); }}>
                  <span className="day-number">{String(index + 1).padStart(2, "0")}</span>
                  <span className="day-copy"><strong>{day.title}</strong><span className="day-meta-row"><small>{day.date} · {day.stops.length} 个地点</small><small className={`day-distance ${distanceSummary?.complete ? "ready" : ""}`}>{distanceLabel}</small></span></span>
                  <span className="day-arrow">{selectedDayId === day.id && !isRoadbookOverview ? "↗" : "→"}</span>
                </button>
                {!readOnly && <><div className="day-hover-actions">
                  <button type="button" onClick={() => moveDay(day.id, -1)} aria-label="提前一天">↑</button>
                  <button type="button" onClick={() => moveDay(day.id, 1)} aria-label="顺延一天">↓</button>
                  <button type="button" onClick={() => removeDay(day.id)} aria-label="删除这一天">×</button>
                </div>
                {index < days.length - 1 && <button className="insert-line" type="button" onClick={() => insertDay(day.id)}><span>＋</span> 在这里插入一天</button>}</>}
              </div>;
            })}
          </div>

          {!readOnly && <button className="add-day-button" type="button" onClick={() => insertDay(days.at(-1)?.id)}><span>＋</span> 在行程末尾添加一天</button>}
        </aside>

        {!isRoadbookOverview && <>
        <section className="editor-pane">
          <div className="editor-head">
            <div>
              <div className="crumb">{starterTrip.title} <span>/</span> 第 {days.findIndex((day) => day.id === selectedDayId) + 1} 天</div>
              <div className="title-row"><input readOnly={readOnly} aria-label="编辑当天标题" value={selectedDay.title} onChange={(event) => updateSelectedDay((day) => ({ ...day, title: event.target.value }))} />{!readOnly && <span className="edit-hint">↗</span>}</div>
              <input className="subtitle-input" readOnly={readOnly} aria-label="编辑当天副标题" value={selectedDay.subtitle} onChange={(event) => updateSelectedDay((day) => ({ ...day, subtitle: event.target.value }))} />
            </div>
            <div className="editor-actions">{!readOnly && <button className="ghost-button" type="button" onClick={() => openPlaceSearch()}>＋ 添加地点</button>}{!readOnly && <button className="ghost-button" type="button" onClick={() => setShowCopyRoadbook(true)}>⧉ 复制当前路书</button>}<button className="export-button" type="button" onClick={exportPdf}>↗ 导出 PDF</button>{!readOnly && <button className="share-button" type="button" disabled={isPreparingShare} onClick={() => void shareRoadbook()}>{isPreparingShare ? "正在补齐全程路线…" : "↗ 分享路书"}</button>}{readOnly && <button className="share-button" type="button" onClick={() => void shareRoadbook()}>↗ 复制分享链接</button>}{!readOnly && <button className="primary-button" type="button" onClick={saveTrip}>保存路书 <span>⌘ S</span></button>}<a className="mobile-navigation-button" href={amapNavigationUrl(selectedDay.stops)} target="_blank" rel="noreferrer">↗ 高德导航</a></div>
          </div>

          <div className="stats-strip"><div className="date-stat"><span className="stat-label">当日日期</span><input className="departure-date" readOnly={readOnly} disabled={readOnly} type="date" value={selectedDayDateValue} aria-label="修改当日日期" onInput={(event) => updateSelectedDayDate(event.currentTarget.value)} /></div><div><span className="stat-label">总里程</span><strong>{routeDistance}</strong></div><div><span className="stat-label">预计驾驶</span><strong>{routeDuration}</strong></div><div><span className="stat-label">当日高速费</span><strong>{routeSummary ? formatTolls(routeSummary.tolls) : readOnly ? "未记录" : selectedDayHasRouteError ? "正在重试…" : amapLoaded ? "计算中…" : "待获取"}</strong></div><div className="cumulative-toll-stat"><span className="stat-label">截至当前累计高速费</span><button className="cumulative-toll-button" type="button" onClick={() => setShowCumulativeTolls(true)} aria-haspopup="dialog">{cumulativeTollsComplete ? `${formatTolls(cumulativeTollsAmount)} · 查看` : readOnly ? "未记录 · 查看" : selectedDayHasRouteError ? "正在重试… · 查看" : amapLoaded ? "计算中…" : "点击计算"}</button></div><div className="cumulative-distance-stat"><span className="stat-label">截至当前累计总里程</span><strong>{cumulativeDistanceSummary.complete ? formatKilometers(cumulativeDistanceSummary.distance) : readOnly ? "未完整记录" : selectedDayHasRouteError ? "正在重试…" : amapLoaded ? "计算中…" : "待连接高德"}</strong></div></div>

          <div className="stops-section">
            <div className="section-heading"><div><div className="eyebrow">DAY {String(days.findIndex((day) => day.id === selectedDayId) + 1).padStart(2, "0")} / TIMELINE</div><h2>这一天，去哪里</h2></div><span className="section-note">{readOnly ? "路径、费用和时间以分享时记录为准" : "拖动顺序也可以，先把想去的地方放进来"}</span></div>
            <div className="timeline">
              {selectedDay.stops.length === 0 && <div className="empty-day-state"><span>⌖</span><strong>这一天还没有地点</strong><p>先添加一个出发点，再继续安排当天行程。</p>{!readOnly && <button className="primary-button" type="button" onClick={() => openPlaceSearch()}>＋ 添加第一个地点</button>}</div>}
              {selectedDay.stops.map((stop, index) => {
                const destination = selectedDay.stops[index + 1];
                const serviceAreaKey = destination ? legCacheKey(stop, destination) : "";
                const serviceAreaState = serviceAreaKey ? serviceAreaLegs[serviceAreaKey] : undefined;
                const hideNonHighwayLeg = serviceAreaState?.status === "ready" && !serviceAreaState.highway;
                return <div className="stop-leg-group" key={stop.id}>
                <div className="stop-row">
                  <div className="timeline-rail"><span className={`stop-dot ${stop.kind === "住宿" ? "stay" : ""}`}>{index + 1}</span>{index < selectedDay.stops.length - 1 && <i />}</div>
                  <div className="stop-content">
                    <div className="stop-main">
                      <div>
                        {stop.kind === "出发" ? <>
                          <div className="stop-kicker"><span className="kind-pill orange">{stop.kind}</span><input className="departure-time" readOnly={readOnly} disabled={readOnly} type="time" value={extractClock(stop.duration)} aria-label={`修改${stop.name}出发时间`} onChange={(event) => updateDepartureTime(stop.id, event.target.value)} /></div>
                          <h3>{stop.name}</h3>
                          {index < selectedDay.stops.length - 1 && <div className="leg-summary"><span>↘</span>{displayLegMetrics[stop.id]?.status === "loading" ? "正在计算路线…" : displayLegMetrics[stop.id]?.status === "ready" ? <>约 {formatDistance(displayLegMetrics[stop.id].distance)} · {formatDuration(displayLegMetrics[stop.id].duration)}</> : readOnly ? "分享时未记录该路段" : "路线距离待加载"}</div>}
                        </> : <div className="stop-destination-line">
                          <span className={`kind-pill ${stop.kind === "住宿" ? "green" : ""}`}>{stop.kind}</span>
                          <h3 className="stop-inline-name">{stop.name}</h3>
                          {stopArrivalTimes[index] && <span className="stop-arrival">预计 {stopArrivalTimes[index]} 到达</span>}
                          {index < selectedDay.stops.length - 1 && <div className="leg-summary"><span>↘</span>{displayLegMetrics[stop.id]?.status === "loading" ? "正在计算路线…" : displayLegMetrics[stop.id]?.status === "ready" ? <>约 {formatDistance(displayLegMetrics[stop.id].distance)} · {formatDuration(displayLegMetrics[stop.id].duration)}</> : readOnly ? "分享时未记录该路段" : "路线距离待加载"}</div>}
                        </div>}
                        <a className="stop-navigation-button" href={amapStopNavigationUrl(stop)} target="_blank" rel="noreferrer">导航到这里 ↗</a>
                      </div>
                      {!readOnly && <div className="stop-tools">{stop.kind !== "出发" && <button className="set-departure-button" type="button" onClick={() => setStopAsDeparture(stop.id)} aria-label={`将${stop.name}设为出发点`}>设为出发</button>}<button type="button" onClick={() => openPlaceSearch(stop.id)} aria-label={`修改${stop.name}`}>✎</button><button type="button" onClick={() => moveStop(stop.id, -1)} aria-label="上移地点">↑</button><button type="button" onClick={() => moveStop(stop.id, 1)} aria-label="下移地点">↓</button><button type="button" onClick={() => removeStop(stop.id)} aria-label="删除地点">×</button></div>}
                    </div>
                    {index === selectedDay.stops.length - 1 && <div className="trip-total-summary"><span>总时长</span><strong>{routeSummary ? formatDuration(routeSummary.duration) : selectedDay.stops.length < 2 ? "待规划" : readOnly ? "未记录" : mapReady ? "正在计算…" : "待连接高德"}</strong>{routeSummary && <span className="toll-summary">高速费 {formatTolls(routeSummary.tolls)}</span>}{days.at(-1)?.id === selectedDay.id && <span className="toll-summary total-toll-summary">全程高速费 {allRoadbookTolls.complete ? formatTolls(allRoadbookTolls.amount) : readOnly ? "未记录" : amapLoaded ? "计算中…" : "待获取"}</span>}</div>}
                    {!readOnly && editingNoteStopId === stop.id && <div className="stop-note-editor"><textarea value={noteDraft} maxLength={200} autoFocus aria-label={`编辑${stop.name}备注`} placeholder="写下这个途经点的提醒，例如：补能、吃饭或拍照" onChange={(event) => setNoteDraft(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") saveStopNote(stop.id); if (event.key === "Escape") cancelNoteEdit(); }} /><div className="stop-note-actions"><small>{noteDraft.length}/200 · ⌘↵ 保存</small><div><button type="button" onClick={cancelNoteEdit}>取消</button><button className="save-note-button" type="button" onClick={() => saveStopNote(stop.id)}>保存备注</button></div></div></div>}
                    {!readOnly && editingNoteStopId !== stop.id && <div className={`stop-note ${stop.note ? "has-note" : "empty-note"}`}><span>✦</span>{stop.note ? <><span className="note-text">{stop.note}</span><button type="button" onClick={() => startNoteEdit(stop)}>编辑</button></> : <button type="button" onClick={() => startNoteEdit(stop)}>添加备注</button>}</div>}
                    {readOnly && stop.note && <div className="stop-note has-note"><span>✦</span><span className="note-text">{stop.note}</span></div>}
                  </div>
                </div>
                {destination && !readOnly && !hideNonHighwayLeg && <div className={`leg-service-zone ${activeServiceAreaLeg === serviceAreaKey ? "open" : ""}`}>
                  <button className="leg-service-trigger" type="button" aria-expanded={activeServiceAreaLeg === serviceAreaKey} aria-controls={`service-areas-${stop.id}`} onClick={() => { const opening = activeServiceAreaLeg !== serviceAreaKey; setActiveServiceAreaLeg(opening ? serviceAreaKey : null); if (opening) void loadLegServiceAreas(stop, destination); }}><span className="leg-service-line" /><span className="leg-service-icon">S</span><span>{serviceAreaState?.status === "loading" ? "正在查找沿途服务区" : serviceAreaState?.status === "ready" ? `沿途 ${serviceAreaState.items.length} 个高速服务区` : serviceAreaState?.status === "error" ? "重新查询沿途服务区" : "查看高速服务区"}</span><span className="leg-service-chevron">⌄</span></button>
                  {activeServiceAreaLeg === serviceAreaKey && <div className="leg-service-panel" id={`service-areas-${stop.id}`} role="region" aria-label={`${stop.name}到${destination.name}沿途高速服务区`}>
                    {serviceAreaState?.status === "loading" || !serviceAreaState ? <div className="leg-service-message"><span className="service-loading-dot" />正在沿高速路线查找服务区…</div> : serviceAreaState.status === "error" ? <div className="leg-service-message error">暂时无法读取高德服务区，点击上方重试。</div> : serviceAreaState.items.length ? <><div className="leg-service-panel-head"><span>{stop.name} → {destination.name}</span><strong>{serviceAreaState.items.length} 个服务区</strong></div><div className="leg-service-list">{serviceAreaState.items.map((area) => <button className="leg-service-item" type="button" key={area.id ?? `${area.name}-${area.lng}-${area.lat}`} onClick={() => insertServiceArea(stop.id, area)}><span className="service-area-marker">S</span><span className="service-area-copy"><strong>{area.name}</strong><small>{area.address} · 距本段起点约 {formatDistance(area.distanceFromStart)}</small></span><span className="service-area-add">＋ 插入</span></button>)}</div></> : <div className="leg-service-message">已识别高速路段，暂未搜索到沿线服务区。</div>}
                  </div>}
                </div>}
                </div>;
              })}
            </div>
            {!readOnly && selectedDay.stops.length > 0 && <button className="inline-add" type="button" onClick={() => openPlaceSearch()}>＋ 在这一天添加一个地点</button>}
          </div>
        </section>

        <div className={`split-divider ${isResizing ? "dragging" : ""}`} role="separator" aria-orientation="vertical" aria-label="调整编辑区和地图宽度" aria-valuemin={32} aria-valuemax={68} aria-valuenow={Math.round(editorWidth)} onPointerDown={startResize} onPointerMove={(event) => isResizing && updateEditorWidth(event.clientX)} onPointerUp={finishResize} onPointerCancel={finishResize}><span>⋮</span></div>
        </>}

        <section className="map-panel">
          <div className="map-topbar"><div><span className="map-label">{isRoadbookOverview ? "ROADBOOK OVERVIEW" : "LIVE MAP / AMAP"}</span><strong>{isRoadbookOverview ? "全程地图总览" : selectedDay.title}</strong></div>{!readOnly && <button className="map-control" type="button" onClick={() => setShowSettings(true)}>{settings.jsKey ? "已连接" : "连接高德"} <span>↗</span></button>}</div>
          <div className={`map-wrap ${mapReady ? "has-amap" : ""} ${isRoadbookOverview ? "overview-map-wrap" : ""}`}>
            <div className="map-fallback" aria-label="路线示意图">
              <div className="map-grid" />
              <div className="map-river" />
              <div className="map-mountain mountain-one" /><div className="map-mountain mountain-two" />
              {!mapRoutePaths.length && <div className="route-line" />}
              {mapRoutePaths.length > 0 && <svg className="snapshot-route" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label={isRoadbookOverview ? "全程路线" : "当天路线"}>{sharedMapProjection.lines.map((line, index) => <polyline key={`${index}-${line.slice(0, 20)}`} points={line} className={isRoadbookOverview ? "overview-route-segment" : undefined} />)}</svg>}
              {mapMarkerStops.map((stop, index) => { const point = mapRoutePaths.length > 0 ? sharedMapProjection.markers[index] : { x: 18 + (index * 29), y: 66 - (index * 17) }; return <div key={`${stop.id}-${index}`} className={`fallback-marker ${isRoadbookOverview ? "overview-marker" : ""}`} style={{ left: `${point.x}%`, top: `${point.y}%` }}><span>{stop.mapLabel ?? index + 1}</span>{!isRoadbookOverview && <label>{stop.name}</label>}</div>; })}
              <div className="map-coordinates"><span>30°03′N</span><span>101°58′E</span></div>
              <div className="map-compass">N<br /><span>✦</span></div>
              {isRoadbookOverview && <div className="snapshot-map-badge">{mapRoutePaths.length === days.length ? `全程 ${days.length} 天 · 路线已完整记录` : `全程 ${days.length} 天 · ${days.length - mapRoutePaths.length} 天路线未记录`}</div>}
              {!settings.jsKey && !readOnly && <div className="map-message"><span className="map-message-icon">⌖</span><strong>接入高德地图，查看真实路线</strong><p>当前分享页暂时无法加载高德地图底图。</p><button type="button" onClick={() => setShowSettings(true)}>去设置 Key <span>→</span></button></div>}
            </div>
            <div className="map-host" ref={mapContainer} />
          </div>
          <div className="map-bottom"><div className="legend"><span><i className="legend-dot orange" />{isRoadbookOverview ? "每日出发点" : "行程地点"}</span><span><i className="legend-dot green" />{isRoadbookOverview ? "全程路线分段" : "住宿"}</span></div><a href={amapNavigationUrl(isRoadbookOverview ? overviewStops : selectedDay.stops)} target="_blank" rel="noreferrer">{isRoadbookOverview ? "在高德中查看起终点" : "在高德中导航"} ↗</a></div>
        </section>
      </div>

      {printPayload && <PrintRoadbook roadbook={printPayload.roadbook} routeCache={printPayload.routeCache} />}

      {showLibrary && <RoadbookLibraryModal roadbooks={roadbooks} activeRoadbookId={activeRoadbookId} onClose={() => setShowLibrary(false)} onSelect={openRoadbook} onCreate={createRoadbook} onDelete={deleteRoadbook} />}
      {showCopyRoadbook && <CopyRoadbookModal sourceTitle={activeRoadbook.title} onClose={() => setShowCopyRoadbook(false)} onSave={copyRoadbook} />}
      {showShareManager && <ShareManagerModal links={shareLinks} editableRoadbooks={roadbooks} isLoading={isLoadingShareLinks} importingShareKey={importingShareKey} onClose={() => setShowShareManager(false)} onRefresh={() => void refreshShareLinks()} onCopy={(link) => void copyShareLink(link)} onRevoke={(link) => void revokeShareLink(link)} onImport={importShareAsEditable} onImportAll={importAllSharesAsEditable} onOpen={openShareEditableSource} />}
      {showAdminUsers && <AdminUsersModal users={adminUsers} isLoading={isLoadingAdminUsers} error={adminUsersError} deletingUserId={deletingAdminUserId} onClose={() => setShowAdminUsers(false)} onRefresh={() => void loadAdminUsers()} onDelete={(user) => void deleteAdminUser(user)} />}
      {showAddPlace && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closePlaceSearch()}><div className="modal-card add-modal"><div className="modal-head"><div><span className="eyebrow">{editingStopId ? "EDIT A PLACE" : "ADD A PLACE"}</span><h2>{editingStopId ? "修改这个地点" : "把想去的地方放进来"}</h2></div><button type="button" className="modal-close" onClick={closePlaceSearch}>×</button></div><div className="search-box"><span>⌕</span><input value={query} placeholder="搜索景点、餐厅或酒店" onChange={(event) => { setQuery(event.target.value); schedulePlaceSearch(event.target.value); }} onKeyDown={(event) => event.key === "Enter" && (event.preventDefault(), searchPlacesImmediately(event.currentTarget.value))} /><button type="button" onClick={() => searchPlacesImmediately()}>搜索</button></div><div className="search-results">{searchResults.length ? searchResults.map((result) => <button className="search-result" type="button" key={result.id} title={editingStopId ? "修改地点" : "添加地点"} aria-label={`${editingStopId ? "修改为" : "添加"}${result.name}`} onClick={() => addSearchResult(result)}><span className="result-pin">⌖</span><span><strong>{result.name}</strong><small>{formatSearchResultMeta(result)}</small></span><span className={`result-add ${editingStopId ? "edit-result-icon" : ""}`} aria-hidden="true">{editingStopId ? "✎" : "＋"}</span></button>) : <div className="empty-results"><span>⌖</span><p>{query ? "正在结合当前行程位置搜索，或按回车立即搜索" : editingStopId ? "搜索并选择新的地点" : "搜索一个地点，加入第 " + (days.findIndex((day) => day.id === selectedDayId) + 1) + " 天"}</p></div>}</div><div className="modal-foot">{editingStopId ? "选择搜索结果后会替换原地点，行程类型、出发时间和备注会保留。" : "搜索会结合当天行程位置、城市和全国结果，并优先显示名称最匹配的地点。"}</div></div></div>}

      {showCumulativeTolls && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowCumulativeTolls(false)}><div className="modal-card cumulative-tolls-modal" role="dialog" aria-modal="true" aria-labelledby="cumulative-tolls-title"><div className="modal-head"><div><span className="eyebrow">TOLL CALCULATOR</span><h2 id="cumulative-tolls-title">截至第 {selectedDayIndex + 1} 天</h2></div><button type="button" className="modal-close" onClick={() => setShowCumulativeTolls(false)} aria-label="关闭累计高速费">×</button></div><p className="cumulative-tolls-lead">从 {days[0]?.date ?? "出发日"} 出发，累计计算到 {selectedDay.date} 的所有行程高速费。</p><div className="cumulative-tolls-total"><span>累计高速费</span><strong>{cumulativeTollsComplete ? formatTolls(cumulativeTollsAmount) : readOnly ? "未记录" : amapLoaded ? "正在计算…" : "待获取"}</strong></div><div className="cumulative-tolls-list">{cumulativeTollDays.map(({ day, complete, amount }, index) => <div className="cumulative-toll-row" key={day.id}><div><strong>第 {index + 1} 天 · {day.date}</strong><small>{day.title}</small></div><span>{complete ? formatTolls(amount) : readOnly ? "未记录" : amapLoaded ? "计算中…" : "待获取"}</span></div>)}</div>{!cumulativeTollsComplete && !readOnly && !amapLoaded && <div className="modal-foot">请先连接高德地图，路线规划完成后再次打开这里即可看到累计高速费。</div>}<div className="modal-actions"><button className="primary-button" type="button" onClick={() => setShowCumulativeTolls(false)}>知道了 <span>→</span></button></div></div></div>}

      {showSettings && <SettingsModal settings={settings} onClose={() => setShowSettings(false)} onSave={saveSettings} />}
      {showToast && <div className="toast"><span>✓</span>{showToast}</div>}
      {mapError && <button className="map-error" type="button" onClick={() => setMapError("")}>{mapError} <span>×</span></button>}
    </main>
  );
}

function PrintRoadbook({ roadbook, routeCache }: { roadbook: Roadbook; routeCache: RouteCache }) {
  const totalStops = roadbook.days.reduce((sum, day) => sum + day.stops.length, 0);
  return <div className="print-only roadbook-print">
    <div className="print-cover"><div className="print-mark">路</div><div className="eyebrow">ROAM NOTE / ROADBOOK</div><h1>{roadbook.title}</h1><p>{roadbook.description}</p><div className="print-summary">{roadbook.region} · {roadbook.days.length} 天 · {totalStops} 个地点</div></div>
    {roadbook.days.map((day, dayIndex) => {
      const metrics = day.stops.slice(0, -1).map((stop, stopIndex) => routeCache.legs[legCacheKey(stop, day.stops[stopIndex + 1])]);
      const totalDistance = metrics.reduce((sum, metric) => sum + (metric?.distance ?? 0), 0);
      const totalDuration = metrics.reduce((sum, metric) => sum + (metric?.duration ?? 0), 0);
      const hasCompleteMetrics = metrics.length > 0 && metrics.every(Boolean);
      return <section className="print-day" key={day.id}>
        <div className="print-day-heading"><span>DAY {String(dayIndex + 1).padStart(2, "0")}</span><small>{day.date}</small></div>
        <h2>{day.title}</h2>
        <p className="print-subtitle">{day.subtitle}</p>
        <ol>{day.stops.map((stop, stopIndex) => {
          const nextStop = day.stops[stopIndex + 1];
          const metric = nextStop ? metrics[stopIndex] : undefined;
          return <li key={stop.id}>
            <strong>{stop.name}</strong>
            <span>{stop.kind} · {stop.duration}</span>
            <small>{stop.area}</small>
            {nextStop && <small className="print-leg">↘ 约 {metric ? formatDistance(metric.distance) : "距离待计算"} · {metric ? formatDuration(metric.duration) : "驾驶时间待计算"}</small>}
            {stop.note && <em>{stop.note}</em>}
          </li>;
        })}</ol>
        <div className="print-day-total"><span>当天驾驶</span><strong>{hasCompleteMetrics ? `${formatDistance(totalDistance)} · ${formatDuration(totalDuration)}` : "部分路线尚未计算"}</strong></div>
      </section>;
    })}
    <footer className="print-footer">路书 · ROAM NOTE | 由高德路线数据辅助整理</footer>
  </div>;
}

function formatAdminDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未知" : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

function AdminUsersModal({ users, isLoading, error, deletingUserId, onClose, onRefresh, onDelete }: { users: AdminUserSummary[]; isLoading: boolean; error: string; deletingUserId: string | null; onClose: () => void; onRefresh: () => void; onDelete: (user: AdminUserSummary) => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal-card admin-users-modal" role="dialog" aria-modal="true" aria-labelledby="admin-users-title"><div className="modal-head"><div><span className="eyebrow">ADMIN CONSOLE</span><h2 id="admin-users-title">用户管理</h2></div><div className="admin-users-head-actions"><span>{users.length} 个账号</span><button className="refresh-share-button" type="button" onClick={onRefresh} aria-label="刷新用户资料">↻</button><button type="button" className="modal-close" onClick={onClose} aria-label="关闭用户管理">×</button></div></div><p className="admin-users-lead">查看账号注册信息和各自绑定的高德凭据。密码不会显示，也不会返回到页面。</p>{isLoading && !users.length ? <div className="admin-users-state"><span>…</span><p>正在读取用户资料</p></div> : error ? <div className="admin-users-state error"><span>!</span><p>{error}</p><button className="ghost-button" type="button" onClick={onRefresh}>重新读取</button></div> : users.length ? <div className="admin-user-list">{users.map((user) => <article className="admin-user-card" key={user.id}><div className="admin-user-head"><div><strong>{user.username}</strong><span>{user.username === "admin" ? "管理员" : "注册用户"}</span></div><div className="admin-user-actions"><small>注册于 {formatAdminDate(user.createdAt)}</small>{user.username === "admin" ? <span className="admin-current-user">当前账号</span> : <button className="admin-delete-user-button" type="button" disabled={deletingUserId !== null} onClick={() => onDelete(user)}>{deletingUserId === user.id ? "删除中…" : "删除用户"}</button>}</div></div><div className="admin-user-id">账号 ID：{user.id}</div><div className="admin-credentials"><div><span>Web 端（JS API）Key</span><code>{user.amap.jsKey || "未配置"}</code></div><div><span>securityJsCode / 安全密钥</span><code>{user.amap.securityCode || "未配置"}</code></div><div><span>Web 服务 Key</span><code>{user.amap.webKey || "未配置"}</code></div></div></article>)}</div> : <div className="admin-users-state"><span>◎</span><p>还没有注册用户</p></div>}<div className="modal-foot">删除用户会同时清理其路书、登录会话、分享记录和高德缓存；高德凭据仅供管理员查看。</div></div></div>;
}

function RoadbookLibraryModal({ roadbooks, activeRoadbookId, onClose, onSelect, onCreate, onDelete }: { roadbooks: Roadbook[]; activeRoadbookId: string; onClose: () => void; onSelect: (id: string) => void; onCreate: (title: string, description: string) => void; onDelete: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal-card library-modal"><div className="modal-head"><div><span className="eyebrow">MY ROADBOOKS</span><h2>我的路书</h2></div><button type="button" className="modal-close" onClick={onClose}>×</button></div><p className="library-lead"><strong>{roadbooks.length} 条可编辑路书</strong><span>这里是可以继续修改的原始行程。</span></p><div className="roadbook-list">{roadbooks.map((roadbook) => <div className="roadbook-item-row" key={roadbook.id}><button className={`roadbook-item ${roadbook.id === activeRoadbookId ? "active" : ""}`} type="button" onClick={() => onSelect(roadbook.id)}><span className="roadbook-icon">⌁</span><span className="roadbook-item-copy"><strong>{roadbook.title}</strong><small>{roadbook.region} · {roadbook.days.length} 天 · {roadbook.days.reduce((sum, day) => sum + day.stops.length, 0)} 个地点</small></span><span className="roadbook-item-arrow">{roadbook.id === activeRoadbookId ? "当前" : "打开 →"}</span></button><button className="delete-roadbook-button" type="button" onClick={() => onDelete(roadbook.id)} aria-label={`删除${roadbook.title}`}>删除</button></div>)}</div><div className="new-roadbook-form"><div className="form-title"><span>＋</span><strong>创建一条新路书</strong></div><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="路书名称，例如：滇西环线" /><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="一句话描述（可选）" /><button className="primary-button" type="button" onClick={() => onCreate(title, description)}>创建并开始编辑 <span>→</span></button></div><div className="modal-foot">分享管理中的链接是只读快照，不会自动出现在这里；删除路书不会影响其他路书，至少会保留一条路书。</div></div></div>;
}

function CopyRoadbookModal({ sourceTitle, onClose, onSave }: { sourceTitle: string; onClose: () => void; onSave: (title: string) => void }) {
  const [title, setTitle] = useState(`${sourceTitle} 副本`);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal-card copy-roadbook-modal" role="dialog" aria-modal="true" aria-labelledby="copy-roadbook-title"><div className="modal-head"><div><span className="eyebrow">COPY ROADBOOK</span><h2 id="copy-roadbook-title">复制当前路书</h2></div><button type="button" className="modal-close" onClick={onClose} aria-label="关闭">×</button></div><p>将复制所有天数、地点、备注和行程设置。路线会复用当前缓存，不会重新请求高德。</p><label>副本名称<input autoFocus value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && onSave(title)} /></label><div className="modal-actions"><button className="ghost-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={() => onSave(title)}>保存并创建 <span>→</span></button></div></div></div>;
}

function ShareManagerModal({ links, editableRoadbooks, isLoading, importingShareKey, onClose, onRefresh, onCopy, onRevoke, onImport, onImportAll, onOpen }: { links: ShareLink[]; editableRoadbooks: Roadbook[]; isLoading: boolean; importingShareKey: string | null; onClose: () => void; onRefresh: () => void; onCopy: (link: ShareLink) => void; onRevoke: (link: ShareLink) => void; onImport: (link: ShareLink) => void; onImportAll: () => void; onOpen: (link: ShareLink) => void }) {
  const [now] = useState(() => Date.now());
  const pendingImportCount = links.filter((link) => !shareHasIndependentSource(link, links, editableRoadbooks)).length;
  const isLoadingLinks = isLoading && !links.length;
  const isImporting = Boolean(importingShareKey);
  const linkCountLabel = isLoadingLinks ? "…" : String(links.length);
  const pendingImportLabel = isLoadingLinks ? "…" : String(pendingImportCount);
  const pendingImportClass = isLoadingLinks ? "pending" : pendingImportCount ? "warning" : "complete";
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal-card share-manager-modal" role="dialog" aria-modal="true" aria-labelledby="share-manager-title"><div className="modal-head"><div><span className="eyebrow">SHARE LINKS</span><h2 id="share-manager-title">分享管理</h2></div><div className="share-manager-head-actions">{pendingImportCount > 0 && <button className="import-all-share-button" type="button" disabled={isImporting} onClick={onImportAll}>{importingShareKey === "all" ? "正在导入…" : `导入全部 ${pendingImportCount} 条`}</button>}<button className="refresh-share-button" type="button" onClick={onRefresh} aria-label="刷新分享链接">↻</button><button type="button" className="modal-close" onClick={onClose}>×</button></div></div><p className="share-manager-lead">这里管理已经发出去的分享链接。每条链接都是当时的只读快照；可以把快照导入成一条独立的可编辑路书。云端链接默认有效期 30 天。</p><div className="collection-summary" aria-label="路书与分享链接数量"><div><strong>{editableRoadbooks.length}</strong><span>可编辑路书</span></div><div><strong>{linkCountLabel}</strong><span>分享链接</span></div><div className={pendingImportClass}><strong>{pendingImportLabel}</strong><span>待导入编辑</span></div></div><div className="share-explanation"><span aria-hidden="true">i</span><p>同一条路书可以生成多条链接。历史快照不会自动变成新的可编辑路书；多条链接若仍指向同一条路书，编辑时会互相覆盖。{pendingImportCount > 0 && `当前有 ${pendingImportCount} 条分享还没有独立的编辑源，可以逐条或全部导入。`}</p></div><div className="share-link-list">{isLoadingLinks ? <div className="share-manager-empty"><span>…</span><p>正在读取分享记录</p></div> : links.length ? links.map((link) => { const expired = !link.permanent && new Date(link.expiresAt).getTime() <= now; const hasIndependentSource = shareHasIndependentSource(link, links, editableRoadbooks); const linkKey = link.token ?? link.url; const importingThis = importingShareKey === linkKey; return <div className={`share-link-item ${expired ? "expired" : ""}`} key={linkKey}><div className="share-link-icon">↗</div><div className="share-link-copy"><strong>{link.roadbookTitle}</strong><small>{link.storage === "cloud" ? "云端链接" : "当前设备链接"} · 创建于 {new Date(link.createdAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</small><span>{link.permanent ? "长期有效" : expired ? "已过期" : `有效至 ${new Date(link.expiresAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}`}</span><span className={`share-link-source ${hasIndependentSource ? "linked" : "unlinked"}`}>{hasIndependentSource ? "已有独立的可编辑路书" : "只读快照 · 还没有独立的可编辑路书"}</span></div><div className="share-link-actions">{hasIndependentSource ? <button type="button" onClick={() => onOpen(link)}>打开编辑</button> : <button className="import-share" type="button" disabled={isImporting} onClick={() => onImport(link)}>{importingThis ? "导入中…" : "导入编辑"}</button>}<button type="button" onClick={() => onCopy(link)}>复制</button><button className={link.storage === "cloud" && !expired ? "danger" : "muted"} type="button" onClick={() => onRevoke(link)}>{link.storage === "cloud" && !expired ? "失效" : "移除"}</button></div></div>; }) : <div className="share-manager-empty"><span>↗</span><p>还没有创建过分享链接</p><small>在路书编辑页点击“分享路书”后，链接会出现在这里。</small></div>}</div><div className="modal-foot">导入后会新增一条可编辑路书，并让这条分享指向它；之后保存会同步到该链接。当前设备链接是未配置 KV 时的本地备用方案。</div></div></div>;
}

function SettingsModal({ settings, onClose, onSave }: { settings: { jsKey: string; securityCode: string; webKey: string }; onClose: () => void; onSave: (settings: { jsKey: string; securityCode: string; webKey: string }) => void }) {
  const [draft, setDraft] = useState(settings);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal-card settings-modal"><div className="modal-head"><div><span className="eyebrow">AMAP CONNECTION</span><h2>连接你的高德服务</h2></div><button type="button" className="modal-close" onClick={onClose}>×</button></div><p className="settings-lead">登录账号后，这 3 项凭据会保存到你的 Cloudflare KV 账号记录中，并只用于你的路书。Web 服务 Key 会由服务端调用，留空可保留已有配置。</p><label>Web 端（JS API）Key<input value={draft.jsKey} onChange={(event) => setDraft({ ...draft, jsKey: event.target.value })} placeholder="请输入 JS API Key" /></label><label>安全密钥 securityJsCode<input type="password" value={draft.securityCode} onChange={(event) => setDraft({ ...draft, securityCode: event.target.value })} placeholder="请输入安全密钥" /></label><label>Web 服务 Key <span className="optional">路线、地点搜索与服务区</span><input value={draft.webKey} onChange={(event) => setDraft({ ...draft, webKey: event.target.value })} placeholder="请输入 Web 服务 Key；留空保持原值" /></label><div className="settings-warning"><span>!</span><span>不要把 Key 提交到公开 Git 仓库。高德控制台建议为 JS API Key 设置当前站点域名白名单。</span></div><div className="modal-actions"><button className="ghost-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={() => onSave(draft)}>保存并连接 <span>→</span></button></div></div></div>;
}
