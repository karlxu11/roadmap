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
  assert.match(html, /2026中秋国庆新疆/);
  assert.match(html, /在行程末尾添加一天/);
  assert.match(html, /把想去的地方放进来/);
  assert.match(html, /type="time"/);
  assert.match(html, /总时长/);
  assert.match(html, /我的路书/);
  assert.match(html, /新路书/);
  assert.match(html, /导出 PDF/);
  assert.match(html, /路书 · ROAM NOTE \| 由高德路线数据辅助整理/);
  assert.match(html, /接入高德地图，查看真实路线/);
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

  const readResponse = await worker.fetch(
    new Request(`http://localhost/api/shares?token=${token}`),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ROADBOOK_KV: kv },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(readResponse.status, 200);
  assert.deepEqual((await readResponse.json()).snapshot, snapshot);
});

test("share pages bypass the editor password", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("share-auth", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = { SITE_PASSWORD: "secret", ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const shareResponse = await worker.fetch(new Request("http://localhost/?share=abcdefghijklmnop"), env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(shareResponse.status, 200);
  const editorResponse = await worker.fetch(new Request("http://localhost/"), env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(editorResponse.status, 401);
});
