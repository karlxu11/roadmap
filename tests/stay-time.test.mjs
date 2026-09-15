import assert from "node:assert/strict";
import test from "node:test";
import { normalizedStayMinutes } from "../app/stay-time.ts";

test("normalizes stay values to the selector range", () => {
  assert.equal(normalizedStayMinutes(undefined), 0);
  assert.equal(normalizedStayMinutes(0), 0);
  assert.equal(normalizedStayMinutes(15), 30);
  assert.equal(normalizedStayMinutes(30), 30);
  assert.equal(normalizedStayMinutes(359.6), 360);
  assert.equal(normalizedStayMinutes(8 * 60), 360);
});
