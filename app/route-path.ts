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
  return paths.reduce<RoutePathPoint[]>((combined, path) => [
    ...combined,
    ...(combined.length ? path!.slice(1) : path!),
  ], []);
}
