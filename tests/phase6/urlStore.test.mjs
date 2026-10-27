// Pure URL layer. Run through `npm run test:phase6` (compiles the TypeScript first).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createUrlStore } = require(process.env.PHASE6_OUT + "/src/modules/media/urlStore.js");
const { createSignedUrlFetcher } = require(process.env.PHASE6_OUT + "/src/modules/media/url-contract.js");

const ok = (id, n = 1, ttl = 300) => ({ id, status: "ok", url: `https://r2/${id}?n=${n}`, ttlSeconds: ttl });

test("ensure batches, reuses fresh URLs, and does not re-request them", async () => {
  const calls = [];
  let t = 0;
  const store = createUrlStore({ now: () => t, fetcher: async (ids) => (calls.push(ids), ids.map((i) => ok(i))) });
  await store.ensure(["a", "b", "a"]);
  assert.deepEqual(calls, [["a", "b"]]);
  await store.ensure(["a", "b"]);
  assert.equal(calls.length, 1, "fresh -> no new request");
  assert.deepEqual(store.peek("a"), { kind: "url", url: "https://r2/a?n=1" });
});

test("near-expiry (inside the 60 s margin) is re-requested; display keeps the held URL", async () => {
  let t = 0, n = 0;
  const store = createUrlStore({ now: () => t, fetcher: async (ids) => ids.map((i) => ok(i, ++n)) });
  await store.ensure(["a"]);
  t = 241_000; // 300 s ttl - 60 s margin = 240 s
  assert.equal(store.peek("a").kind, "url", "an already-loaded image is not torn down");
  await store.ensure(["a"]);
  assert.equal(n, 2, "replacement requested");
  assert.equal(store.peek("a").url, "https://r2/a?n=2");
});

test("unavailable and error entries are never retried automatically; refresh retries", async () => {
  let mode = "unavailable", calls = 0;
  const store = createUrlStore({ fetcher: async (ids) => (calls++, ids.map((i) => (mode === "ok" ? ok(i) : { id: i, status: mode }))) });
  await store.ensure(["a"]);
  assert.equal(store.peek("a").kind, "unavailable");
  await store.ensure(["a"]);
  assert.equal(calls, 1);
  mode = "ok";
  await store.refresh("a");
  assert.equal(store.peek("a").kind, "url");
  assert.equal(calls, 2);
});

test("fetcher throwing marks ids as error; ids missing from a response become error", async () => {
  const s1 = createUrlStore({ fetcher: async () => { throw new Error("net"); } });
  await s1.ensure(["a"]);
  assert.equal(s1.peek("a").kind, "error");
  const s2 = createUrlStore({ fetcher: async () => [] });
  await s2.ensure(["a"]);
  assert.equal(s2.peek("a").kind, "error");
});

test("batches of at most maxBatch; concurrent ensure for the same id issues one request", async () => {
  const calls = [];
  const store = createUrlStore({ maxBatch: 2, fetcher: async (ids) => (calls.push(ids.length), ids.map((i) => ok(i))) });
  await store.ensure(["a", "b", "c", "d", "e"]);
  assert.deepEqual(calls, [2, 2, 1]);
  let release; const gate = new Promise((r) => (release = r));
  let c2 = 0;
  const s2 = createUrlStore({ fetcher: async (ids) => (c2++, await gate, ids.map((i) => ok(i))) });
  const p1 = s2.ensure(["x"]); const p2 = s2.ensure(["x"]);
  release(); await Promise.all([p1, p2]);
  assert.equal(c2, 1);
});

test("fetchFresh bypasses the cache every time and subscribers are notified", async () => {
  let n = 0, notified = 0;
  const store = createUrlStore({ fetcher: async (ids) => ids.map((i) => ok(i, ++n)) });
  store.subscribe(() => notified++);
  await store.ensure(["a"]);
  const u = await store.fetchFresh("a");
  assert.equal(u, "https://r2/a?n=2");
  assert.ok(notified >= 2);
});

test("url-contract: wire shape of Claude 1's endpoint, case-insensitive id match, dedupe, failures", async () => {
  const seen = [];
  const f = createSignedUrlFetcher("TRIP", async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ results: [{ id: "aaa", url: "https://u", ttlSeconds: 300 }, { id: "bbb", unavailable: true }] }), { status: 200 });
  });
  const r = await f(["AAA", "bbb", "ccc", "bbb"]);
  assert.equal(seen[0].url, "/api/trips/TRIP/media-urls");
  assert.deepEqual(seen[0].body, { ids: ["AAA", "bbb", "ccc"] });
  assert.deepEqual(r.map((x) => x.status), ["ok", "unavailable", "unavailable"]);
  const down = createSignedUrlFetcher("T", async () => new Response("{}", { status: 500 }));
  assert.deepEqual((await down(["a"])).map((x) => x.status), ["error"]);
  const boom = createSignedUrlFetcher("T", async () => { throw new Error("net"); });
  assert.deepEqual((await boom(["a"])).map((x) => x.status), ["error"]);
  const junk = createSignedUrlFetcher("T", async () => new Response("not json", { status: 200 }));
  assert.deepEqual((await junk(["a"])).map((x) => x.status), ["error"]);
});
