// Process entry point for the CLI: `pnpm acm <command>` (devnet/localnet only).
import { runCli } from "./run.ts";

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
});
