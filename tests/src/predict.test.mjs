/**
 * POST /predict — the unary path, end to end.
 *
 * Covers the REST contract, the Redis cache behaviour (a second identical
 * request must be served from cache), and input validation.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  closeSidecarClient,
  postPredict,
  uniqueInput,
  waitForApi,
} from "./helpers.mjs";

describe("POST /predict", { timeout: 180_000 }, () => {
  before(async () => {
    await waitForApi();
  });

  after(() => closeSidecarClient());

  it("returns a prediction for the documented payload", async () => {
    const { res, body } = await postPredict({ input: [1, 2, 3] });

    assert.equal(res.status, 200, `unexpected status; body=${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.output), "output must be an array");
    assert.ok(body.output.length > 0, "output must not be empty");
    assert.ok(
      body.output.every((v) => Number.isFinite(v)),
      "every output value must be finite",
    );
    assert.equal(typeof body.score, "number");
    assert.ok(body.score > 0 && body.score <= 1, `score out of range: ${body.score}`);
    assert.equal(typeof body.model, "string");
    assert.ok(body.model.length > 0);
    assert.equal(typeof body.cached, "boolean");
    assert.match(body.cache_key, /^prediction:v1:[0-9a-f]{64}$/);

    // Every response carries the trace id, so a failing request is traceable.
    assert.match(body.trace_id, /^[0-9a-f]{32}$/);
    assert.equal(res.headers.get("x-trace-id"), body.trace_id);
  });

  // End-to-end consistency: the cached answer must match the computed one.
  // Determinism of the model itself is covered by sidecar/tests/test_inference.py.
  it("returns the same output for a repeated input", async () => {
    const input = uniqueInput();
    const first = await postPredict({ input });
    const second = await postPredict({ input });

    assert.equal(first.res.status, 200);
    assert.equal(second.res.status, 200);
    assert.deepEqual(second.body.output, first.body.output);
    assert.equal(second.body.cache_key, first.body.cache_key);
  });

  it("serves a repeated request from the Redis cache", async () => {
    const input = uniqueInput();

    const first = await postPredict({ input });
    assert.equal(first.res.status, 200);
    assert.equal(first.body.cached, false, "a novel input must be a cache miss");
    assert.ok(
      first.body.compute_ms >= 900,
      `mock inference should burn ~1-2s of CPU, got ${first.body.compute_ms}ms`,
    );

    const startedAt = Date.now();
    const second = await postPredict({ input });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(second.res.status, 200);
    assert.equal(second.body.cached, true, "the repeated request must be a cache hit");
    assert.equal(second.body.compute_ms, 0, "a cache hit must not report compute time");
    assert.deepEqual(second.body.output, first.body.output);
    // The whole point of the cache: skip the 1-2s model run.
    assert.ok(elapsedMs < 900, `cache hit took ${elapsedMs}ms; expected well under the 1s model time`);
  });

  it("distinguishes models with the same input", async () => {
    const input = uniqueInput();
    const a = await postPredict({ input, model: "model-a" });
    const b = await postPredict({ input, model: "model-b" });

    assert.equal(a.body.model, "model-a");
    assert.equal(b.body.model, "model-b");
    assert.notEqual(a.body.cache_key, b.body.cache_key, "cache key must include the model");
  });

  it("echoes a caller-supplied request_id", async () => {
    const requestId = `it-${Date.now()}`;
    const { body } = await postPredict({ input: uniqueInput(), request_id: requestId });
    assert.equal(body.request_id, requestId);
  });

  it("rejects malformed payloads with 400", async () => {
    const cases = [
      { name: "missing input", payload: {} },
      { name: "empty input", payload: { input: [] } },
      { name: "non-numeric input", payload: { input: ["a", "b"] } },
      { name: "unknown property", payload: { input: [1], nope: true } },
    ];

    for (const { name, payload } of cases) {
      const { res } = await postPredict(payload);
      assert.equal(res.status, 400, `${name}: expected 400, got ${res.status}`);
    }
  });
});
