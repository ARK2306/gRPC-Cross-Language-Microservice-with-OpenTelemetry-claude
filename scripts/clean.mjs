#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { ROOT, SHARED_NODE, SHARED_PYTHON } from "./lib.mjs";

for (const target of [
  SHARED_NODE,
  SHARED_PYTHON,
  path.join(ROOT, "api", "dist"),
  path.join(ROOT, "tests", "dist"),
]) {
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`removed ${path.relative(ROOT, target)}`);
}
