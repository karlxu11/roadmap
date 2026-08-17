import assert from "node:assert/strict";
import test from "node:test";
import { combineRoutePaths, hasDrawableRoutePath, normalizeRoutePath } from "../app/route-path.ts";

test("does not draw a misleading partial route when one leg has no path", () => {
  const route = combineRoutePaths([
    [[100, 30], [101, 30]],
    undefined,
    [[102, 30], [103, 30]],
  ]);
  assert.deepEqual(route, []);
});

test("combines every complete leg without duplicating shared endpoints", () => {
  const route = combineRoutePaths([
    [[100, 30], [101, 30]],
    [[101, 30], [102, 30]],
  ]);
  assert.deepEqual(route, [[100, 30], [101, 30], [102, 30]]);
});

test("normalizes invalid cached points before deciding a path is drawable", () => {
  const path = normalizeRoutePath([[100, 30], ["bad", 31], [101, 31]]);
  assert.deepEqual(path, [[100, 30], [101, 31]]);
  assert.equal(hasDrawableRoutePath(path), true);
  assert.equal(hasDrawableRoutePath([[100, 30]]), false);
});
