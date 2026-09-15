export type MergeStop = {
  id: string;
  name: string;
  area: string;
  kind: string;
  lat: number;
  lng: number;
  duration: string;
  stayMinutes?: number;
  note?: string;
};

export type MergeDay = {
  id: string;
  date: string;
  title: string;
  subtitle: string;
  stops: MergeStop[];
};

export type MergeRoadbook = {
  id: string;
  title: string;
  description: string;
  region: string;
  updated: string;
  startDate?: string;
  days: MergeDay[];
};

function byId<T extends { id: string }>(items: T[]) {
  return new Map(items.map((item) => [item.id, item]));
}

function mergeStop(local: MergeStop, remote: MergeStop): MergeStop {
  return {
    ...remote,
    name: local.name,
    area: local.area,
    kind: local.kind,
    lat: local.lat,
    lng: local.lng,
    duration: local.duration,
    ...(local.stayMinutes != null ? { stayMinutes: local.stayMinutes } : remote.stayMinutes != null ? { stayMinutes: remote.stayMinutes } : {}),
    ...(local.note?.trim() ? { note: local.note } : remote.note?.trim() ? { note: remote.note } : {}),
  };
}

function mergeOrdered<T extends { id: string }>(
  localItems: T[],
  remoteItems: T[],
  mergeItem: (local: T, remote: T) => T,
  baselineItems?: T[],
) {
  const localIds = new Set(localItems.map((item) => item.id));
  const knownIds = baselineItems ? new Set(baselineItems.map((item) => item.id)) : null;
  const remoteById = byId(remoteItems);
  const extras: Array<{ item: T; anchor: string | null }> = [];
  remoteItems.forEach((item, index) => {
    if (localIds.has(item.id)) return;
    // 基线里有、本机没有：用户未保存的删除，不要当成云端新增插回。
    if (knownIds?.has(item.id)) return;
    let anchor: string | null = null;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (localIds.has(remoteItems[cursor].id)) {
        anchor = remoteItems[cursor].id;
        break;
      }
    }
    extras.push({ item, anchor });
  });

  const result: T[] = [];
  const placed = new Set<string>();
  const flush = (anchor: string | null) => {
    for (const extra of extras) {
      if (extra.anchor !== anchor || placed.has(extra.item.id)) continue;
      result.push(extra.item);
      placed.add(extra.item.id);
    }
  };

  flush(null);
  for (const local of localItems) {
    const remote = remoteById.get(local.id);
    result.push(remote ? mergeItem(local, remote) : local);
    placed.add(local.id);
    flush(local.id);
  }
  return result;
}

function mergeDay(local: MergeDay, remote: MergeDay, baseline?: MergeDay): MergeDay {
  return {
    ...remote,
    date: local.date,
    title: local.title,
    subtitle: local.subtitle,
    stops: mergeOrdered(local.stops, remote.stops, mergeStop, baseline?.stops),
  };
}

function mergeRoadbook(local: MergeRoadbook, remote: MergeRoadbook, baseline?: MergeRoadbook): MergeRoadbook {
  const baselineDays = baseline ? byId(baseline.days) : undefined;
  return {
    ...remote,
    title: local.title,
    description: local.description,
    region: local.region,
    ...(local.startDate ? { startDate: local.startDate } : remote.startDate ? { startDate: remote.startDate } : {}),
    days: mergeOrdered(local.days, remote.days, (localDay, remoteDay) => mergeDay(localDay, remoteDay, baselineDays?.get(localDay.id)), baseline?.days),
  };
}

export function mergeRoadbookLibraries<T extends MergeRoadbook>(local: T[], remote: T[], baseline?: T[]): T[] {
  const baselineBooks = baseline ? byId(baseline) : undefined;
  return mergeOrdered(
    local,
    remote,
    (localBook, remoteBook) => mergeRoadbook(localBook, remoteBook, baselineBooks?.get(localBook.id)) as T,
    baseline,
  );
}

function stopFields(stop: MergeStop) {
  return JSON.stringify({
    name: stop.name,
    area: stop.area,
    kind: stop.kind,
    lat: stop.lat,
    lng: stop.lng,
    duration: stop.duration,
    stayMinutes: stop.stayMinutes ?? null,
    note: stop.note?.trim() ?? "",
  });
}

function sharedOrderDiffers<T extends { id: string }>(localItems: T[], remoteItems: T[]) {
  const remoteIds = new Set(remoteItems.map((item) => item.id));
  const localIds = new Set(localItems.map((item) => item.id));
  const localShared = localItems.map((item) => item.id).filter((id) => remoteIds.has(id));
  const remoteShared = remoteItems.map((item) => item.id).filter((id) => localIds.has(id));
  return localShared.join("\0") !== remoteShared.join("\0");
}

function hasLocalDeletes<T extends { id: string }>(localItems: T[], remoteItems: T[], baselineItems?: T[]) {
  if (!baselineItems?.length) return false;
  const localIds = new Set(localItems.map((item) => item.id));
  const remoteIds = new Set(remoteItems.map((item) => item.id));
  return baselineItems.some((item) => remoteIds.has(item.id) && !localIds.has(item.id));
}

export function localLibraryHasUnsyncedEdits(local: MergeRoadbook[], remote: MergeRoadbook[], baseline?: MergeRoadbook[]) {
  if (hasLocalDeletes(local, remote, baseline)) return true;
  const remoteBooks = byId(remote);
  const baselineBooks = baseline ? byId(baseline) : undefined;
  if (sharedOrderDiffers(local, remote)) return true;
  for (const book of local) {
    const remoteBook = remoteBooks.get(book.id);
    if (!remoteBook) return true;
    const baselineBook = baselineBooks?.get(book.id);
    if (book.title !== remoteBook.title || book.description !== remoteBook.description || book.region !== remoteBook.region) return true;
    if ((book.startDate ?? "") !== (remoteBook.startDate ?? "")) return true;
    if (sharedOrderDiffers(book.days, remoteBook.days) || hasLocalDeletes(book.days, remoteBook.days, baselineBook?.days)) return true;
    const remoteDays = byId(remoteBook.days);
    const baselineDays = baselineBook ? byId(baselineBook.days) : undefined;
    for (const day of book.days) {
      const remoteDay = remoteDays.get(day.id);
      if (!remoteDay) return true;
      if (day.date !== remoteDay.date || day.title !== remoteDay.title || day.subtitle !== remoteDay.subtitle) return true;
      const baselineDay = baselineDays?.get(day.id);
      if (sharedOrderDiffers(day.stops, remoteDay.stops) || hasLocalDeletes(day.stops, remoteDay.stops, baselineDay?.stops)) return true;
      const remoteStops = byId(remoteDay.stops);
      for (const stop of day.stops) {
        const remoteStop = remoteStops.get(stop.id);
        if (!remoteStop) return true;
        if (stopFields(stop) !== stopFields(remoteStop)) return true;
      }
    }
  }
  return false;
}
