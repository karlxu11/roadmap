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

function mergeOrdered<T extends { id: string }>(localItems: T[], remoteItems: T[], mergeItem: (local: T, remote: T) => T) {
  const localIds = new Set(localItems.map((item) => item.id));
  const remoteById = byId(remoteItems);
  const extras: Array<{ item: T; anchor: string | null }> = [];
  remoteItems.forEach((item, index) => {
    if (localIds.has(item.id)) return;
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

function mergeDay(local: MergeDay, remote: MergeDay): MergeDay {
  return {
    ...remote,
    date: local.date,
    title: local.title,
    subtitle: local.subtitle,
    stops: mergeOrdered(local.stops, remote.stops, mergeStop),
  };
}

function mergeRoadbook(local: MergeRoadbook, remote: MergeRoadbook): MergeRoadbook {
  return {
    ...remote,
    title: local.title,
    description: local.description,
    region: local.region,
    ...(local.startDate ? { startDate: local.startDate } : remote.startDate ? { startDate: remote.startDate } : {}),
    days: mergeOrdered(local.days, remote.days, mergeDay),
  };
}

export function mergeRoadbookLibraries<T extends MergeRoadbook>(local: T[], remote: T[]): T[] {
  return mergeOrdered(local, remote, (localBook, remoteBook) => mergeRoadbook(localBook, remoteBook) as T);
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

export function localLibraryHasUnsyncedEdits(local: MergeRoadbook[], remote: MergeRoadbook[]) {
  const remoteBooks = byId(remote);
  if (sharedOrderDiffers(local, remote)) return true;
  for (const book of local) {
    const remoteBook = remoteBooks.get(book.id);
    if (!remoteBook) return true;
    if (book.title !== remoteBook.title || book.description !== remoteBook.description || book.region !== remoteBook.region) return true;
    if ((book.startDate ?? "") !== (remoteBook.startDate ?? "")) return true;
    if (sharedOrderDiffers(book.days, remoteBook.days)) return true;
    const remoteDays = byId(remoteBook.days);
    for (const day of book.days) {
      const remoteDay = remoteDays.get(day.id);
      if (!remoteDay) return true;
      if (day.date !== remoteDay.date || day.title !== remoteDay.title || day.subtitle !== remoteDay.subtitle) return true;
      if (sharedOrderDiffers(day.stops, remoteDay.stops)) return true;
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
