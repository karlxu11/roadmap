import assert from "node:assert/strict";
import test from "node:test";
import { localLibraryHasUnsyncedEdits, mergeRoadbookLibraries, resolveHydratedRoadbooks } from "../app/merge-roadbooks.ts";

function stop(id, name, extra = {}) {
  return { id, name, area: "云南", kind: "景点", lat: 26, lng: 99, duration: "顺路打卡", ...extra };
}

function day(id, stops, extra = {}) {
  return { id, date: "10 月 2 日", title: "丙中洛 → 泸水", subtitle: "怒江往南", stops, ...extra };
}

function book(id, days, extra = {}) {
  return { id, title: "13天", description: "梅里", region: "滇西", updated: "刚刚更新", days, ...extra };
}

test("pulls cloud-only scenic stops into a stale local draft", () => {
  const local = [book("rb-13", [day("day-8", [
    stop("s-start", "丙中洛观景台", { kind: "出发", duration: "09:00 出发" }),
    stop("s-moon", "石月亮观景台", { kind: "途经", duration: "顺路停靠" }),
    stop("s-hotel", "泸水市", { kind: "住宿", duration: "待安排" }),
  ])])];
  const remote = [book("rb-13", [day("day-8", [
    stop("s-start", "丙中洛观景台", { kind: "出发", duration: "09:00 出发" }),
    stop("s-moon", "石月亮观景台", { kind: "途经", duration: "顺路停靠" }),
    stop("s-church", "老姆登基督教堂"),
    stop("s-zhiziluo", "知子罗"),
    stop("s-hotel", "泸水市", { kind: "住宿", duration: "待安排" }),
  ])])];

  const merged = mergeRoadbookLibraries(local, remote, local);
  assert.deepEqual(merged[0].days[0].stops.map((item) => item.name), [
    "丙中洛观景台",
    "石月亮观景台",
    "老姆登基督教堂",
    "知子罗",
    "泸水市",
  ]);
  assert.equal(localLibraryHasUnsyncedEdits(local, remote, local), false);
});

test("first upgrade of a dirty draft without a synced baseline keeps local deletes", () => {
  const local = [book("rb-13", [day("day-8", [
    stop("s-start", "丙中洛观景台"),
    stop("s-hotel", "泸水市"),
  ])])];
  const remote = [book("rb-13", [day("day-8", [
    stop("s-start", "丙中洛观景台"),
    stop("s-moon", "石月亮观景台"),
    stop("s-church", "老姆登基督教堂"),
    stop("s-hotel", "泸水市"),
  ])])];

  const hydrated = resolveHydratedRoadbooks(true, local, remote);
  assert.deepEqual(hydrated.roadbooks[0].days[0].stops.map((item) => item.id), ["s-start", "s-hotel"]);
  assert.equal(hydrated.keepLocalDraft, true);
  assert.equal(hydrated.needsBaselineMigration, true);
});

test("keeps a locally added stop that cloud does not have yet", () => {
  const local = [book("rb-13", [day("day-8", [
    stop("s-start", "丙中洛观景台", { kind: "出发", duration: "09:00 出发" }),
    stop("s-mine", "雾里村"),
    stop("s-hotel", "泸水市", { kind: "住宿", duration: "待安排" }),
  ])])];
  const remote = [book("rb-13", [day("day-8", [
    stop("s-start", "丙中洛观景台", { kind: "出发", duration: "09:00 出发" }),
    stop("s-church", "老姆登基督教堂"),
    stop("s-hotel", "泸水市", { kind: "住宿", duration: "待安排" }),
  ])])];

  const merged = mergeRoadbookLibraries(local, remote, [book("rb-13", [day("day-8", [
    stop("s-start", "丙中洛观景台", { kind: "出发", duration: "09:00 出发" }),
    stop("s-hotel", "泸水市", { kind: "住宿", duration: "待安排" }),
  ])])]);
  assert.deepEqual(merged[0].days[0].stops.map((item) => item.name), [
    "丙中洛观景台",
    "老姆登基督教堂",
    "雾里村",
    "泸水市",
  ]);
  assert.equal(localLibraryHasUnsyncedEdits(local, remote), true);
});

test("keeps a local stop reorder and inserts the cloud-only stop after its remote neighbor", () => {
  const local = [book("rb-13", [day("day-8", [
    stop("s-a", "石月亮观景台"),
    stop("s-c", "飞来石"),
    stop("s-b", "知子罗"),
  ])])];
  const remote = [book("rb-13", [day("day-8", [
    stop("s-a", "石月亮观景台"),
    stop("s-b", "知子罗"),
    stop("s-x", "老姆登基督教堂"),
    stop("s-c", "飞来石"),
  ])])];

  const merged = mergeRoadbookLibraries(local, remote, [book("rb-13", [day("day-8", [
    stop("s-a", "石月亮观景台"),
    stop("s-b", "知子罗"),
    stop("s-c", "飞来石"),
  ])])]);
  assert.deepEqual(merged[0].days[0].stops.map((item) => item.id), ["s-a", "s-c", "s-b", "s-x"]);
  assert.equal(localLibraryHasUnsyncedEdits(local, remote), true);
});

test("keeps a local day reorder and still picks up a cloud-only day", () => {
  const local = [book("rb-13", [
    day("day-1", [stop("s-1", "益田村")], { title: "深圳 → 百色" }),
    day("day-3", [stop("s-3", "飞来寺")], { title: "大理 → 飞来寺" }),
    day("day-2", [stop("s-2", "大理古城")], { title: "百色 → 大理" }),
  ])];
  const remote = [book("rb-13", [
    day("day-1", [stop("s-1", "益田村")], { title: "深圳 → 百色" }),
    day("day-2", [stop("s-2", "大理古城")], { title: "百色 → 大理" }),
    day("day-4", [stop("s-4", "雨崩上村")], { title: "进雨崩" }),
    day("day-3", [stop("s-3", "飞来寺")], { title: "大理 → 飞来寺" }),
  ])];

  const merged = mergeRoadbookLibraries(local, remote, [book("rb-13", [
    day("day-1", [stop("s-1", "益田村")], { title: "深圳 → 百色" }),
    day("day-2", [stop("s-2", "大理古城")], { title: "百色 → 大理" }),
    day("day-3", [stop("s-3", "飞来寺")], { title: "大理 → 飞来寺" }),
  ])]);
  assert.deepEqual(merged[0].days.map((item) => item.id), ["day-1", "day-3", "day-2", "day-4"]);
  assert.equal(localLibraryHasUnsyncedEdits(local, remote), true);
});

test("keeps local stay time and note on a shared stop", () => {
  const local = [book("rb-13", [day("day-8", [
    stop("s-moon", "石月亮观景台", { stayMinutes: 30, note: "停车拍照" }),
  ])])];
  const remote = [book("rb-13", [day("day-8", [
    stop("s-moon", "石月亮观景台"),
    stop("s-church", "老姆登基督教堂"),
  ])])];

  const merged = mergeRoadbookLibraries(local, remote, local);
  assert.equal(merged[0].days[0].stops[0].stayMinutes, 30);
  assert.equal(merged[0].days[0].stops[0].note, "停车拍照");
  assert.equal(merged[0].days[0].stops[1].name, "老姆登基督教堂");
  assert.equal(localLibraryHasUnsyncedEdits(local, remote), true);
});

test("does not reinsert a locally deleted stop that still exists on the last synced baseline", () => {
  const baseline = [book("rb-13", [day("day-8", [
    stop("s-start", "丙中洛观景台"),
    stop("s-moon", "石月亮观景台"),
    stop("s-hotel", "泸水市"),
  ])])];
  const local = [book("rb-13", [day("day-8", [
    stop("s-start", "丙中洛观景台"),
    stop("s-hotel", "泸水市"),
  ])])];
  const remote = [book("rb-13", [day("day-8", [
    stop("s-start", "丙中洛观景台"),
    stop("s-moon", "石月亮观景台"),
    stop("s-church", "老姆登基督教堂"),
    stop("s-hotel", "泸水市"),
  ])])];

  const merged = mergeRoadbookLibraries(local, remote, baseline);
  assert.deepEqual(merged[0].days[0].stops.map((item) => item.id), ["s-start", "s-church", "s-hotel"]);
  assert.equal(localLibraryHasUnsyncedEdits(local, remote, baseline), true);
});

test("does not reinsert a locally deleted day or roadbook from the last synced baseline", () => {
  const baseline = [
    book("rb-13", [
      day("day-1", [stop("s-1", "益田村")]),
      day("day-2", [stop("s-2", "大理古城")]),
    ]),
    book("rb-gone", [day("day-x", [stop("s-x", "旧路书")])]),
  ];
  const local = [book("rb-13", [day("day-1", [stop("s-1", "益田村")])])];
  const remote = [
    book("rb-13", [
      day("day-1", [stop("s-1", "益田村")]),
      day("day-2", [stop("s-2", "大理古城")]),
      day("day-3", [stop("s-3", "飞来寺")]),
    ]),
    book("rb-gone", [day("day-x", [stop("s-x", "旧路书")])]),
  ];

  const merged = mergeRoadbookLibraries(local, remote, baseline);
  assert.deepEqual(merged.map((item) => item.id), ["rb-13"]);
  assert.deepEqual(merged[0].days.map((item) => item.id), ["day-1", "day-3"]);
  assert.equal(localLibraryHasUnsyncedEdits(local, remote, baseline), true);
});

test("after observing a cloud-added stop, a later local delete is not reinserted on refresh", () => {
  const synced = [book("rb-13", [day("day-8", [
    stop("s-start", "丙中洛观景台"),
    stop("s-hotel", "泸水市"),
  ])])];
  const localWithOtherEdit = [book("rb-13", [day("day-8", [
    stop("s-start", "丙中洛观景台", { note: "早出发" }),
    stop("s-hotel", "泸水市"),
  ])])];
  const remote = [book("rb-13", [day("day-8", [
    stop("s-start", "丙中洛观景台"),
    stop("s-church", "老姆登基督教堂"),
    stop("s-hotel", "泸水市"),
  ])])];

  const first = resolveHydratedRoadbooks(true, localWithOtherEdit, remote, synced);
  assert.deepEqual(first.roadbooks[0].days[0].stops.map((item) => item.id), ["s-start", "s-church", "s-hotel"]);
  assert.equal(first.keepLocalDraft, true);

  const localAfterDelete = [book("rb-13", [day("day-8", [
    stop("s-start", "丙中洛观景台", { note: "早出发" }),
    stop("s-hotel", "泸水市"),
  ])])];
  const second = resolveHydratedRoadbooks(true, localAfterDelete, remote, remote);
  assert.deepEqual(second.roadbooks[0].days[0].stops.map((item) => item.id), ["s-start", "s-hotel"]);
  assert.equal(second.keepLocalDraft, true);
});

test("hydrate uses the latest local draft, not the snapshot from before the cloud request", () => {
  const localAtFetchStart = [book("rb-13", [day("day-8", [
    stop("s-start", "丙中洛观景台"),
    stop("s-hotel", "泸水市"),
  ])])];
  const latestLocal = [book("rb-13", [day("day-8", [
    stop("s-start", "丙中洛观景台"),
    stop("s-mine", "雾里村"),
    stop("s-hotel", "泸水市"),
  ])])];
  const remote = [book("rb-13", [day("day-8", [
    stop("s-start", "丙中洛观景台"),
    stop("s-church", "老姆登基督教堂"),
    stop("s-hotel", "泸水市"),
  ])])];

  const hydrated = resolveHydratedRoadbooks(true, latestLocal, remote, localAtFetchStart);
  assert.ok(hydrated.roadbooks[0].days[0].stops.some((item) => item.id === "s-mine"));
  assert.ok(hydrated.roadbooks[0].days[0].stops.some((item) => item.id === "s-church"));
  assert.equal(hydrated.needsBaselineMigration, false);
});

test("keeps a locally created roadbook that is not on the cloud yet", () => {
  const localBook = book("rb-local", [day("day-1", [stop("s-1", "益田村")])]);
  const remoteBook = book("rb-13", [day("day-8", [stop("s-church", "老姆登基督教堂")])]);
  const merged = mergeRoadbookLibraries([localBook], [remoteBook]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, "rb-13");
  assert.equal(merged[1].id, "rb-local");
  assert.equal(localLibraryHasUnsyncedEdits([localBook], [remoteBook]), true);
});
