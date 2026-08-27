/**
 * Typed gRPC client for the Python inference sidecar.
 *
 * The descriptor is loaded at runtime from shared/node/prediction.proto with
 * @grpc/proto-loader and cast to `ProtoGrpcType` — the type generated from the
 * same .proto by `pnpm run proto:node`. That cast is what makes the generated
 * stubs load-bearing: change the contract in /proto without updating this file
 * and `pnpm build` fails at tsc rather than at runtime.
 */
import { setTimeout as delay } from "node:timers/promises";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import type { ProtoGrpcType } from "../../shared/node/types/prediction.js";
import type { PredictionServiceClient } from "../../shared/node/types/prediction/v1/PredictionService.js";
import type { PredictRequest } from "../../shared/node/types/prediction/v1/PredictRequest.js";
import type { PredictResponse__Output } from "../../shared/node/types/prediction/v1/PredictResponse.js";
import type { PredictionDelta__Output } from "../../shared/node/types/prediction/v1/PredictionDelta.js";
import type { StreamRequest } from "../../shared/node/types/prediction/v1/StreamRequest.js";

import { config } from "./config.js";

export type { PredictResponse__Output as PredictResponse };
export type { PredictionDelta__Output as PredictionDelta };

const packageDefinition = protoLoader.loadSync(config.protoPath, {
  keepCase: true,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
});

const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as ProtoGrpcType;

/**
 * One long-lived channel for the whole process. grpc-js multiplexes concurrent
 * RPCs over it, and the keepalive settings stop an idle NAT/proxy from silently
 * dropping the connection between bursts of traffic.
 */
export const predictionClient: PredictionServiceClient =
  new proto.prediction.v1.PredictionService(
    config.sidecarTarget,
    grpc.credentials.createInsecure(),
    {
      "grpc.keepalive_time_ms": 30_000,
      "grpc.keepalive_timeout_ms": 10_000,
      "grpc.keepalive_permit_without_calls": 1,
      "grpc.max_receive_message_length": 16 * 1024 * 1024,
      "grpc.service_config": JSON.stringify({
        methodConfig: [
          {
            name: [{ service: "prediction.v1.PredictionService" }],
            // Transient connection blips shouldn't surface as 5xx at the edge.
            // Only retryable-by-definition codes are listed; the sidecar's own
            // INVALID_ARGUMENT/DEADLINE_EXCEEDED are never retried.
            retryPolicy: {
              maxAttempts: 3,
              initialBackoff: "0.1s",
              maxBackoff: "1s",
              backoffMultiplier: 2,
              retryableStatusCodes: ["UNAVAILABLE"],
            },
          },
        ],
      }),
    },
  );

function deadline(ms: number): grpc.CallOptions {
  return { deadline: new Date(Date.now() + ms) };
}

/** Error carrying the gRPC status code, so routes can map it to an HTTP status. */
export class GrpcCallError extends Error {
  constructor(
    message: string,
    readonly code: grpc.status,
    readonly details: string,
  ) {
    super(message);
    this.name = "GrpcCallError";
  }
}

function wrap(err: grpc.ServiceError, rpc: string): GrpcCallError {
  return new GrpcCallError(
    `sidecar ${rpc} failed: ${grpc.status[err.code] ?? err.code}: ${err.details}`,
    err.code,
    err.details,
  );
}

/** Unary Predict RPC. */
export function predict(request: PredictRequest): Promise<PredictResponse__Output> {
  return new Promise((resolve, reject) => {
    predictionClient.Predict(request, deadline(config.grpcDeadlineMs), (err, response) => {
      if (err) return reject(wrap(err as grpc.ServiceError, "Predict"));
      if (!response) return reject(new Error("sidecar returned an empty Predict response"));
      resolve(response);
    });
  });
}

/**
 * Server-streaming StreamPredictions RPC, surfaced as an async iterable so the
 * SSE route can `for await` over it and let backpressure propagate.
 *
 * `signal` aborts the underlying call — the SSE route passes the request's
 * abort signal so a disconnecting client stops work on the sidecar too.
 */
export async function* streamPredictions(
  request: StreamRequest,
  signal?: AbortSignal,
): AsyncGenerator<PredictionDelta__Output> {
  const call = predictionClient.StreamPredictions(
    request,
    deadline(config.grpcStreamDeadlineMs),
  );

  const onAbort = () => call.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for await (const delta of call as AsyncIterable<PredictionDelta__Output>) {
      yield delta;
    }
  } catch (err) {
    // A cancellation we initiated is an expected end-of-stream, not an error.
    if (signal?.aborted && (err as grpc.ServiceError)?.code === grpc.status.CANCELLED) return;
    throw wrap(err as grpc.ServiceError, "StreamPredictions");
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Block until the channel reaches READY, so the process only reports itself
 * healthy once the sidecar is actually reachable.
 */
export async function waitForSidecar(timeoutMs: number): Promise<void> {
  const giveUpAt = Date.now() + timeoutMs;
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        predictionClient.waitForReady(new Date(giveUpAt), (err) =>
          err ? reject(err) : resolve(),
        );
      });
      return;
    } catch (err) {
      if (Date.now() >= giveUpAt) throw err;
      await delay(500);
    }
  }
}

/** Current channel state, surfaced by /readyz without forcing a reconnect. */
export function channelState(): string {
  return grpc.connectivityState[predictionClient.getChannel().getConnectivityState(false)] ?? "UNKNOWN";
}

export function closeGrpcClient(): void {
  predictionClient.close();
}
