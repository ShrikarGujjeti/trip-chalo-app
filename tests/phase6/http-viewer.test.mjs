import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const OUT = process.env.PHASE6_OUT;
const { readBodyCapped } = require(path.join(OUT, "src/modules/media/http.js"));
const { pickAfterRemoval } = require(path.join(OUT, "src/modules/media/viewerNav.js"));

const stream = (chunks, onCancel = () => {}) => {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]));
      else c.close();
    },
    cancel: onCancel,
  });
};

test("readBodyCapped: null body, small body, exactly the cap, and chunked bodies", async () => {
  assert.equal(await readBodyCapped(null, 10), "");
  assert.equal(await readBodyCapped(stream(['{"a":1}']), 100), '{"a":1}');
  assert.equal(await readBodyCapped(stream(["12345", "67890"]), 10), "1234567890");
  assert.equal(await readBodyCapped(stream(["ab", "cd", "ef"]), 100), "abcdef");
});

test("readBodyCapped: counts REAL bytes (no Content-Length needed) and cancels the stream", async () => {
  let cancelled = false;
  const big = stream(["x".repeat(8), "y".repeat(8), "z".repeat(8)], () => (cancelled = true));
  assert.equal(await readBodyCapped(big, 10), "too-large");
  assert.equal(cancelled, true);
  assert.equal(await readBodyCapped(stream(["12345678901"]), 10), "too-large", "one byte over");
  // multibyte: 4 chars but 8 bytes
  assert.equal(await readBodyCapped(stream(["éééé"]), 6), "too-large");
});

test("pickAfterRemoval: next item takes the removed position, else last, else null", () => {
  assert.equal(pickAfterRemoval(["a", "b", "c"], 1), "b");   // list after removal of old index 1
  assert.equal(pickAfterRemoval(["a", "b"], 2), "b");        // removed the last item: show the new last
  assert.equal(pickAfterRemoval(["a"], 0), "a");
  assert.equal(pickAfterRemoval([], 0), null);
  assert.equal(pickAfterRemoval(["a", "b"], -3), "a");
});
