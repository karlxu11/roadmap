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

function mergeStops(localStops: MergeStop[], remoteStops: MergeStop[]) {
  const localById = byId(localStops);
  const merged: MergeStop[] = remoteStops.map((remote) => {
    const local = localById.get(remote.id);
    return local ? mergeStop(local, remote) : remote;
  });
  const mergedIds = new Set(merged.map((stop) => stop.id));

  localStops.forEach((stop, index) => {
    if (mergedIds.has(stop.id)) return;
    let insertAt = -1;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const neighbor = merged.findIndex((item) => item.id === localStops[cursor].id);
      if (neighbor >= 0) {
        insertAt = neighbor + 1;
        break;
      }
    }
    if (insertAt < 0) insertAt = merged[0] ? 1 : 0;
    merged.splice(insertAt, 0, stop);
    mergedIds.add(stop.id);
  });
  return merged;
}

function mergeDay(local: MergeDay | undefined, remote: MergeDay): MergeDay {
  if (!local) return remote;
  return {
    ...remote,
    date: local.date,
    title: local.title,
    subtitle: local.subtitle,
    stops: mergeStops(local.stops, remote.stops),
  };
}

function mergeRoadbook(local: MergeRoadbook | undefined, remote: MergeRoadbook): MergeRoadbook {
  if (!local) return remote;
  const localDays = byId(local.days);
  const days = remote.days.map((day) => mergeDay(localDays.get(day.id), day));
  const remoteDayIds = new Set(remote.days.map((day) => day.id));
  for (const day of local.days) {
    if (!remoteDayIds.has(day.id)) days.push(day);
  }
  return {
    ...remote,
    title: local.title,
    description: local.description,
    region: local.region,
    ...(local.startDate ? { startDate: local.startDate } : remote.startDate ? { startDate: remote.startDate } : {}),
    days,
  };
}

export function mergeRoadbookLibraries<T extends MergeRoadbook>(local: T[], remote: T[]): T[] {
  const localById = byId(local);
  const merged = remote.map((book) => mergeRoadbook(localById.get(book.id), book) as T);
  const remoteIds = new Set(remote.map((book) => book.id));
  for (const book of local) {
    if (!remoteIds.has(book.id)) merged.push(book);
  }
  return merged;
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

export function localLibraryHasUnsyncedEdits(local: MergeRoadbook[], remote: MergeRoadbook[]) {
  const remoteBooks = byId(remote);
  for (const book of local) {
    const remoteBook = remoteBooks.get(book.id);
    if (!remoteBook) return true;
    if (book.title !== remoteBook.title || book.description !== remoteBook.description || book.region !== remoteBook.region) return true;
    if ((book.startDate ?? "") !== (remoteBook.startDate ?? "")) return true;
    const remoteDays = byId(remoteBook.days);
    for (const day of book.days) {
      const remoteDay = remoteDays.get(day.id);
      if (!remoteDay) return true;
      if (day.date !== remoteDay.date || day.title !== remoteDay.title || day.subtitle !== remoteDay.subtitle) return true;
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
