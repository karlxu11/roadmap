import assert from "node:assert/strict";
import test from "node:test";
import { extractHighwayPath, rankRouteServiceAreas, sampleRouteSearchPoints } from "../worker/service-areas.ts";

test("national-road-only routes do not expose service areas", () => {
  const path = extractHighwayPath({ route: { paths: [{ steps: [{ road_name: "G217国道", instruction: "沿G217向北行驶", polyline: "86.0,47.0;86.2,47.2" }] }] } });
  assert.deepEqual(path, []);
});

test("highway steps provide a searchable route path", () => {
  const path = extractHighwayPath({ route: { paths: [{ steps: [{ road_name: "G30连霍高速", instruction: "沿连霍高速行驶", polyline: "102.0,36.0;103.0,36.2;104.0,36.4" }] }] } });
  assert.equal(path.length, 3);
  assert.ok(sampleRouteSearchPoints(path).length >= 1);
});

test("only service areas close to the highway are returned in route order", () => {
  const path = [[100, 36], [101, 36], [102, 36]];
  const results = rankRouteServiceAreas([
    { id: "later", name: "西行服务区", address: "高速公路", location: "101.9,36.001", type: "交通设施服务" },
    { id: "first", name: "东行服务区", address: "高速公路", location: "100.2,36.001", type: "交通设施服务" },
    { id: "far", name: "城区服务区", address: "市区", location: "101,36.2", type: "生活服务" },
    { id: "shop", name: "高速便利店", address: "高速公路", location: "101,36", type: "购物服务" },
  ], path);

  assert.deepEqual(results.map((item) => item.id), ["first", "later"]);
});

