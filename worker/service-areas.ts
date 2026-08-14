export type RoutePoint = [number, number];

export type RouteServiceArea = {
  id?: string;
  name: string;
  address: string;
  type: string;
  lng: number;
  lat: number;
  distanceFromStart: number;
  distanceToRoute: number;
};

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function parsePolyline(value: unknown) {
  if (typeof value !== "string") return [] as RoutePoint[];
  return value.split(";").flatMap((point) => {
    const [lng, lat] = point.split(",").map(Number);
    return Number.isFinite(lng) && Number.isFinite(lat) ? [[lng, lat] as RoutePoint] : [];
  });
}

function routeStepText(step: Record<string, unknown>) {
  const cost = step.cost && typeof step.cost === "object" ? step.cost as Record<string, unknown> : {};
  return [step.road_name, step.instruction, step.assistant_action, cost.toll_road].map(stringValue).join(" ");
}

function isHighwayText(value: string) {
  return /高速|expressway/i.test(value);
}

export function extractHighwayPath(payload: unknown) {
  if (!payload || typeof payload !== "object") return [] as RoutePoint[];
  const route = (payload as { route?: unknown }).route;
  if (!route || typeof route !== "object") return [] as RoutePoint[];
  const paths = (route as { paths?: unknown }).paths;
  if (!Array.isArray(paths) || !paths.length || !paths[0] || typeof paths[0] !== "object") return [] as RoutePoint[];
  const path = paths[0] as Record<string, unknown>;
  const steps = Array.isArray(path.steps) ? path.steps.filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === "object") : [];
  const highwaySteps = steps.filter((step) => isHighwayText(routeStepText(step)));
  if (highwaySteps.length) return highwaySteps.flatMap((step) => parsePolyline(step.polyline));

  const pathCost = path.cost && typeof path.cost === "object" ? path.cost as Record<string, unknown> : {};
  return isHighwayText(stringValue(pathCost.toll_road)) ? steps.flatMap((step) => parsePolyline(step.polyline)) : [];
}

function haversineDistance(from: RoutePoint, to: RoutePoint) {
  const earthRadius = 6_371_000;
  const toRadians = (degrees: number) => degrees * Math.PI / 180;
  const deltaLat = toRadians(to[1] - from[1]);
  const deltaLng = toRadians(to[0] - from[0]);
  const fromLat = toRadians(from[1]);
  const toLat = toRadians(to[1]);
  const value = Math.sin(deltaLat / 2) ** 2 + Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(value)));
}

function cumulativeDistances(path: RoutePoint[]) {
  const distances = [0];
  for (let index = 1; index < path.length; index += 1) {
    distances.push(distances[index - 1] + haversineDistance(path[index - 1], path[index]));
  }
  return distances;
}

function nearestPointOnSegment(point: RoutePoint, start: RoutePoint, end: RoutePoint) {
  const latitudeScale = 111_320;
  const longitudeScale = latitudeScale * Math.cos(((start[1] + end[1] + point[1]) / 3) * Math.PI / 180);
  const pointX = (point[0] - start[0]) * longitudeScale;
  const pointY = (point[1] - start[1]) * latitudeScale;
  const endX = (end[0] - start[0]) * longitudeScale;
  const endY = (end[1] - start[1]) * latitudeScale;
  const squaredLength = endX ** 2 + endY ** 2;
  const ratio = squaredLength > 0 ? Math.max(0, Math.min(1, (pointX * endX + pointY * endY) / squaredLength)) : 0;
  const projected: RoutePoint = [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio];
  return { distance: haversineDistance(point, projected), ratio };
}

export function sampleRouteSearchPoints(path: RoutePoint[], maxPoints = 10) {
  if (path.length < 2) return [] as RoutePoint[];
  const distances = cumulativeDistances(path);
  const total = distances.at(-1) ?? 0;
  if (total <= 0) return [path[Math.floor(path.length / 2)]];
  const spacing = Math.max(70_000, total / maxPoints);
  const targets: number[] = [];
  for (let target = Math.min(spacing / 2, total / 2); target < total; target += spacing) targets.push(target);
  if (!targets.length) targets.push(total / 2);
  return targets.slice(0, maxPoints).map((target) => {
    let index = 1;
    while (index < distances.length && distances[index] < target) index += 1;
    const beforeDistance = distances[index - 1] ?? 0;
    const afterDistance = distances[index] ?? beforeDistance;
    const ratio = afterDistance > beforeDistance ? (target - beforeDistance) / (afterDistance - beforeDistance) : 0;
    const before = path[index - 1] ?? path[0];
    const after = path[index] ?? before;
    return [before[0] + (after[0] - before[0]) * ratio, before[1] + (after[1] - before[1]) * ratio] as RoutePoint;
  });
}

function normalizePoi(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const poi = value as Record<string, unknown>;
  const name = stringValue(poi.name);
  const location = stringValue(poi.location);
  const [lng, lat] = location.split(",").map(Number);
  if (!name || !/(服务区|停车区)/.test(name) || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const addressValue = stringValue(poi.address);
  const address = addressValue || [poi.pname, poi.cityname, poi.adname].map(stringValue).filter(Boolean).join(" · ") || "高德沿途服务区";
  return { id: stringValue(poi.id) || undefined, name, address, type: stringValue(poi.type) || "道路附属设施", lng, lat };
}

export function rankRouteServiceAreas(rawPois: unknown[], highwayPath: RoutePoint[], maxDistanceToRoute = 5_000) {
  if (highwayPath.length < 2) return [] as RouteServiceArea[];
  const routeDistances = cumulativeDistances(highwayPath);
  const deduplicated = new Map<string, RouteServiceArea>();
  rawPois.forEach((value) => {
    const poi = normalizePoi(value);
    if (!poi) return;
    const point: RoutePoint = [poi.lng, poi.lat];
    let distanceToRoute = Number.POSITIVE_INFINITY;
    let distanceFromStart = 0;
    for (let index = 1; index < highwayPath.length; index += 1) {
      const nearest = nearestPointOnSegment(point, highwayPath[index - 1], highwayPath[index]);
      if (nearest.distance < distanceToRoute) {
        distanceToRoute = nearest.distance;
        distanceFromStart = (routeDistances[index - 1] ?? 0) + ((routeDistances[index] ?? 0) - (routeDistances[index - 1] ?? 0)) * nearest.ratio;
      }
    }
    if (distanceToRoute > maxDistanceToRoute) return;
    const serviceArea: RouteServiceArea = {
      ...poi,
      distanceFromStart: Math.round(distanceFromStart),
      distanceToRoute: Math.round(distanceToRoute),
    };
    const key = poi.id || `${poi.name}@${poi.lng.toFixed(4)},${poi.lat.toFixed(4)}`;
    const existing = deduplicated.get(key);
    if (!existing || serviceArea.distanceToRoute < existing.distanceToRoute) deduplicated.set(key, serviceArea);
  });
  return [...deduplicated.values()].sort((left, right) => left.distanceFromStart - right.distanceFromStart).slice(0, 24);
}
