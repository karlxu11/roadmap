"use client";
/* eslint-disable jsx-a11y/no-autofocus -- the note editor opens for immediate keyboard entry. */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { initialDays as importedDays } from "./roadbook-data";

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

type SearchLocation = { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number };
type SearchResult = { id: string; name: string; address: string; location?: { lng: number; lat: number }; type: string };
type AMapWebSearchPoi = { id?: string; name?: string; address?: string; location?: string; type?: string; pname?: string; cityname?: string; adname?: string };
type AMapWebSearchPayload = { status?: string; info?: string; pois?: AMapWebSearchPoi[] };

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
  search: (keyword: string, callback: (status: string, result: { poiList?: { pois?: Array<{ id?: string; name: string; address?: string; location?: SearchLocation; type?: string }> } }) => void) => void;
};

declare global {
  interface Window {
    AMap?: AMapInstance;
    _AMapSecurityConfig?: { securityJsCode?: string };
  }
}

const initialDays: DayPlan[] = importedDays as unknown as DayPlan[];

const ROADBOOK_LIBRARY_KEY = "roadbook-library-v1";
const LEGACY_ROADBOOK_KEY = "roadbook-days-v2";
const ROUTE_CACHE_KEY = "roadbook-route-cache-v1";
const ROUTE_CACHE_TTL = 24 * 60 * 60 * 1000;
const ROUTE_FAILURE_RETRY_TTL = 5 * 60 * 1000;
const ROUTE_REQUEST_CONCURRENCY = 4;
const ROUTE_CACHE_PATH_MAX_POINTS = 240;
const SEARCH_CACHE_TTL = 10 * 60 * 1000;
const SHARE_QUERY_KEY = "share";

type CachedLeg = { distance?: number; duration?: number; tolls?: number | null; path?: Array<[number, number]>; cachedAt: number };
type RouteCache = { legs: Record<string, CachedLeg>; paths: Record<string, Array<[number, number]>>; errors: Record<string, number> };
type RouteApiPayload = { status?: string; info?: string; route?: { distance?: number; duration?: number; tolls?: number | null; path?: Array<[number, number]> } };

// 高德偶尔会返回完整的距离/时长，但不返回 tolls。用 null 记录这种结果，
// 否则每次刷新都会把同一路段误判为未缓存并再次请求。

function routeCacheKey(stops: Stop[]) {
  return stops.map((stop) => `${stop.lng.toFixed(6)},${stop.lat.toFixed(6)}`).join("|");
}

function legCacheKey(from: Stop, to: Stop) {
  return `${from.lng.toFixed(6)},${from.lat.toFixed(6)}>${to.lng.toFixed(6)},${to.lat.toFixed(6)}|policy:0`;
}

function normalizeRoutePath(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((point): point is [number, number] => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]));
}

function combineRoutePaths(paths: Array<Array<[number, number]> | undefined>) {
  return paths.reduce<Array<[number, number]>>((combined, path) => {
    if (!path?.length) return combined;
    return [...combined, ...(combined.length ? path.slice(1) : path)];
  }, []);
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

function loadRouteCache(): RouteCache {
  if (typeof window === "undefined") return { legs: {}, paths: {}, errors: {} };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ROUTE_CACHE_KEY) ?? "null") as Partial<RouteCache> | null;
    const legs = Object.fromEntries(Object.entries(parsed?.legs ?? {}).flatMap(([key, value]) => {
      if (!value || typeof value !== "object") return [];
      const candidate = value as Partial<CachedLeg>;
      if (typeof candidate.cachedAt !== "number" || !Number.isFinite(candidate.cachedAt)
        || typeof candidate.distance !== "number" || !Number.isFinite(candidate.distance)
        || typeof candidate.duration !== "number" || !Number.isFinite(candidate.duration)) return [];
      const tolls = typeof candidate.tolls === "number" && Number.isFinite(candidate.tolls) ? candidate.tolls : null;
      const path = normalizeRoutePath(candidate.path);
      return [[key, { distance: candidate.distance, duration: candidate.duration, tolls, path: path.length >= 2 ? path : undefined, cachedAt: candidate.cachedAt } satisfies CachedLeg]];
    }));
    const paths = Object.fromEntries(Object.entries(parsed?.paths ?? {}).flatMap(([key, value]) => {
      if (!Array.isArray(value) || value.length < 2) return [];
      const path = normalizeRoutePath(value);
      return path.length >= 2 ? [[key, path]] : [];
    }));
    const errors = Object.fromEntries(Object.entries(parsed?.errors ?? {}).filter(([, retryAt]) => typeof retryAt === "number" && Number.isFinite(retryAt)));
    return { legs, paths, errors };
  } catch {
    return { legs: {}, paths: {}, errors: {} };
  }
}

function saveRouteCache(cache: RouteCache) {
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
    window.localStorage.setItem(ROUTE_CACHE_KEY, JSON.stringify(compactCache));
  } catch {
    // 轨迹点可能让 localStorage 超限；清掉旧的大对象后只保留指标，避免刷新后全部重算。
    try {
      window.localStorage.removeItem(ROUTE_CACHE_KEY);
      const metricsOnly = {
        legs: Object.fromEntries(Object.entries(compactLegs).map(([key, leg]) => [key, { distance: leg.distance, duration: leg.duration, tolls: leg.tolls, cachedAt: leg.cachedAt }])),
        paths: {},
        errors: cache.errors,
      } satisfies RouteCache;
      window.localStorage.setItem(ROUTE_CACHE_KEY, JSON.stringify(metricsOnly));
    } catch {
      // Route data is only a disposable optimization cache.
    }
  }
}

function isFreshCachedLeg(leg: CachedLeg | undefined, now = Date.now()) {
  return Boolean(
    leg
    && Number.isFinite(leg.cachedAt)
    && now - leg.cachedAt < ROUTE_CACHE_TTL
    && Number.isFinite(leg.distance)
    && Number.isFinite(leg.duration),
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
        const path = includePath ? routePathFromResult(route) : [];
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
    });
    const response = await fetch(`/api/amap/route?${params.toString()}`, { headers: { Accept: "application/json" }, signal: controller.signal, cache: "force-cache" });
    // Worker 上游高德返回 5xx/限流时，回退到已经加载的 JS API，避免整段路线被判失败。
    if (!response.ok) return response.status === 404 || response.status === 429 || response.status >= 500 ? requestWithJsApi() : null;
    const payload = await response.json() as RouteApiPayload;
    return payload.status === "1" && payload.route && typeof payload.route.distance === "number" && typeof payload.route.duration === "number"
      ? { distance: payload.route.distance, duration: payload.route.duration, tolls: typeof payload.route.tolls === "number" ? payload.route.tolls : null, path: payload.route.path, cachedAt: Date.now() }
      : null;
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

function expectedShareLegCount(roadbook: Roadbook) {
  return roadbook.days.reduce((count, day) => count + Math.max(day.stops.length - 1, 0), 0);
}

function expectedSharePathCount(roadbook: Roadbook) {
  return roadbook.days.filter((day) => day.stops.length >= 2).length;
}

function isCompleteShareSnapshot(snapshot: SharedSnapshot) {
  return Object.keys(snapshot.legs).length >= expectedShareLegCount(snapshot.roadbook)
    && Object.keys(snapshot.paths ?? {}).length >= expectedSharePathCount(snapshot.roadbook);
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

function projectRoutePath(path: Array<[number, number]>, stops: Stop[]) {
  const points = [...path, ...stops.map((stop) => [stop.lng, stop.lat] as [number, number])];
  if (points.length < 2) return { line: "", markers: [] as Array<{ x: number; y: number }> };
  const maxPoints = 280;
  const step = Math.max(1, Math.ceil(path.length / maxPoints));
  const sampledPath = path.filter((_, index) => index % step === 0 || index === path.length - 1);
  return {
    line: sampledPath.map((point) => {
      const projected = projectMapPoint(point, points);
      return `${projected.x},${projected.y}`;
    }).join(" "),
    markers: stops.map((stop) => projectMapPoint([stop.lng, stop.lat], points)),
  };
}

function defaultRoadbook(): Roadbook {
  return {
    id: "roadbook-xinjiang",
    title: "2026中秋国庆新疆",
    description: "从深圳出发，沿着补能点一路向西进入新疆",
    region: "深圳 → 新疆",
    updated: "已从高德路书导入",
    days: initialDays,
  };
}

function parseMonthDay(value: string) {
  const match = value.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  return match ? { month: Number(match[1]), day: Number(match[2]) } : null;
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
  return roadbooks.map((roadbook) => ({ ...roadbook, days: normalizeDayDates(roadbook.days) }));
}

function loadRoadbooks(): Roadbook[] {
  if (typeof window === "undefined") return [defaultRoadbook()];
  const savedLibrary = window.localStorage.getItem(ROADBOOK_LIBRARY_KEY);
  if (savedLibrary) {
    try {
      const parsed = JSON.parse(savedLibrary) as Roadbook[];
      if (Array.isArray(parsed) && parsed.length) return normalizeRoadbookDates(parsed);
    } catch {
      window.localStorage.removeItem(ROADBOOK_LIBRARY_KEY);
    }
  }
  const legacy = window.localStorage.getItem(LEGACY_ROADBOOK_KEY);
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy) as DayPlan[];
      if (Array.isArray(parsed) && parsed.length) return [{ ...defaultRoadbook(), days: normalizeDayDates(parsed) }];
    } catch {
      window.localStorage.removeItem(LEGACY_ROADBOOK_KEY);
    }
  }
  return normalizeRoadbookDates([defaultRoadbook()]);
}

function saveRoadbooks(roadbooks: Roadbook[]) {
  window.localStorage.setItem(ROADBOOK_LIBRARY_KEY, JSON.stringify(roadbooks));
}

async function fetchRemoteRoadbooks() {
  const response = await fetch("/api/roadbooks", { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`roadbook-storage-${response.status}`);
  const payload = await response.json() as { roadbooks?: unknown };
  return Array.isArray(payload.roadbooks) && payload.roadbooks.length ? normalizeRoadbookDates(payload.roadbooks as Roadbook[]) : null;
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
  const firstDay: DayPlan = {
    id: uid("day"),
    date: formatMonthDay(new Date()),
    title: "新的第一天",
    subtitle: "先把想去的地方放进来",
    stops: [{ id: uid("stop"), name: "添加出发点", area: "点击“添加地点”搜索", kind: "出发", lat: 30.657, lng: 104.066, duration: "待安排" }],
  };
  return {
    id: uid("roadbook"),
    title: title.trim() || "未命名路书",
    description: description.trim() || "一段新的旅程",
    region: "自定义行程",
    updated: "刚刚创建",
    days: [firstDay],
  };
}

function loadSavedSettings() {
  if (typeof window === "undefined") return { jsKey: "", securityCode: "", webKey: "" };
  const saved = window.localStorage.getItem("roadbook-amap-settings");
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

function makeInsertedDay(afterDay: DayPlan): DayPlan {
  return {
    id: uid("day"),
    date: "待安排",
    title: "留白的一天",
    subtitle: "放慢脚步，给旅程留一点弹性",
    stops: [
      { ...afterDay.stops.at(-1)!, id: uid("stop"), kind: "出发", duration: "09:30 出发", note: "从上一天的终点开始。" },
      { id: uid("stop"), name: "添加一个想去的地方", area: "点击右侧搜索添加", kind: "景点", lat: afterDay.stops.at(-1)?.lat ?? 30.05, lng: afterDay.stops.at(-1)?.lng ?? 101.96, duration: "待安排" },
    ],
  };
}

function formatDistance(meters?: number) {
  if (typeof meters !== "number" || !Number.isFinite(meters)) return "待计算";
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} 公里` : `${Math.round(meters)} 米`;
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
  const [roadbooks, setRoadbooks] = useState<Roadbook[]>(() => [defaultRoadbook()]);
  const [activeRoadbookId, setActiveRoadbookId] = useState(() => defaultRoadbook().id);
  const activeRoadbook = roadbooks.find((roadbook) => roadbook.id === activeRoadbookId) ?? roadbooks[0];
  const starterTrip = activeRoadbook;
  const days = activeRoadbook.days;
  const [sharedSnapshot, setSharedSnapshot] = useState<SharedSnapshot | null>(null);
  const readOnly = Boolean(sharedSnapshot);
  const [selectedDayId, setSelectedDayId] = useState(() => defaultRoadbook().days[0].id);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showAddPlace, setShowAddPlace] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showCumulativeTolls, setShowCumulativeTolls] = useState(false);
  const [editingNoteStopId, setEditingNoteStopId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [showToast, setShowToast] = useState("");
  const [isPreparingShare, setIsPreparingShare] = useState(false);
  const [storageStatus, setStorageStatus] = useState<"loading" | "remote" | "saving" | "local" | "unavailable">("loading");
  const [amapLoaded, setAmapLoaded] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState("");
  const [legMetrics, setLegMetrics] = useState<Record<string, { status: "loading" | "ready" | "error"; distance?: number; duration?: number; tolls?: number }>>({});
  const [routeCacheVersion, setRouteCacheVersion] = useState(0);
  const [settings, setSettings] = useState({ jsKey: "", securityCode: "", webKey: "" });
  const [editorWidth, setEditorWidth] = useState(52);
  const [isResizing, setIsResizing] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<AMapMap | null>(null);
  const markersRef = useRef<AMapMarker[]>([]);
  const routeLineRef = useRef<AMapPolyline | null>(null);
  const routeCacheRef = useRef<RouteCache>({ legs: {}, paths: {}, errors: {} });
  const pendingLegsRef = useRef(new Map<string, Promise<CachedLeg | null>>());
  const placeSearchRef = useRef<AMapPlaceSearch | null>(null);
  const searchCacheRef = useRef(new Map<string, { results: SearchResult[]; cachedAt: number }>());
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchRequestIdRef = useRef(0);
  const searchDebounceRef = useRef<number | null>(null);

  const selectedDay = days.find((day) => day.id === selectedDayId) ?? days[0];
  const selectedDayIndex = Math.max(days.findIndex((day) => day.id === selectedDayId), 0);
  const totalStops = useMemo(() => days.reduce((sum, day) => sum + day.stops.length, 0), [days]);
  const selectedDayRouteDependencyKey = useMemo(() => `${selectedDay.id}:${selectedDay.stops.map((stop) => `${stop.id}:${stop.lng.toFixed(6)},${stop.lat.toFixed(6)}`).join("|")}`, [selectedDay]);
  const routePlanDependencyKey = useMemo(() => days.map((day) => `${day.id}:${day.stops.map((stop) => `${stop.id}:${stop.lng.toFixed(6)},${stop.lat.toFixed(6)}`).join("|")}`).join("||"), [days]);
  const displayLegMetrics = useMemo(() => {
    if (!sharedSnapshot) return legMetrics;
    return Object.fromEntries(Object.entries(sharedSnapshot.legs).map(([stopId, metric]) => [stopId, { status: "ready" as const, ...metric }])) as typeof legMetrics;
  }, [legMetrics, sharedSnapshot]);
  const routeSummary = useMemo(() => {
    const legs = selectedDay.stops.slice(0, -1).map((stop) => displayLegMetrics[stop.id]).filter((metric) => metric?.status === "ready");
    const expectedLegs = Math.max(selectedDay.stops.length - 1, 0);
    if (legs.length !== expectedLegs) return null;
    return {
      distance: legs.reduce((sum, leg) => sum + (leg.distance ?? 0), 0),
      duration: legs.reduce((sum, leg) => sum + (leg.duration ?? 0), 0),
      tolls: legs.every((leg) => typeof leg.tolls === "number") ? legs.reduce((sum, leg) => sum + (leg.tolls ?? 0), 0) : undefined,
    };
  }, [displayLegMetrics, selectedDay.stops]);
  const allRoadbookTolls = useMemo(() => {
    const now = Date.now();
    const cachedLegs = days.flatMap((day) => day.stops.slice(0, -1).map((stop, index) => sharedSnapshot
      ? sharedSnapshot.legs[stop.id]
      : routeCacheRef.current.legs[legCacheKey(stop, day.stops[index + 1])]));
    const complete = sharedSnapshot
      ? cachedLegs.every((leg) => leg && typeof leg.tolls === "number")
      : cachedLegs.every((leg) => isFreshCachedLeg(leg as CachedLeg, now) && typeof leg?.tolls === "number");
    return {
      complete,
      amount: complete ? cachedLegs.reduce((sum, leg) => sum + (leg?.tolls ?? 0), 0) : undefined,
      cacheVersion: routeCacheVersion,
    };
  }, [days, routeCacheVersion, sharedSnapshot]);
  const cumulativeTollDays = useMemo(() => {
    const now = Date.now();
    const cacheRevision = routeCacheVersion;
    return days.slice(0, selectedDayIndex + 1).map((day) => {
      const metrics = day.stops.slice(0, -1).map((stop, index) => {
        if (sharedSnapshot) return sharedSnapshot.legs[stop.id];
        const current = day.id === selectedDay.id ? displayLegMetrics[stop.id] : undefined;
        if (current?.status === "ready") return current;
        const cached = routeCacheRef.current.legs[legCacheKey(stop, day.stops[index + 1])];
        return isFreshCachedLeg(cached, now) ? cached : undefined;
      });
      const complete = metrics.every((metric) => metric && typeof metric.tolls === "number");
      return {
        day,
        complete,
        amount: complete ? metrics.reduce((sum, metric) => sum + (metric?.tolls ?? 0), 0) : undefined,
        cacheRevision,
      };
    });
  }, [days, displayLegMetrics, routeCacheVersion, selectedDay, selectedDayIndex, sharedSnapshot]);
  const cumulativeTollsComplete = cumulativeTollDays.every(({ complete }) => complete);
  const cumulativeTollsAmount = cumulativeTollsComplete ? cumulativeTollDays.reduce((sum, item) => sum + (item.amount ?? 0), 0) : undefined;
  const routeDistance = routeSummary ? formatDistance(routeSummary.distance) : readOnly ? "未记录" : mapReady ? "正在计算" : "待规划";
  const routeDuration = routeSummary ? formatDuration(routeSummary.duration) : readOnly ? "未记录" : mapReady ? "正在计算" : "待规划";
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
  const selectedDayDate = parseMonthDay(selectedDay.date);
  const roadbookYear = starterTrip.title.match(/20\d{2}/)?.[0] ?? String(new Date().getFullYear());
  const selectedDayDateValue = selectedDayDate ? `${roadbookYear}-${String(selectedDayDate.month).padStart(2, "0")}-${String(selectedDayDate.day).padStart(2, "0")}` : "";

  useEffect(() => {
    let cancelled = false;
    if (hasShareQuery()) {
      const encodedShare = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get(SHARE_QUERY_KEY) ?? "";
      const inlineShare = decodeShareSnapshot(encodedShare);
      const canPollShare = Boolean(encodedShare && !inlineShare);
      let applied = false;
      let pollAttempts = 0;
      let pollTimer: number | null = null;
      const applySharedSnapshot = (fromShare: SharedSnapshot | null) => {
        if (cancelled || !fromShare) {
          if (!cancelled) setStorageStatus("unavailable");
          return;
        }
        setSharedSnapshot(fromShare);
        setRoadbooks([fromShare.roadbook]);
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
    const localRoadbooks = loadRoadbooks();
    fetchRemoteRoadbooks().then(async (remoteRoadbooks) => {
      if (cancelled) return;
      if (remoteRoadbooks) {
        setRoadbooks(remoteRoadbooks);
        saveRoadbooks(remoteRoadbooks);
        setActiveRoadbookId(remoteRoadbooks[0].id);
        setSelectedDayId(remoteRoadbooks[0].days[0]?.id ?? "");
        setStorageStatus("remote");
        return;
      }
      const seeded = await saveRemoteRoadbooks(localRoadbooks);
      if (cancelled) return;
      setStorageStatus(seeded ? "remote" : "unavailable");
    }).catch(() => {
      if (!cancelled) setStorageStatus("unavailable");
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setSettings(loadSavedSettings());
    routeCacheRef.current = loadRouteCache();
    setRouteCacheVersion((version) => version + 1);
  }, []);

  useEffect(() => () => {
    if (searchDebounceRef.current !== null) window.clearTimeout(searchDebounceRef.current);
    searchAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    fetch("/api/amap-config")
      .then((response) => response.ok ? response.json() as Promise<{ jsKey?: string; securityCode?: string; webKey?: string }> : null)
      .then((remote) => {
        if (!remote?.jsKey) return;
        setSettings((current) => ({
          jsKey: remote.jsKey ?? current.jsKey,
          securityCode: remote.securityCode ?? current.securityCode,
          webKey: current.webKey,
        }));
      })
      .catch(() => undefined);
  }, []);

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
    const routeKey = routeCacheKey(selectedDay.stops);
    const sharedPath = readOnly ? sharedSnapshot?.paths?.[routeKey] ?? [] : [];
    try {
      if (!mapRef.current) {
        mapRef.current = new AMap.Map(mapContainer.current, {
          zoom: 7,
          center: [102.3, 30.05],
          resizeEnable: true,
        });
        placeSearchRef.current = new AMap.PlaceSearch({ pageSize: 20, pageIndex: 1, city: "全国", citylimit: false, extensions: "all" });
      }
      const map = mapRef.current;
      if (!map) throw new Error("AMap.Map 未创建");
      markersRef.current.forEach((marker) => marker.setMap(null));
      routeLineRef.current?.setMap(null);
      routeLineRef.current = null;
      markersRef.current = selectedDay.stops.map((stop, index) => new AMap.Marker({
        map,
        position: [stop.lng, stop.lat],
        title: stop.name,
        label: { content: `<span class="amap-label">${index + 1}. ${stop.name}</span>`, direction: "top" },
      }));
      map.setFitView(markersRef.current);
      if (selectedDay.stops.length >= 2) {
        const cachedPath = sharedPath.length >= 2
          ? sharedPath
          : routeCacheRef.current.paths[routeKey] ?? combineRoutePaths(selectedDay.stops.slice(0, -1).map((stop, index) => routeCacheRef.current.legs[legCacheKey(stop, selectedDay.stops[index + 1])]?.path));
        if (cachedPath?.length) {
          if (!routeCacheRef.current.paths[routeKey]) {
            routeCacheRef.current.paths[routeKey] = cachedPath;
            saveRouteCache(routeCacheRef.current);
          }
          routeLineRef.current = new AMap.Polyline({ path: cachedPath, strokeColor: "#dc6b3f", strokeWeight: 5, strokeOpacity: 0.82, lineJoin: "round" });
          routeLineRef.current.setMap(map);
          map.setFitView([...markersRef.current, routeLineRef.current]);
        }
      }
      queueMicrotask(() => setMapReady(true));
    } catch (error) {
      queueMicrotask(() => {
        setMapReady(false);
        setMapError(`高德地图初始化失败：${error instanceof Error ? error.message : "请检查 JS API Key 和安全密钥"}`);
      });
    }
    return () => {
      markersRef.current.forEach((marker) => marker.setMap(null));
      routeLineRef.current?.setMap(null);
    };
  }, [amapLoaded, readOnly, routeCacheVersion, selectedDay, sharedSnapshot, storageStatus]);

  useEffect(() => {
    if (readOnly || hasShareQuery() || storageStatus === "loading" || !amapLoaded || !window.AMap) {
      queueMicrotask(() => setLegMetrics({}));
      return;
    }
    let cancelled = false;
    const now = Date.now();
    const initialMetrics = Object.fromEntries(selectedDay.stops.slice(0, -1).map((stop, index) => {
      const key = legCacheKey(stop, selectedDay.stops[index + 1]);
      const cached = routeCacheRef.current.legs[key];
      const fresh = isFreshCachedLeg(cached, now);
      const retryAt = routeCacheRef.current.errors[key];
      return [stop.id, fresh ? { status: "ready" as const, ...displayCachedLeg(cached) } : retryAt > now ? { status: "error" as const } : { status: "loading" as const }];
    }));
    setLegMetrics(initialMetrics);

    const allLegs = days.flatMap((day) => day.stops.slice(0, -1).map((stop, index) => ({
      dayId: day.id,
      stop,
      destination: day.stops[index + 1],
      key: legCacheKey(stop, day.stops[index + 1]),
    })));
    // 默认只计算当前天；打开累计高速费弹窗后，才补算截至当前天的其它天数。
    const targetLegs = showCumulativeTolls ? allLegs.filter(({ dayId }) => days.findIndex((day) => day.id === dayId) <= selectedDayIndex) : allLegs.filter(({ dayId }) => dayId === selectedDay.id);
    const missingLegs = targetLegs.filter(({ key }) => {
      const cached = routeCacheRef.current.legs[key];
      return !isFreshCachedLeg(cached, now) && (routeCacheRef.current.errors[key] ?? 0) <= now;
    });
    void mapWithConcurrency(missingLegs, ROUTE_REQUEST_CONCURRENCY, async ({ stop, destination, key }) => ({ stopId: stop.id, key, metric: await requestRouteLeg(stop, destination, key, pendingLegsRef.current) })).then((entries) => {
      entries.forEach(({ key, metric }) => {
        if (metric) {
          routeCacheRef.current.legs[key] = metric;
          delete routeCacheRef.current.errors[key];
        } else {
          routeCacheRef.current.errors[key] = Date.now() + ROUTE_FAILURE_RETRY_TTL;
        }
      });
      if (entries.length) {
        saveRouteCache(routeCacheRef.current);
        setRouteCacheVersion((version) => version + 1);
      }
      if (!cancelled) setLegMetrics((current) => ({ ...current, ...Object.fromEntries(entries.map(({ stopId, metric }) => [stopId, metric ? { status: "ready" as const, ...displayCachedLeg(metric) } : { status: "error" as const }])) }));
    });
    return () => { cancelled = true; };
  // 路线计算只依赖路线指纹；标题、备注和出发时间变化不应重新触发高德请求。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amapLoaded, readOnly, routePlanDependencyKey, selectedDayIndex, selectedDayRouteDependencyKey, showCumulativeTolls, storageStatus]);

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

  function updateActiveDays(updater: (days: DayPlan[]) => DayPlan[]) {
    if (readOnly) return;
    setRoadbooks((current) => current.map((roadbook) => roadbook.id === activeRoadbookId ? { ...roadbook, days: updater(roadbook.days) } : roadbook));
  }

  function updateSelectedDay(updater: (day: DayPlan) => DayPlan) {
    updateActiveDays((current) => current.map((day) => (day.id === selectedDayId ? updater(day) : day)));
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

  function updateSelectedDayDate(value: string) {
    const [year, month, day] = value.split("-").map(Number);
    if (![year, month, day].every(Number.isFinite)) return;
    const start = new Date(year, month - 1, day);
    if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) return;
    updateSelectedDay((current) => ({ ...current, date: formatMonthDay(start) }));
  }

  function insertDay(afterId = selectedDayId) {
    const index = days.findIndex((day) => day.id === afterId);
    const source = days[index] ?? days[0];
    const inserted = makeInsertedDay(source);
    updateActiveDays((current) => normalizeDayDates([...current.slice(0, index + 1), inserted, ...current.slice(index + 1)]));
    setSelectedDayId(inserted.id);
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
    updateActiveDays((current) => {
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
    updateSelectedDay((day) => {
      const index = day.stops.findIndex((stop) => stop.id === stopId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= day.stops.length) return day;
      const stops = [...day.stops];
      [stops[index], stops[nextIndex]] = [stops[nextIndex], stops[index]];
      return { ...day, stops };
    });
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
    updateSelectedDay((day) => ({ ...day, stops: day.stops.filter((stop) => stop.id !== stopId) }));
    flash("已移除地点");
  }

  async function searchPlaces(rawKeyword = query) {
    if (readOnly) return;
    const keyword = rawKeyword.trim();
    if (!keyword) return;
    const searchKey = keyword.replace(/\s+/g, " ").toLocaleLowerCase();
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
      const response = await fetch(`/api/amap/search?keywords=${encodeURIComponent(keyword)}`, { headers: { Accept: "application/json" }, signal: controller.signal, cache: "no-store" });
      if (requestId !== searchRequestIdRef.current) return;
      if (response.ok) {
        const payload = await response.json() as AMapWebSearchPayload;
        const webResults = (payload.pois ?? []).reduce<SearchResult[]>((results, poi, index) => {
          const location = normalizeSearchLocation(poi.location);
          const address = poi.address || [poi.pname, poi.cityname, poi.adname].filter(Boolean).join(" · ") || "高德地点";
          if (location) results.push({ id: poi.id ?? `web-poi-${index}`, name: poi.name ?? keyword, address, location, type: poi.type ?? "地点" });
          return results;
        }, []);
        if (webResults.length) {
          searchCacheRef.current.set(searchKey, { results: webResults, cachedAt: Date.now() });
          setSearchResults(webResults);
          return;
        }
        if (payload.status === "1") {
          searchCacheRef.current.set(searchKey, { results: [], cachedAt: Date.now() });
          setMapError("没有找到这个地点，可以换个关键词试试。");
          return;
        }
      }
    } catch {
      // Web 服务 Key 未配置或网络异常时，继续使用 JS API 搜索。
    }

    if (requestId !== searchRequestIdRef.current) return;
    if (!placeSearchRef.current) {
      setSearchResults([{ id: "demo-1", name: keyword, address: "示例地点 · 配置高德 Key 后可搜索真实 POI", type: "搜索结果" }]);
      return;
    }
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
    const fallback = selectedDay.stops.at(-1)!;
    const stop: Stop = {
      id: uid("stop"),
      name: result.name,
      area: result.address || "已添加地点",
      kind: "景点",
      lat: result.location?.lat ?? fallback.lat,
      lng: result.location?.lng ?? fallback.lng,
      duration: "待安排",
    };
    updateSelectedDay((day) => ({ ...day, stops: [...day.stops, stop] }));
    setQuery("");
    setSearchResults([]);
    setShowAddPlace(false);
    flash(`已把「${result.name}」加入第 ${days.findIndex((day) => day.id === selectedDayId) + 1} 天`);
  }

  async function commitRoadbooks(next: Roadbook[], successMessage: string) {
    setRoadbooks(next);
    saveRoadbooks(next);
    setStorageStatus("saving");
    try {
      const saved = await saveRemoteRoadbooks(next);
      setStorageStatus(saved ? "remote" : "unavailable");
      flash(saved ? successMessage : "云端保存失败，暂时保存在当前设备");
    } catch {
      setStorageStatus("unavailable");
      flash("云端保存失败，暂时保存在当前设备");
    }
  }

  function saveTrip() {
    if (readOnly) return;
    const next = roadbooks.map((roadbook) => roadbook.id === activeRoadbookId ? { ...roadbook, updated: "刚刚保存" } : roadbook);
    void commitRoadbooks(next, "路书已保存到云端");
  }

  function openRoadbook(id: string) {
    const target = roadbooks.find((roadbook) => roadbook.id === id);
    if (!target) return;
    setActiveRoadbookId(id);
    setSelectedDayId(target.days[0]?.id ?? "");
    setShowLibrary(false);
    flash(`已切换到「${target.title}」`);
  }

  function createRoadbook(title: string, description: string) {
    const created = makeNewRoadbook(title, description);
    const next = [created, ...roadbooks];
    setActiveRoadbookId(created.id);
    setSelectedDayId(created.days[0].id);
    setShowLibrary(false);
    void commitRoadbooks(next, "新路书已创建并保存到云端");
  }

  function exportPdf() {
    window.print();
  }

  function buildSharePaths(roadbook: Roadbook) {
    return Object.fromEntries(roadbook.days.flatMap((day) => {
      if (day.stops.length < 2) return [];
      const key = routeCacheKey(day.stops);
      const path = routeCacheRef.current.paths[key] ?? combineRoutePaths(day.stops.slice(0, -1).map((stop, index) => routeCacheRef.current.legs[legCacheKey(stop, day.stops[index + 1])]?.path));
      const fallbackPath = day.stops.map((stop) => [stop.lng, stop.lat] as [number, number]);
      return [[key, sampleRoutePath(path.length >= 2 ? path : fallbackPath)]];
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
      return !isFreshCachedLeg(cached, now);
    });
    const entries = await mapWithConcurrency(missingLegs, ROUTE_REQUEST_CONCURRENCY, async ({ stop, destination, key }) => ({
      key,
      metric: await requestRouteLeg(stop, destination, key, pendingLegsRef.current),
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
      saveRouteCache(routeCacheRef.current);
      setRouteCacheVersion((version) => version + 1);
    }
    const paths = buildSharePaths(roadbook);
    const incompleteLegs = allLegs.filter(({ key }) => !isFreshCachedLeg(routeCacheRef.current.legs[key]));
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
      // 分享不再等待整本路书补算完成；先生成当前缓存快照，缺失路段后台继续预热。
      const { snapshot, missingCount } = buildShareSnapshot(activeRoadbook);
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
        const url = new URL(window.location.href);
        url.search = "";
        url.searchParams.set(SHARE_QUERY_KEY, encodeShareSnapshot(snapshot));
        url.hash = "";
        shareUrl = url.toString();
      }
      const prepareAndUpdate = async () => {
        await prepareShareData(activeRoadbook);
        if (!shareToken) return;
        const updated = buildShareSnapshot(activeRoadbook).snapshot;
        await fetch(`/api/shares?token=${encodeURIComponent(shareToken)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(updated),
          cache: "no-store",
        });
      };
      void prepareAndUpdate().catch(() => undefined);
      try {
        await navigator.clipboard.writeText(shareUrl);
        flash(missingCount ? `分享链接已复制，还有 ${missingCount} 条路线暂未记录` : "分享链接已复制，可直接粘贴发送");
      } catch {
        flash("复制失败，请检查浏览器剪贴板权限");
      }
    } finally {
      setIsPreparingShare(false);
    }
  }

  function getPrintLegMetric(from: Stop, to: Stop) {
    return routeCacheRef.current.legs[legCacheKey(from, to)];
  }

  function saveSettings(next: typeof settings) {
    if (readOnly) return;
    setSettings(next);
    window.localStorage.setItem("roadbook-amap-settings", JSON.stringify(next));
    setShowSettings(false);
    if (next.jsKey) setMapError("");
    flash("高德地图配置已保存");
  }

  const mapStops = selectedDay.stops;
  const sharedRoutePath = useMemo(() => readOnly ? sharedSnapshot?.paths?.[routeCacheKey(mapStops)] ?? [] : [], [mapStops, readOnly, sharedSnapshot]);
  const sharedMapProjection = useMemo(() => projectRoutePath(sharedRoutePath, mapStops), [mapStops, sharedRoutePath]);
  const storageStatusLabel = storageStatus === "remote" ? "已同步到云端" : storageStatus === "saving" ? "正在保存到云端" : storageStatus === "loading" ? "正在连接云端" : "云端存储未配置";

  return (
    <main className={`app-shell ${isResizing ? "is-resizing" : ""} ${readOnly ? "read-only-view" : ""}`}>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">路</div>
          <div>
            <div className="brand-name">路书 <span>ROAM NOTE</span></div>
            <div className="brand-tagline">把路上的每一个想法，排成一段好走的旅程</div>
          </div>
        </div>
        <div className="top-actions">
          {readOnly ? <div className="share-mode-label"><span>只读分享</span><small>路径 · 费用 · 时间已记录</small></div> : <><button className="library-button" type="button" onClick={() => setShowLibrary(true)}>☷ 我的路书 <span>{roadbooks.length}</span></button><button className="sync-status" type="button" onClick={saveTrip}><span className="status-dot" />{storageStatusLabel}</button><button className="map-settings-button" type="button" onClick={() => setShowSettings(true)}>配置地图</button><button className="new-roadbook-button" type="button" onClick={() => setShowLibrary(true)}>＋ 新路书</button><button className="avatar" type="button" aria-label="用户菜单">Y</button></>}
        </div>
      </header>

      <div ref={workspaceRef} className="workspace" style={{ "--editor-track": `${editorWidth}fr`, "--map-track": `${100 - editorWidth}fr` } as CSSProperties}>
        <aside className="sidebar">
          <div className="sidebar-intro">
            <div className="eyebrow">MY ROADBOOK / {String(roadbooks.findIndex((roadbook) => roadbook.id === activeRoadbookId) + 1).padStart(2, "0")}</div>
            <h1>{starterTrip.title}</h1>
            <p>{starterTrip.description}</p>
            <div className="trip-meta"><span>⌖ {starterTrip.region} · {days.length} 天</span><span>◇ {totalStops} 个地点</span></div>
          </div>

          <div className="day-list-header"><span>行程安排</span><span className="day-count">{days.length} DAYS</span></div>
          <div className="day-list">
            {days.map((day, index) => (
              <div className="day-wrap" key={day.id}>
                <button className={`day-card ${selectedDayId === day.id ? "selected" : ""}`} type="button" onClick={() => setSelectedDayId(day.id)}>
                  <span className="day-number">{String(index + 1).padStart(2, "0")}</span>
                  <span className="day-copy"><strong>{day.title}</strong><small>{day.date} · {day.stops.length} 个地点</small></span>
                  <span className="day-arrow">{selectedDayId === day.id ? "↗" : "→"}</span>
                </button>
                {!readOnly && <><div className="day-hover-actions">
                  <button type="button" onClick={() => moveDay(day.id, -1)} aria-label="提前一天">↑</button>
                  <button type="button" onClick={() => moveDay(day.id, 1)} aria-label="顺延一天">↓</button>
                  <button type="button" onClick={() => removeDay(day.id)} aria-label="删除这一天">×</button>
                </div>
                {index < days.length - 1 && <button className="insert-line" type="button" onClick={() => insertDay(day.id)}><span>＋</span> 在这里插入一天</button>}</>}
              </div>
            ))}
          </div>

          {!readOnly && <button className="add-day-button" type="button" onClick={() => insertDay(days.at(-1)?.id)}><span>＋</span> 在行程末尾添加一天</button>}
        </aside>

        <section className="editor-pane">
          <div className="editor-head">
            <div>
              <div className="crumb">{starterTrip.title} <span>/</span> 第 {days.findIndex((day) => day.id === selectedDayId) + 1} 天</div>
              <div className="title-row"><input readOnly={readOnly} aria-label="编辑当天标题" value={selectedDay.title} onChange={(event) => updateSelectedDay((day) => ({ ...day, title: event.target.value }))} /><span className="edit-hint">{readOnly ? "只读" : "↗"}</span></div>
              <input className="subtitle-input" readOnly={readOnly} aria-label="编辑当天副标题" value={selectedDay.subtitle} onChange={(event) => updateSelectedDay((day) => ({ ...day, subtitle: event.target.value }))} />
            </div>
            <div className="editor-actions">{!readOnly && <button className="ghost-button" type="button" onClick={() => setShowAddPlace(true)}>＋ 添加地点</button>}<button className="export-button" type="button" onClick={exportPdf}>↗ 导出 PDF</button>{!readOnly && <button className="share-button" type="button" disabled={isPreparingShare} onClick={() => void shareRoadbook()}>{isPreparingShare ? "准备分享数据…" : "↗ 分享路书"}</button>}{readOnly && <button className="share-button" type="button" onClick={() => void shareRoadbook()}>↗ 复制分享链接</button>}{!readOnly && <button className="primary-button" type="button" onClick={saveTrip}>保存路书 <span>⌘ S</span></button>}<a className="mobile-navigation-button" href={amapNavigationUrl(selectedDay.stops)} target="_blank" rel="noreferrer">↗ 高德导航</a></div>
          </div>

          <div className="stats-strip"><div className="date-stat"><span className="stat-label">当天日期</span><input className="departure-date" readOnly={readOnly} disabled={readOnly} type="date" value={selectedDayDateValue} aria-label="修改当天日期" onChange={(event) => updateSelectedDayDate(event.target.value)} /></div><div><span className="stat-label">总里程</span><strong>{routeDistance}</strong></div><div><span className="stat-label">预计驾驶</span><strong>{routeDuration}</strong></div><div><span className="stat-label">当日高速费</span><strong>{routeSummary ? formatTolls(routeSummary.tolls) : readOnly ? "未记录" : amapLoaded ? "计算中…" : "待获取"}</strong></div><div className="cumulative-toll-stat"><span className="stat-label">截至当前累计高速费</span><button className="cumulative-toll-button" type="button" onClick={() => setShowCumulativeTolls(true)} aria-haspopup="dialog">{cumulativeTollsComplete ? `${formatTolls(cumulativeTollsAmount)} · 查看` : readOnly ? "未记录 · 查看" : amapLoaded ? "计算中… · 查看" : "点击计算"}</button></div><div><span className="stat-label">当日路段</span><strong>{Math.max(selectedDay.stops.length - 1, 0)} 段</strong></div><div className="route-state"><span className={mapReady ? "live-dot" : ""} /> {readOnly ? (mapReady ? "高德地图已接入" : "正在加载高德地图") : mapReady ? "高德路线已接入" : "示例路线预览"}</div></div>

          <div className="stops-section">
            <div className="section-heading"><div><div className="eyebrow">DAY {String(days.findIndex((day) => day.id === selectedDayId) + 1).padStart(2, "0")} / TIMELINE</div><h2>这一天，去哪里</h2></div><span className="section-note">{readOnly ? "这是一个只读分享快照，路径、费用和时间已固定" : "拖动顺序也可以，先把想去的地方放进来"}</span></div>
            <div className="timeline">
              {selectedDay.stops.map((stop, index) => (
                <div className="stop-row" key={stop.id}>
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
                      {!readOnly && <div className="stop-tools">{stop.kind !== "出发" && <button className="set-departure-button" type="button" onClick={() => setStopAsDeparture(stop.id)} aria-label={`将${stop.name}设为出发点`}>设为出发</button>}<button type="button" onClick={() => moveStop(stop.id, -1)} aria-label="上移地点">↑</button><button type="button" onClick={() => moveStop(stop.id, 1)} aria-label="下移地点">↓</button><button type="button" onClick={() => removeStop(stop.id)} aria-label="删除地点">×</button></div>}
                    </div>
                    {index === selectedDay.stops.length - 1 && <div className="trip-total-summary"><span>总时长</span><strong>{routeSummary ? formatDuration(routeSummary.duration) : readOnly ? "未记录" : mapReady ? "正在计算…" : "待连接高德"}</strong>{routeSummary && <span className="toll-summary">高速费 {formatTolls(routeSummary.tolls)}</span>}{days.at(-1)?.id === selectedDay.id && <span className="toll-summary total-toll-summary">全程高速费 {allRoadbookTolls.complete ? formatTolls(allRoadbookTolls.amount) : readOnly ? "未记录" : amapLoaded ? "计算中…" : "待获取"}</span>}</div>}
                    {!readOnly && editingNoteStopId === stop.id && <div className="stop-note-editor"><textarea value={noteDraft} maxLength={200} autoFocus aria-label={`编辑${stop.name}备注`} placeholder="写下这个途经点的提醒，例如：补能、吃饭或拍照" onChange={(event) => setNoteDraft(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") saveStopNote(stop.id); if (event.key === "Escape") cancelNoteEdit(); }} /><div className="stop-note-actions"><small>{noteDraft.length}/200 · ⌘↵ 保存</small><div><button type="button" onClick={cancelNoteEdit}>取消</button><button className="save-note-button" type="button" onClick={() => saveStopNote(stop.id)}>保存备注</button></div></div></div>}
                    {!readOnly && editingNoteStopId !== stop.id && <div className={`stop-note ${stop.note ? "has-note" : "empty-note"}`}><span>✦</span>{stop.note ? <><span className="note-text">{stop.note}</span><button type="button" onClick={() => startNoteEdit(stop)}>编辑</button></> : <button type="button" onClick={() => startNoteEdit(stop)}>添加备注</button>}</div>}
                    {readOnly && stop.note && <div className="stop-note has-note"><span>✦</span><span className="note-text">{stop.note}</span></div>}
                  </div>
                </div>
              ))}
            </div>
            {!readOnly && <button className="inline-add" type="button" onClick={() => setShowAddPlace(true)}>＋ 在这一天添加一个地点</button>}
          </div>
        </section>

        <div className={`split-divider ${isResizing ? "dragging" : ""}`} role="separator" aria-orientation="vertical" aria-label="调整编辑区和地图宽度" aria-valuemin={32} aria-valuemax={68} aria-valuenow={Math.round(editorWidth)} onPointerDown={startResize} onPointerMove={(event) => isResizing && updateEditorWidth(event.clientX)} onPointerUp={finishResize} onPointerCancel={finishResize}><span>⋮</span></div>

        <section className="map-panel">
          <div className="map-topbar"><div><span className="map-label">LIVE MAP / AMAP</span><strong>{selectedDay.title}</strong></div>{!readOnly && <button className="map-control" type="button" onClick={() => setShowSettings(true)}>{settings.jsKey ? "已连接" : "连接高德"} <span>↗</span></button>}</div>
          <div className={`map-wrap ${mapReady ? "has-amap" : ""}`}>
            <div className="map-fallback" aria-label="路线示意图">
              <div className="map-grid" />
              <div className="map-river" />
              <div className="map-mountain mountain-one" /><div className="map-mountain mountain-two" />
              {!sharedRoutePath.length && <div className="route-line" />}
              {sharedRoutePath.length > 1 && <svg className="snapshot-route" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="分享前记录的路线"><polyline points={sharedMapProjection.line} /></svg>}
              {mapStops.map((stop, index) => { const point = sharedRoutePath.length > 1 ? sharedMapProjection.markers[index] : { x: 18 + (index * 29), y: 66 - (index * 17) }; return <div key={stop.id} className="fallback-marker" style={{ left: `${point.x}%`, top: `${point.y}%` }}><span>{index + 1}</span><label>{stop.name}</label></div>; })}
              <div className="map-coordinates"><span>30°03′N</span><span>101°58′E</span></div>
              <div className="map-compass">N<br /><span>✦</span></div>
              {!settings.jsKey && <div className="map-message"><span className="map-message-icon">⌖</span><strong>接入高德地图，查看真实路线</strong><p>当前分享页暂时无法加载高德地图底图。</p>{!readOnly && <button type="button" onClick={() => setShowSettings(true)}>去设置 Key <span>→</span></button>}</div>}
            </div>
            <div className="map-host" ref={mapContainer} />
          </div>
          <div className="map-bottom"><div className="legend"><span><i className="legend-dot orange" />行程地点</span><span><i className="legend-dot green" />住宿</span></div><a href={amapNavigationUrl(selectedDay.stops)} target="_blank" rel="noreferrer">在高德中导航 ↗</a></div>
        </section>
      </div>

      <div className="print-only roadbook-print">
        <div className="print-cover"><div className="print-mark">路</div><div className="eyebrow">ROAM NOTE / ROADBOOK</div><h1>{starterTrip.title}</h1><p>{starterTrip.description}</p><div className="print-summary">{starterTrip.region} · {days.length} 天 · {totalStops} 个地点</div></div>
        {days.map((day, dayIndex) => {
          const metrics = day.stops.slice(0, -1).map((stop, stopIndex) => getPrintLegMetric(stop, day.stops[stopIndex + 1]));
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
      </div>

      {showLibrary && <RoadbookLibraryModal roadbooks={roadbooks} activeRoadbookId={activeRoadbookId} onClose={() => setShowLibrary(false)} onSelect={openRoadbook} onCreate={createRoadbook} />}
      {showAddPlace && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowAddPlace(false)}><div className="modal-card add-modal"><div className="modal-head"><div><span className="eyebrow">ADD A PLACE</span><h2>把想去的地方放进来</h2></div><button type="button" className="modal-close" onClick={() => setShowAddPlace(false)}>×</button></div><div className="search-box"><span>⌕</span><input value={query} placeholder="搜索景点、餐厅或酒店" onChange={(event) => { setQuery(event.target.value); schedulePlaceSearch(event.target.value); }} onKeyDown={(event) => event.key === "Enter" && (event.preventDefault(), searchPlacesImmediately(event.currentTarget.value))} /><button type="button" onClick={() => searchPlacesImmediately()}>搜索</button></div><div className="search-results">{searchResults.length ? searchResults.map((result) => <button className="search-result" type="button" key={result.id} onClick={() => addSearchResult(result)}><span className="result-pin">⌖</span><span><strong>{result.name}</strong><small>{result.address} · {result.type}</small></span><span className="result-add">＋</span></button>) : <div className="empty-results"><span>⌖</span><p>{query ? "正在等待搜索结果，或按回车立即搜索" : "搜索一个地点，加入第 " + (days.findIndex((day) => day.id === selectedDayId) + 1) + " 天"}</p></div>}</div><div className="modal-foot">提示：搜索会在停止输入约 400ms 后自动执行；优先使用高德 Web 服务搜索。</div></div></div>}

      {showCumulativeTolls && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowCumulativeTolls(false)}><div className="modal-card cumulative-tolls-modal" role="dialog" aria-modal="true" aria-labelledby="cumulative-tolls-title"><div className="modal-head"><div><span className="eyebrow">TOLL CALCULATOR</span><h2 id="cumulative-tolls-title">截至第 {selectedDayIndex + 1} 天</h2></div><button type="button" className="modal-close" onClick={() => setShowCumulativeTolls(false)} aria-label="关闭累计高速费">×</button></div><p className="cumulative-tolls-lead">从 {days[0]?.date ?? "出发日"} 出发，累计计算到 {selectedDay.date} 的所有行程高速费。</p><div className="cumulative-tolls-total"><span>累计高速费</span><strong>{cumulativeTollsComplete ? formatTolls(cumulativeTollsAmount) : readOnly ? "未记录" : amapLoaded ? "正在计算…" : "待获取"}</strong></div><div className="cumulative-tolls-list">{cumulativeTollDays.map(({ day, complete, amount }, index) => <div className="cumulative-toll-row" key={day.id}><div><strong>第 {index + 1} 天 · {day.date}</strong><small>{day.title}</small></div><span>{complete ? formatTolls(amount) : readOnly ? "未记录" : amapLoaded ? "计算中…" : "待获取"}</span></div>)}</div>{!cumulativeTollsComplete && !readOnly && !amapLoaded && <div className="modal-foot">请先连接高德地图，路线规划完成后再次打开这里即可看到累计高速费。</div>}<div className="modal-actions"><button className="primary-button" type="button" onClick={() => setShowCumulativeTolls(false)}>知道了 <span>→</span></button></div></div></div>}

      {showSettings && <SettingsModal settings={settings} onClose={() => setShowSettings(false)} onSave={saveSettings} />}
      {showToast && <div className="toast"><span>✓</span>{showToast}</div>}
      {mapError && <button className="map-error" type="button" onClick={() => setMapError("")}>{mapError} <span>×</span></button>}
    </main>
  );
}

function RoadbookLibraryModal({ roadbooks, activeRoadbookId, onClose, onSelect, onCreate }: { roadbooks: Roadbook[]; activeRoadbookId: string; onClose: () => void; onSelect: (id: string) => void; onCreate: (title: string, description: string) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal-card library-modal"><div className="modal-head"><div><span className="eyebrow">MY ROADBOOKS</span><h2>我的路书</h2></div><button type="button" className="modal-close" onClick={onClose}>×</button></div><div className="roadbook-list">{roadbooks.map((roadbook) => <button className={`roadbook-item ${roadbook.id === activeRoadbookId ? "active" : ""}`} type="button" key={roadbook.id} onClick={() => onSelect(roadbook.id)}><span className="roadbook-icon">⌁</span><span className="roadbook-item-copy"><strong>{roadbook.title}</strong><small>{roadbook.region} · {roadbook.days.length} 天 · {roadbook.days.reduce((sum, day) => sum + day.stops.length, 0)} 个地点</small></span><span className="roadbook-item-arrow">{roadbook.id === activeRoadbookId ? "当前" : "打开 →"}</span></button>)}</div><div className="new-roadbook-form"><div className="form-title"><span>＋</span><strong>创建一条新路书</strong></div><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="路书名称，例如：滇西环线" /><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="一句话描述（可选）" /><button className="primary-button" type="button" onClick={() => onCreate(title, description)}>创建并开始编辑 <span>→</span></button></div><div className="modal-foot">每条路书独立保存，之后可以随时切换，不会覆盖其他行程。</div></div></div>;
}

function SettingsModal({ settings, onClose, onSave }: { settings: { jsKey: string; securityCode: string; webKey: string }; onClose: () => void; onSave: (settings: { jsKey: string; securityCode: string; webKey: string }) => void }) {
  const [draft, setDraft] = useState(settings);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal-card settings-modal"><div className="modal-head"><div><span className="eyebrow">AMAP CONNECTION</span><h2>连接你的高德服务</h2></div><button type="button" className="modal-close" onClick={onClose}>×</button></div><p className="settings-lead">Key 只会保存在当前浏览器。公开部署时，建议把 Web 服务 Key 改放到 Cloudflare Worker 的环境变量中。</p><label>Web 端（JS API）Key<input value={draft.jsKey} onChange={(event) => setDraft({ ...draft, jsKey: event.target.value })} placeholder="请输入 JS API Key" /></label><label>安全密钥 securityJsCode<input type="password" value={draft.securityCode} onChange={(event) => setDraft({ ...draft, securityCode: event.target.value })} placeholder="请输入安全密钥" /></label><label>Web 服务 Key <span className="optional">路线与搜索服务（可选）</span><input value={draft.webKey} onChange={(event) => setDraft({ ...draft, webKey: event.target.value })} placeholder="请输入 Web 服务 Key" /></label><div className="settings-warning"><span>!</span><span>不要把 Key 提交到公开 Git 仓库。JS API 安全密钥在生产环境应通过后端代理转发。</span></div><div className="modal-actions"><button className="ghost-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={() => onSave(draft)}>保存并连接 <span>→</span></button></div></div></div>;
}
