/**
 * The server-streaming RPC, exercised at both layers:
 *   - directly over gRPC against the sidecar (the protocol-level contract)
 *   - through the gateway's SSE bridge (what a browser client actually sees)
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  API_BASE_URL,
  closeSidecarClient,
  grpcStream,
  readSse,
  uniqueInput,
  waitForApi,
} from "./helpers.mjs";

describe("StreamPredictions (gRPC server-streaming)", { timeout: 180_000 }, () => {
  before(async () => {
    await waitForApi();
  });

  after(() => closeSidecarClient());

  it("streams the requested number of deltas from the sidecar", async () => {
    const steps = 5;
    const deltas = await grpcStream({
      input: uniqueInput(),
      steps,
      model: "",
      request_id: "grpc-stream-test",
    });

    assert.equal(deltas.length, steps, `expected ${steps} deltas, got ${deltas.length}`);

    deltas.forEach((delta, i) => {
      assert.equal(delta.step, i + 1, "steps must arrive in order, 1-based");
      assert.equal(delta.total_steps, steps);
      assert.ok(Number.isFinite(delta.value), "value must be finite");
      assert.equal(delta.request_id, "grpc-stream-test");
      assert.equal(delta.final, i === steps - 1, "only the last delta is final");
    });

    // `cumulative` must be the running sum of `value`.
    let running = 0;
    for (const delta of deltas) {
      running += delta.value;
      assert.ok(
        Math.abs(delta.cumulative - running) < 1e-9,
        `cumulative drifted at step ${delta.step}: ${delta.cumulative} vs ${running}`,
      );
    }
  });

  it("honours a custom step count", async () => {
    const deltas = await grpcStream({ input: uniqueInput(), steps: 3, model: "", request_id: "n3" });
    assert.equal(deltas.length, 3);
    assert.equal(deltas.at(-1).final, true);
  });

  it("rejects an empty input with INVALID_ARGUMENT", async () => {
    await assert.rejects(
      () => grpcStream({ input: [], steps: 2, model: "", request_id: "bad" }),
      (err) => {
        assert.equal(err.code, 3, `expected INVALID_ARGUMENT (3), got ${err.code}`);
        return true;
      },
    );
  });
});

describe("GET /stream (SSE bridge)", { timeout: 180_000 }, () => {
  before(async () => {
    await waitForApi();
  });

  it("streams deltas as Server-Sent Events", async () => {
    const steps = 4;
    const res = await fetch(`${API_BASE_URL}/stream?input=1,2,3&steps=${steps}`, {
      headers: { accept: "text/event-stream" },
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.match(res.headers.get("x-trace-id") ?? "", /^[0-9a-f]{32}$/);

    const events = await readSse(res);
    const messages = events.filter((e) => e.event === "message");
    const terminal = events.filter((e) => e.event === "end");

    assert.equal(messages.length, steps, `expected ${steps} message events`);
    assert.equal(terminal.length, 1, "stream must be terminated by exactly one `end` event");
    assert.equal(terminal[0].data.delivered, steps);

    messages.forEach((frame, i) => {
      assert.equal(frame.data.step, i + 1);
      assert.equal(frame.data.total_steps, steps);
      assert.equal(frame.id, String(i + 1), "each frame carries its step as the SSE id");
      assert.ok(Number.isFinite(frame.data.value));
    });
    assert.equal(messages.at(-1).data.final, true);
    assert.equal(events.some((e) => e.event === "error"), false, "no error events expected");
  });

  it("rejects a malformed query string with 400", async () => {
    for (const qs of ["", "?input=", "?input=abc", "?input=1,2,3&steps=0", "?input=1&steps=1000"]) {
      const res = await fetch(`${API_BASE_URL}/stream${qs}`);
      assert.equal(res.status, 400, `expected 400 for "${qs}", got ${res.status}`);
      await res.arrayBuffer();
    }
  });
});
