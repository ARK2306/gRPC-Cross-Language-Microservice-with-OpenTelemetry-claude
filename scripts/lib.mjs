import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PROTO_DIR = path.join(ROOT, "proto");
export const PROTO_FILE = path.join(PROTO_DIR, "prediction.proto");
export const SHARED_NODE = path.join(ROOT, "shared", "node");
export const SHARED_PYTHON = path.join(ROOT, "shared", "python");

/** Run a command, streaming output. Throws with a readable message on failure. */
export function run(cmd, args, opts = {}) {
  const printable = [cmd, ...args].join(" ");
  if (!opts.quiet) console.log(`  $ ${printable}`);
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: opts.quiet ? "pipe" : "inherit",
    encoding: "utf8",
    ...opts,
  });
  if (res.error) throw new Error(`failed to launch \`${printable}\`: ${res.error.message}`);
  if (res.status !== 0) {
    const detail = opts.quiet ? `\n${res.stdout ?? ""}${res.stderr ?? ""}` : "";
    throw new Error(`\`${printable}\` exited with code ${res.status}${detail}`);
  }
  return res;
}

/** Run a command purely to test whether it succeeds. */
export function tryRun(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "pipe", encoding: "utf8" });
  return !res.error && res.status === 0;
}

export function step(msg) {
  console.log(`\n▸ ${msg}`);
}
