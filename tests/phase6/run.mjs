// Compiles the framework-free Phase 6 TypeScript with the repo's own `typescript`, then runs every
// *.test.mjs here with node:test. No new dependency, no network. Usage: npm run test:phase6
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const out = mkdtempSync(path.join(os.tmpdir(), "phase6-"));

try {
  const tsc = require.resolve("typescript/bin/tsc");
  const compiled = spawnSync(process.execPath, [tsc, "-p", path.join(here, "tsconfig.json"), "--outDir", out], { stdio: "inherit" });
  if (compiled.status !== 0) process.exit(compiled.status ?? 1);

  const tests = [here, path.join(here, "upload")]
    .flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).map((f) => path.join(dir, f)))
    .sort();
  const ran = spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit", env: { ...process.env, PHASE6_OUT: out } });
  process.exitCode = ran.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
