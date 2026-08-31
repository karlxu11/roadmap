export type RoutePathPoint = [number, number];

export function normalizeRoutePath(value: unknown) {
  if (!Array.isArray(value)) return [] as RoutePathPoint[];
  return value.filter((point): point is RoutePathPoint => Array.isArray(point)
    && point.length >= 2
    && Number.isFinite(point[0])
    && Number.isFinite(point[1]));
}

export function hasDrawableRoutePath(path: RoutePathPoint[] | undefined) {
  return Boolean(path && path.length >= 2);
}

export function combineRoutePaths(paths: Array<RoutePathPoint[] | undefined>) {
  if (!paths.length || paths.some((path) => !hasDrawableRoutePath(path))) return [] as RoutePathPoint[];
  const combined: RoutePathPoint[] = [];
  paths.forEach((path) => {
    const startIndex = combined.length ? 1 : 0;
    for (let index = startIndex; index < path!.length; index += 1) combined.push(path![index]);
  });
  return combined;
}
