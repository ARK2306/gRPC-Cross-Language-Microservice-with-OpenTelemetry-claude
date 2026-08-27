/** Service metadata and probe endpoints. */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { apiFetch, waitForApi } from "./helpers.mjs";

describe("gateway health", { timeout: 180_000 }, () => {
  before(async () => {
    await waitForApi();
  });

  it("GET /healthz reports liveness without touching dependencies", async () => {
    const res = await apiFetch("/healthz");
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(typeof body.uptime_s, "number");
  });

  it("GET /readyz reports the sidecar channel state", async () => {
    const res = await apiFetch("/readyz");
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.status, "ready");
    assert.ok(["READY", "IDLE"].includes(body.dependencies.sidecar.channel_state));
    assert.equal(body.dependencies.jaeger.reachable, true);
  });

  it("GET / documents the available endpoints", async () => {
    const res = await apiFetch("/");
    const body = await res.json();
    assert.equal(res.status, 200);
    for (const route of ["POST /predict", "GET /stream", "GET /trace-test"]) {
      assert.ok(route in body.endpoints, `missing ${route} in the endpoint index`);
    }
  });

  it("returns a structured 404 for unknown routes", async () => {
    const res = await apiFetch("/does-not-exist");
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "NOT_FOUND");
  });
});
