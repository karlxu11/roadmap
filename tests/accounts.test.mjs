import assert from "node:assert/strict";
import test from "node:test";

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("accounts", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

function makeKv() {
  const records = new Map();
  return {
    async put(key, value) { records.set(key, typeof value === "string" ? value : JSON.stringify(value)); },
    async get(key, type) {
      const value = records.get(key);
      if (value == null) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async list({ prefix = "" } = {}) {
      return {
        keys: [...records.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
        cursor: "",
      };
    },
    async delete(key) { records.delete(key); },
  };
}

function context() {
  return { waitUntil() {}, passThroughOnException() {} };
}

function cookieFrom(response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

test("registered users receive isolated roadbooks and AMap settings", async () => {
  const worker = await loadWorker();
  const env = {
    allowregister: "1",
    ROADBOOK_KV: makeKv(),
    AMAP_JS_KEY: "admin-js",
    AMAP_SECURITY_CODE: "admin-security",
    AMAP_WEB_SERVICE_KEY: "admin-web",
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  };
  const request = (path, init = {}) => worker.fetch(new Request(`http://localhost${path}`, init), env, context());

  const registerAlice = await request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "alice-pass-123", passwordConfirm: "alice-pass-123", jsKey: "alice-js", securityCode: "alice-security", webKey: "alice-web" }),
  });
  assert.equal(registerAlice.status, 201);
  const aliceCookie = cookieFrom(registerAlice);
  assert.ok(aliceCookie);

  const aliceConfig = await request("/api/amap-config", { headers: { cookie: aliceCookie } });
  assert.deepEqual(await aliceConfig.json(), { jsKey: "alice-js", securityCode: "alice-security", webKey: "alice-web" });
  const aliceSave = await request("/api/roadbooks", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: aliceCookie },
    body: JSON.stringify([{ id: "alice-roadbook" }]),
  });
  assert.equal(aliceSave.status, 200);

  const registerBob = await request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "bob", password: "bob-pass-123", passwordConfirm: "bob-pass-123", jsKey: "bob-js", securityCode: "bob-security", webKey: "bob-web" }),
  });
  assert.equal(registerBob.status, 201);
  const bobPayload = await registerBob.json();
  const bobCookie = cookieFrom(registerBob);
  await env.ROADBOOK_KV.put(`roadbooks:user:${bobPayload.user.id}`, JSON.stringify([
    { id: "roadbook-69defbdbf04061086bd0cf71" },
    { id: "roadbook-amap-686f74ae52f2600e6d48cbdd" },
    { id: "roadbook-amap-6a6ac8888244b107b7cfb234" },
  ]));
  const bobBooks = await request("/api/roadbooks", { headers: { cookie: bobCookie } });
  assert.deepEqual((await bobBooks.json()).roadbooks, []);
  const bobConfig = await request("/api/amap-config", { headers: { cookie: bobCookie } });
  assert.deepEqual(await bobConfig.json(), { jsKey: "bob-js", securityCode: "bob-security", webKey: "bob-web" });

  const adminLogin = await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "nsnkarlxu" }),
  });
  assert.equal(adminLogin.status, 200);
  const regularAdminUsers = await request("/api/admin/users", { headers: { cookie: aliceCookie } });
  assert.equal(regularAdminUsers.status, 403);
  const adminUsersResponse = await request("/api/admin/users", { headers: { cookie: cookieFrom(adminLogin) } });
  const adminUsersPayload = await adminUsersResponse.json();
  assert.deepEqual(adminUsersPayload.users.map(({ username }) => username), ["admin", "alice", "bob"]);
  const aliceAdminUser = adminUsersPayload.users.find(({ username }) => username === "alice");
  const adminUser = adminUsersPayload.users.find(({ username }) => username === "admin");
  assert.deepEqual(aliceAdminUser.amap, { jsKey: "alice-js", securityCode: "alice-security", webKey: "alice-web" });
  assert.ok(adminUsersPayload.users.every((user) => !("passwordHash" in user)));
  const regularDelete = await request(`/api/admin/users?userId=${encodeURIComponent(aliceAdminUser.id)}`, { method: "DELETE", headers: { cookie: bobCookie } });
  assert.equal(regularDelete.status, 403);
  const adminDelete = await request(`/api/admin/users?userId=${encodeURIComponent(adminUser.id)}`, { method: "DELETE", headers: { cookie: cookieFrom(adminLogin) } });
  assert.equal(adminDelete.status, 400);
  const deleteAlice = await request(`/api/admin/users?userId=${encodeURIComponent(aliceAdminUser.id)}`, { method: "DELETE", headers: { cookie: cookieFrom(adminLogin) } });
  assert.equal(deleteAlice.status, 200);
  const usersAfterDelete = await request("/api/admin/users", { headers: { cookie: cookieFrom(adminLogin) } });
  assert.deepEqual((await usersAfterDelete.json()).users.map(({ username }) => username), ["admin", "bob"]);
  const aliceLoginAfterDelete = await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "alice-pass-123" }),
  });
  assert.equal(aliceLoginAfterDelete.status, 401);
  const adminBooks = await request("/api/roadbooks", { headers: { cookie: cookieFrom(adminLogin) } });
  const adminRoadbooks = (await adminBooks.json()).roadbooks;
  assert.deepEqual(adminRoadbooks.map(({ id }) => id).sort(), [
    "roadbook-69defbdbf04061086bd0cf71",
    "roadbook-amap-686f74ae52f2600e6d48cbdd",
    "roadbook-amap-6a6ac8888244b107b7cfb234",
  ].sort());
  const adminConfig = await request("/api/amap-config", { headers: { cookie: cookieFrom(adminLogin) } });
  assert.deepEqual(await adminConfig.json(), { jsKey: "admin-js", securityCode: "admin-security", webKey: "admin-web" });

  env.allowregister = "0";
  const protectedHome = await request("/");
  assert.equal(protectedHome.status, 401);
  assert.doesNotMatch(await protectedHome.text(), /立即注册/);
  const closedRegistration = await request("/api/auth/register", { method: "POST" });
  assert.equal(closedRegistration.status, 403);
});
