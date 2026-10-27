import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const { runConfirm, baseMime, CONFIRM_MESSAGES: M } = require(path.join(process.env.PHASE6_OUT, "src/modules/media/confirm-core.js"));

const ID = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

/** Fake world: one row, one R2 object, a call log (for ordering assertions). */
function world(over = {}) {
  const w = {
    userId: USER,
    row: { storage_key: "t/m.jpg", processing_status: "pending", mime_type: "image/jpeg" },
    lookup: "row",             // "row" | "error" | "none"
    head: { sizeBytes: 100, contentType: "image/jpeg" },   // object | null | "throw"
    confirm: "ready",          // "ready" | "failed" | "error" | "void" | "raise-already"
    fail: true,                // true | false | "error"
    statusAfter: undefined,    // forced status for re-reads
    objects: new Set(["t/m.jpg"]),
    calls: [],
    ...over,
  };
  const deps = {
    getUserId: async () => w.userId,
    lookupOwnRow: async () => (w.lookup === "error" ? "error" : w.lookup === "none" ? null : w.row),
    readStatus: async () => (w.statusAfter !== undefined ? w.statusAfter : w.row.processing_status),
    headObject: async () => {
      w.calls.push("head");
      if (w.head === "throw") throw new Error("r2 down");
      return w.head;
    },
    deleteObject: async (key) => { w.calls.push("delete"); w.objects.delete(key); },
    confirmRpc: async () => {
      w.calls.push("confirm");
      if (w.confirm === "error" || w.confirm === "raise-already") return { error: true };
      if (w.confirm === "void") return { status: null };
      if (w.confirm === "ready") w.row.processing_status = "ready";
      if (w.confirm === "failed") w.row.processing_status = "failed";
      return { status: w.confirm };
    },
    failRpc: async () => {
      w.calls.push("fail");
      if (w.fail === true) w.row.processing_status = "failed";
      return w.fail;
    },
    log: () => {},
  };
  return { w, deps };
}
const run = (deps, input = { mediaId: ID }) => runConfirm(deps, input);

test("input and auth guards make no downstream call", async () => {
  for (const bad of [null, undefined, {}, { mediaId: 5 }, { mediaId: "nope" }, { mediaId: ID.toUpperCase() + "x" }]) {
    const { w, deps } = world();
    assert.deepEqual(await runConfirm(deps, bad), { error: M.notFound });   // runConfirm, not run(): `run` defaults undefined to a valid id
    assert.deepEqual(w.calls, []);
  }
  const { w, deps } = world({ userId: null });
  assert.deepEqual(await run(deps), { error: M.signedOut });
  assert.deepEqual(w.calls, []);
});

test("lookup failure, foreign/missing row, already ready, and other statuses", async () => {
  assert.deepEqual(await run(world({ lookup: "error" }).deps), { error: M.retry });
  assert.deepEqual(await run(world({ lookup: "none" }).deps), { error: M.notFound });
  const r = world(); r.w.row.processing_status = "ready";
  assert.deepEqual(await run(r.deps), { success: M.done });
  assert.deepEqual(r.w.calls, [], "ready is idempotent: no R2 call");
  for (const st of ["failed", "processing"]) {
    const x = world(); x.w.row.processing_status = st;
    assert.deepEqual(await run(x.deps), { error: M.notCompleted });
  }
});

test("R2 HEAD failures are not 'not found'; a genuine miss is", async () => {
  const a = world({ head: "throw" });
  assert.deepEqual(await run(a.deps), { error: M.verify });
  assert.deepEqual(a.w.calls, ["head"], "no delete, no confirm");
  const b = world({ head: null });
  assert.deepEqual(await run(b.deps), { error: M.missingObject });
  assert.deepEqual(b.w.calls, ["head"]);
});

test("happy path; Content-Type compared case/parameter-insensitively", async () => {
  assert.equal(baseMime("Image/JPEG; charset=x"), "image/jpeg");
  const { w, deps } = world({ head: { sizeBytes: 5, contentType: "IMAGE/JPEG; foo=bar" } });
  assert.deepEqual(await run(deps), { success: M.done });
  assert.deepEqual(w.calls, ["head", "confirm"]);
});

test("MISSING stored Content-Type fails closed (used to skip validation)", async () => {
  for (const contentType of [undefined, "", "   "]) {
    const { w, deps } = world({ head: { sizeBytes: 5, contentType } });
    assert.deepEqual(await run(deps), { error: M.unsupported }, JSON.stringify(contentType));
    assert.ok(!w.calls.includes("confirm"), "never confirmed");
    assert.equal(w.row.processing_status, "failed");
  }
});

test("mismatching Content-Type: row is marked failed BEFORE the object is deleted", async () => {
  const { w, deps } = world({ head: { sizeBytes: 5, contentType: "image/png" } });
  assert.deepEqual(await run(deps), { error: M.unsupported });
  assert.deepEqual(w.calls, ["head", "fail", "delete"], "DB first, then R2");
  assert.equal(w.objects.size, 0);
  assert.equal(w.row.processing_status, "failed");
});

test("if marking the row failed errors, the object is KEPT and the row stays pending (retry re-checks)", async () => {
  const { w, deps } = world({ head: { sizeBytes: 5, contentType: "image/png" }, fail: "error" });
  assert.deepEqual(await run(deps), { error: M.verify });
  assert.deepEqual(w.calls, ["head", "fail"], "no delete");
  assert.equal(w.objects.size, 1);
  assert.equal(w.row.processing_status, "pending");
  // the retry (RPC healthy again) takes the same path to completion
  w.fail = true;
  assert.deepEqual(await run(deps), { error: M.unsupported });
  assert.equal(w.objects.size, 0);
});

test("a concurrent request already decided the row: never delete the object", async () => {
  for (const [decided, expected] of [["failed", { error: M.unsupported }], ["ready", { success: M.done }], ["pending", { error: M.verify }]]) {
    const { w, deps } = world({ head: { sizeBytes: 5, contentType: "image/png" }, fail: false, statusAfter: decided });
    assert.deepEqual(await run(deps), expected, decided);
    assert.ok(!w.calls.includes("delete"));
  }
});

test("oversize at confirm: 'failed' persisted by the RPC, object deleted afterwards", async () => {
  const { w, deps } = world({ confirm: "failed" });
  assert.deepEqual(await run(deps), { error: M.tooLarge });
  assert.deepEqual(w.calls, ["head", "confirm", "delete"]);
});

test("RPC error: report what the row says (lost race = success), never the raw error", async () => {
  for (const [st, expected] of [["ready", { success: M.done }], ["failed", { error: M.notCompleted }], ["pending", { error: M.retry }]]) {
    const { deps } = world({ confirm: "error", statusAfter: st });
    assert.deepEqual(await run(deps), expected, st);
  }
});

test("unexpected RPC result (pre-0016 function returned void) is never assumed to be success", async () => {
  const pending = world({ confirm: "void", statusAfter: "pending" });
  assert.deepEqual(await run(pending.deps), { error: M.retry });
  const ready = world({ confirm: "void", statusAfter: "ready" });
  assert.deepEqual(await run(ready.deps), { success: M.done });
});

test("two concurrent confirms for one upload both report success (the loser re-reads the row)", async () => {
  const { w, deps } = world();
  let first = true;
  deps.confirmRpc = async () => {
    w.calls.push("confirm");
    await new Promise((r) => setImmediate(r));
    if (first) { first = false; w.row.processing_status = "ready"; return { status: "ready" }; }
    return { error: true };            // "This upload has already been processed" raised by the function
  };
  const [a, b] = await Promise.all([run(deps), run(deps)]);
  assert.deepEqual(a, { success: M.done });
  assert.deepEqual(b, { success: M.done });
});
