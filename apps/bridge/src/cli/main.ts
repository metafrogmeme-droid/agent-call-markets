// Process entry point: `pnpm bridge plan ...` (dry run only).
import { runBridgeCli } from "./run.ts";

process.exitCode = runBridgeCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
});
