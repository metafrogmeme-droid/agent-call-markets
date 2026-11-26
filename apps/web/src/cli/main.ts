// Process entry point: `pnpm web build|snapshot ...` (read-only).
import { runWebCli } from "./run.ts";

process.exitCode = await runWebCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
});
