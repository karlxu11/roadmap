import assert from "node:assert/strict";
import test from "node:test";
import { localLibraryHasUnsyncedEdits, mergeRoadbookLibraries } from "../app/merge-roadbooks.ts";

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

  const merged = mergeRoadbookLibraries(local, remote);
  assert.deepEqual(merged[0].days[0].stops.map((item) => item.name), [
    "丙中洛观景台",
    "石月亮观景台",
    "老姆登基督教堂",
    "知子罗",
    "泸水市",
  ]);
  assert.equal(localLibraryHasUnsyncedEdits(local, remote), false);
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

  const merged = mergeRoadbookLibraries(local, remote);
  assert.deepEqual(merged[0].days[0].stops.map((item) => item.name), [
    "丙中洛观景台",
    "雾里村",
    "老姆登基督教堂",
    "泸水市",
  ]);
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

  const merged = mergeRoadbookLibraries(local, remote);
  assert.equal(merged[0].days[0].stops[0].stayMinutes, 30);
  assert.equal(merged[0].days[0].stops[0].note, "停车拍照");
  assert.equal(merged[0].days[0].stops[1].name, "老姆登基督教堂");
  assert.equal(localLibraryHasUnsyncedEdits(local, remote), true);
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
