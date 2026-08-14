export type RankedAmapPoi = {
  id?: string;
  name: string;
  address?: string;
  location: string;
  type?: string;
  pname?: string;
  cityname?: string;
  adname?: string;
  distance?: number;
  _sourcePriority?: number;
};

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function normalizeSearchText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function normalizeLocation(value: unknown) {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const [lng, lat] = raw.split(",").map(Number);
  return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90
    ? `${lng},${lat}`
    : undefined;
}

function normalizePoi(value: unknown, sourcePriority: number): RankedAmapPoi | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const name = stringValue(candidate.name);
  const location = normalizeLocation(candidate.location);
  if (!name || !location) return null;
  return {
    id: stringValue(candidate.id),
    name,
    address: stringValue(candidate.address),
    location,
    type: stringValue(candidate.type),
    pname: stringValue(candidate.pname),
    cityname: stringValue(candidate.cityname),
    adname: stringValue(candidate.adname),
    distance: numberValue(candidate.distance),
    _sourcePriority: sourcePriority,
  };
}

export function inputTipsToPois(payload: unknown) {
  if (!payload || typeof payload !== "object") return [] as RankedAmapPoi[];
  const tips = (payload as { tips?: unknown }).tips;
  if (!Array.isArray(tips)) return [] as RankedAmapPoi[];
  return tips.flatMap((tip) => {
    if (!tip || typeof tip !== "object") return [];
    const candidate = tip as Record<string, unknown>;
    const district = stringValue(candidate.district);
    const address = stringValue(candidate.address);
    return normalizePoi({ ...candidate, address: [district, address].filter(Boolean).join(" · ") }, 3) ?? [];
  });
}

function poiNameScore(name: string, keyword: string) {
  const normalizedName = normalizeSearchText(name);
  const normalizedKeyword = normalizeSearchText(keyword);
  if (!normalizedName || !normalizedKeyword) return 0;
  if (normalizedName === normalizedKeyword) return 100_000;
  if (normalizedName.startsWith(normalizedKeyword)) return 82_000 - Math.min(normalizedName.length - normalizedKeyword.length, 1_000);
  if (normalizedName.includes(normalizedKeyword)) return 72_000 - Math.min(normalizedName.length - normalizedKeyword.length, 1_000);
  if (normalizedKeyword.includes(normalizedName)) return 58_000 - Math.min(normalizedKeyword.length - normalizedName.length, 1_000);

  const keywordCharacters = new Set(normalizedKeyword);
  const sharedCharacters = new Set([...normalizedName].filter((character) => keywordCharacters.has(character)));
  const overlap = sharedCharacters.size / keywordCharacters.size;
  return Math.round(overlap * 12_000) + (normalizedName[0] === normalizedKeyword[0] ? 1_500 : 0);
}

function poiIdentity(poi: RankedAmapPoi) {
  return poi.id || `${normalizeSearchText(poi.name)}@${poi.location}`;
}

export function rankAmapPois(
  batches: Array<{ pois: unknown[]; sourcePriority: number }>,
  keyword: string,
  limit = 30,
) {
  const merged = new Map<string, RankedAmapPoi>();
  batches.forEach(({ pois, sourcePriority }) => {
    pois.forEach((value) => {
      const poi = normalizePoi(value, sourcePriority);
      if (!poi) return;
      const key = poiIdentity(poi);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, poi);
        return;
      }
      const distances = [existing.distance, poi.distance].filter((distance): distance is number => typeof distance === "number" && Number.isFinite(distance));
      merged.set(key, {
        ...existing,
        ...poi,
        address: poi.address || existing.address,
        type: poi.type || existing.type,
        distance: distances.length ? Math.min(...distances) : undefined,
        _sourcePriority: Math.max(existing._sourcePriority ?? 0, poi._sourcePriority ?? 0),
      });
    });
  });

  return [...merged.values()]
    .sort((left, right) => {
      const leftScore = poiNameScore(left.name, keyword) + (left._sourcePriority ?? 0) * 1_000 - Math.min(left.distance ?? 50_000, 50_000) / 100;
      const rightScore = poiNameScore(right.name, keyword) + (right._sourcePriority ?? 0) * 1_000 - Math.min(right.distance ?? 50_000, 50_000) / 100;
      return rightScore - leftScore;
    })
    .slice(0, limit)
    .map((poi) => {
      const publicPoi = { ...poi };
      delete publicPoi._sourcePriority;
      return publicPoi;
    });
}
