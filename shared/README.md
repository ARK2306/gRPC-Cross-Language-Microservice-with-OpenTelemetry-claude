# shared/

Compiled protobuf/gRPC stubs for both languages. **Everything here except this
file is generated** by `pnpm build` and is gitignored — the checked-in tree can
never drift from `proto/prediction.proto`.

| Directory | Produced by | Contents |
| --- | --- | --- |
| `node/` | `pnpm run proto:node` → `proto-loader-gen-types` | `prediction.proto` (loaded at runtime by `@grpc/proto-loader`) and `types/*.d.ts` (TypeScript definitions the gateway compiles against). |
| `python/` | `pnpm run proto:python` → `python -m grpc_tools.protoc` | `prediction_pb2.py`, `prediction_pb2_grpc.py`, `prediction_pb2.pyi`. |

Regenerate with:

```bash
pnpm run proto
```

Both Docker builds regenerate these from `/proto` in a dedicated build stage, so
container images never depend on the state of your working copy.
