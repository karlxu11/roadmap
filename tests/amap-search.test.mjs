import assert from "node:assert/strict";
import test from "node:test";
import { inputTipsToPois, rankAmapPois } from "../worker/amap-search.ts";

test("exact POI name outranks similar parking results", () => {
  const results = rankAmapPois([
    {
      sourcePriority: 1,
      pois: [
        { id: "similar", name: "望塔园(东区)停车场", location: "116.4,39.9", distance: "200" },
        { id: "target", name: "望禾停车区", location: "86.9,48.1", distance: "12000" },
      ],
    },
  ], "望禾停车区");

  assert.equal(results[0].id, "target");
});

test("input tips become usable POIs with geographic context", () => {
  const results = inputTipsToPois({
    tips: [{ id: "target", name: "望禾停车区", district: "新疆维吾尔自治区阿勒泰地区布尔津县", address: "S232附近", location: "86.9,48.1", type: "道路附属设施" }],
  });

  assert.equal(results.length, 1);
  assert.match(results[0].address, /布尔津县/);
});

test("duplicate POIs from multiple search strategies are merged", () => {
  const results = rankAmapPois([
    { sourcePriority: 1, pois: [{ id: "same", name: "望禾停车区", location: "86.9,48.1" }] },
    { sourcePriority: 3, pois: [{ id: "same", name: "望禾停车区", address: "布尔津县", location: "86.9,48.1", distance: "800" }] },
  ], "望禾停车区");

  assert.equal(results.length, 1);
  assert.equal(results[0].address, "布尔津县");
  assert.equal(results[0].distance, 800);
});

