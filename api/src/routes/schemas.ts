/**
 * Request/response JSON Schemas.
 *
 * Fastify compiles these with ajv, so malformed payloads are rejected at the
 * edge with a 400 before any gRPC call is made.
 */
export const predictBodySchema = {
  type: "object",
  required: ["input"],
  additionalProperties: false,
  properties: {
    input: {
      type: "array",
      minItems: 1,
      maxItems: 4096,
      items: { type: "number" },
      description: "Feature vector to run inference over.",
    },
    model: { type: "string", maxLength: 128 },
    request_id: { type: "string", maxLength: 128 },
  },
} as const;

export const streamQuerySchema = {
  type: "object",
  required: ["input"],
  additionalProperties: false,
  properties: {
    input: {
      type: "string",
      description: "Comma-separated feature vector, e.g. `1,2,3`.",
      pattern: "^\\s*-?\\d+(\\.\\d+)?([eE][-+]?\\d+)?(\\s*,\\s*-?\\d+(\\.\\d+)?([eE][-+]?\\d+)?)*\\s*$",
    },
    steps: { type: "integer", minimum: 1, maximum: 100, default: 5 },
    model: { type: "string", maxLength: 128 },
    request_id: { type: "string", maxLength: 128 },
  },
} as const;

export interface PredictBody {
  input: number[];
  model?: string;
  request_id?: string;
}

export interface StreamQuery {
  input: string;
  steps: number;
  model?: string;
  request_id?: string;
}
