/**
 * GET /stream — server-streaming gRPC bridged to Server-Sent Events.
 *
 * Deltas from the sidecar are forwarded one SSE `message` event at a time, then
 * a terminal `end` event. Writing straight to `reply.raw` keeps Fastify's
 * serializer out of the way and lets us flush each delta as it arrives.
 */
import * as grpc from "@grpc/grpc-js";
import type { FastifyInstance, FastifyReply } from "fastify";

import { GrpcCallError, streamPredictions } from "../grpc-client.js";
import { httpStatusForGrpc } from "./predict.js";
import { streamQuerySchema, type StreamQuery } from "./schemas.js";

/** Serialise one SSE frame. `data` is always a single line of JSON. */
function sseFrame(event: string, data: unknown, id?: string): string {
  const lines = [`event: ${event}`, `data: ${JSON.stringify(data)}`];
  if (id !== undefined) lines.push(`id: ${id}`);
  return `${lines.join("\n")}\n\n`;
}

function openSseStream(reply: FastifyReply, traceId?: string): void {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Stops nginx and friends from buffering the stream into a single response.
    "x-accel-buffering": "no",
    ...(traceId ? { "x-trace-id": traceId } : {}),
  });
  // Comment frame: forces the headers out so the client's onopen fires now
  // rather than when the first delta lands ~1s later.
  reply.raw.write(": stream open\n\n");
}

export async function registerStreamRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: StreamQuery }>(
    "/stream",
    { schema: { querystring: streamQuerySchema } },
    async (request, reply) => {
      const input = request.query.input.split(",").map((v) => Number(v.trim()));
      const steps = request.query.steps ?? 5;

      // Cancels the sidecar RPC as soon as the client hangs up.
      const abort = new AbortController();
      request.raw.on("close", () => abort.abort());

      request.otelSpan?.setAttributes({
        "prediction.input_size": input.length,
        "prediction.steps": steps,
        "prediction.transport": "sse",
      });

      openSseStream(reply, request.traceId);

      // Everything below writes to reply.raw directly, so Fastify must not also
      // try to send a body for this request.
      reply.hijack();

      let delivered = 0;
      try {
        for await (const delta of streamPredictions(
          {
            input,
            steps,
            model: request.query.model ?? "",
            request_id: request.query.request_id ?? request.id,
          },
          abort.signal,
        )) {
          if (reply.raw.writableEnded) break;

          reply.raw.write(
            sseFrame(
              "message",
              {
                step: delta.step,
                total_steps: delta.total_steps,
                value: delta.value,
                cumulative: delta.cumulative,
                final: delta.final,
                request_id: delta.request_id,
              },
              String(delta.step),
            ),
          );
          delivered += 1;

          // Respect backpressure: wait for the socket to drain before pulling
          // the next delta off the gRPC stream.
          if (reply.raw.writableNeedDrain) {
            await new Promise<void>((resolve) => reply.raw.once("drain", resolve));
          }
        }

        if (!reply.raw.writableEnded) {
          reply.raw.write(
            sseFrame("end", {
              delivered,
              trace_id: request.traceId,
              request_id: request.query.request_id ?? request.id,
            }),
          );
        }
      } catch (err) {
        const code = err instanceof GrpcCallError ? err.code : grpc.status.UNKNOWN;
        request.log.warn({ err, delivered }, "StreamPredictions RPC failed");

        if (!reply.raw.headersSent) {
          reply.raw.writeHead(httpStatusForGrpc(code), {
            "content-type": "application/json",
          });
          reply.raw.write(
            JSON.stringify({
              error: grpc.status[code] ?? "UNKNOWN",
              message: err instanceof Error ? err.message : String(err),
              trace_id: request.traceId,
            }),
          );
        } else if (!reply.raw.writableEnded) {
          // Headers are already on the wire, so the only way to report the
          // failure is an SSE `error` event before closing.
          reply.raw.write(
            sseFrame("error", {
              error: grpc.status[code] ?? "UNKNOWN",
              message: err instanceof Error ? err.message : String(err),
              delivered,
              trace_id: request.traceId,
            }),
          );
        }
      } finally {
        abort.abort();
        if (!reply.raw.writableEnded) reply.raw.end();
      }
    },
  );
}
