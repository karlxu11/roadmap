import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the roadbook workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>路书 · ROAM NOTE<\/title>/i);
  assert.match(html, /五一伊犁/);
  assert.match(html, /在行程末尾添加一天/);
  assert.match(html, /把想去的地方放进来/);
  assert.match(html, /type="time"/);
  assert.match(html, /当日日期/);
  assert.match(html, /value="2026-04-29"/);
  assert.match(html, /总时长/);
  assert.match(html, /全程总里程/);
  assert.match(html, /截至当前累计总里程/);
  assert.match(html, /高德路线已接入|示例路线预览/);
  assert.doesNotMatch(html, /当日路段/);
  assert.match(html, /待计算/);
  assert.match(html, /我的路书/);
  assert.match(html, /分享管理/);
  assert.match(html, /新路书/);
  assert.match(html, /导出 PDF/);
  assert.doesNotMatch(html, /class="print-only roadbook-print"/);
  assert.match(html, /接入高德地图，查看真实路线/);
  assert.match(html, /--editor-track:67fr/);
  assert.match(html, /--map-track:33fr/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("does not ship the starter preview surface", async () => {
  assert.deepEqual(await readdir(new URL("../app/_sites-preview", import.meta.url)), []);
});

test("stores share snapshots behind a short token", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("share", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const records = new Map();
  const kv = {
    async put(key, value) { records.set(key, JSON.parse(value)); },
    async get(key) { return records.get(key) ?? null; },
    async delete(key) { records.delete(key); },
  };
  const snapshot = { version: 1, roadbook: { days: [] }, legs: {}, createdAt: new Date().toISOString() };
  const createResponse = await worker.fetch(
    new Request("http://localhost/api/shares", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(snapshot) }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ROADBOOK_KV: kv },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(createResponse.status, 200);
  const { token } = await createResponse.json();
  assert.ok(token);
  assert.ok(token.length < 80);

  const updatedSnapshot = { ...snapshot, legs: { "stop-1": { distance: 1200, duration: 90 } } };
  const updateResponse = await worker.fetch(
    new Request(`http://localhost/api/shares?token=${token}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(updatedSnapshot) }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ROADBOOK_KV: kv },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(updateResponse.status, 200);

  const readResponse = await worker.fetch(
    new Request(`http://localhost/api/shares?token=${token}`),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ROADBOOK_KV: kv },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(readResponse.status, 200);
  assert.deepEqual((await readResponse.json()).snapshot, updatedSnapshot);

  const listResponse = await worker.fetch(new Request("http://localhost/api/shares"), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ROADBOOK_KV: kv }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(listResponse.status, 200);
  assert.equal((await listResponse.json()).links.length, 1);

  const revokeResponse = await worker.fetch(new Request(`http://localhost/api/shares?token=${token}`, { method: "DELETE" }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ROADBOOK_KV: kv }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(revokeResponse.status, 200);
  const revokedReadResponse = await worker.fetch(new Request(`http://localhost/api/shares?token=${token}`), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ROADBOOK_KV: kv }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(revokedReadResponse.status, 404);
});

test("serves sidebar route metrics from the Worker KV cache", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("route-cache", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const cachedRoute = { status: "1", info: "OK", route: { distance: 128400, duration: 7200, tolls: 54, path: [[114, 22], [110, 26], [106.5, 29.5]] } };
  const cacheKey = "amap-route-v1:114.000000,22.000000|106.500000,29.500000|policy=0|ferry=0|waypoints=";
  const kv = {
    async get(key) { return key === cacheKey ? cachedRoute : null; },
    async put() {},
    async delete() {},
  };
  const response = await worker.fetch(
    new Request("http://localhost/api/amap/route?origin=114,22&destination=106.5,29.5&policy=0&includePath=0"),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ROADBOOK_KV: kv, AMAP_WEB_SERVICE_KEY: "test-key" },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-route-cache"), "HIT");
  assert.deepEqual(await response.json(), { ...cachedRoute, route: { ...cachedRoute.route, path: [] } });

  const pathResponse = await worker.fetch(
    new Request("http://localhost/api/amap/route?origin=114,22&destination=106.5,29.5&policy=0&includePath=1"),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ROADBOOK_KV: kv, AMAP_WEB_SERVICE_KEY: "test-key" },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.deepEqual(await pathResponse.json(), cachedRoute);
});

test("share pages bypass the editor password", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("share-auth", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const snapshot = { version: 1, roadbook: { days: [] }, legs: {}, createdAt: new Date().toISOString() };
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  const inlineToken = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const env = { SITE_PASSWORD: "secret", ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const shareResponse = await worker.fetch(new Request(`http://localhost/?share=${inlineToken}`), env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(shareResponse.status, 200);
  const invalidShareResponse = await worker.fetch(new Request("http://localhost/?share=short"), env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(invalidShareResponse.status, 401);
  const mapConfigResponse = await worker.fetch(new Request("http://localhost/api/amap-config"), env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(mapConfigResponse.status, 200);
  const editorResponse = await worker.fetch(new Request("http://localhost/"), env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(editorResponse.status, 401);
});
