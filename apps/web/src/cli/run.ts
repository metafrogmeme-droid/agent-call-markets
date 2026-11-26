// `pnpm web build|snapshot`: builds the static record page. Read-only: chain data comes through
// the Solana adapter without a signer (devnet/localnet only, cluster guard applied), or from a
// snapshot file. Nothing is sent, no keys are involved, and nothing is deployed or hosted.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  DEFAULT_RPC_URL,
  parseCluster,
  RpcTransport,
  SolanaAdapter,
  type Cluster,
  type SolanaTransport,
} from "@agent-call-markets/adapter-solana";
import { parseIdMap } from "@agent-call-markets/bridge";
import { CoreError } from "@agent-call-markets/core";
import { isAddress } from "@solana/kit";
import { buildSite } from "../build.ts";
import { buildModel } from "../model.ts";
import { DISCLAIMER } from "../render.ts";
import { decodeSnapshot, encodeSnapshot } from "../snapshot.ts";
import { collectFromAdapter, type RecordData } from "../source.ts";

export interface WebCliDeps {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Defaults to an RpcTransport on the URL. Tests inject a fake one. */
  readonly transport?: (cluster: Cluster, url: string) => SolanaTransport;
}

export const USAGE = `web: the public record page (static, script-free, read-only)

${DISCLAIMER}
No US users.

Usage:
  pnpm web build --snapshot FILE --out DIR
  pnpm web build --cluster devnet|localnet --agents FILE --out DIR [--url URL] [--program-id ADDR]
  pnpm web snapshot --cluster devnet|localnet --agents FILE --out FILE [--url URL] [--program-id ADDR]

  --agents FILE   JSON map: agent label -> 32-byte public id (hex), as used by the bridge
  --snapshot FILE a snapshot written by "web snapshot" (acm-record-snapshot/v1)

Chain reads use the Solana adapter without a signer: read-only, devnet or localnet only, and the
RPC's genesis hash is checked (mainnet and testnet are refused). The site is written to --out for
local viewing; hosting it publicly is a deploy and is not done by this tool.
`;

const OPTIONS = {
  snapshot: { type: "string" },
  cluster: { type: "string" },
  url: { type: "string" },
  "program-id": { type: "string" },
  agents: { type: "string" },
  out: { type: "string" },
  help: { type: "boolean" },
} as const;

class UsageError extends Error {}
class FileError extends Error {}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new FileError(`cannot read ${path}: ${(err as Error).message}`);
  }
}

function need(v: string | undefined, name: string): string {
  if (v === undefined || v === "") throw new UsageError(`missing --${name}`);
  return v;
}

const json = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x), 2);

interface ChainOptions {
  readonly cluster: string;
  readonly agents: string;
  readonly url: string | undefined;
  readonly programId: string | undefined;
}

/** Reads the listed agents' calls through a read-only adapter (no signer; guard applied). */
async function fromChain(o: ChainOptions, deps: WebCliDeps): Promise<RecordData> {
  const cluster = parseCluster(o.cluster); // refuses mainnet/testnet names before connecting
  const programId = o.programId;
  if (programId !== undefined && !isAddress(programId)) {
    throw new UsageError(`--program-id is not a valid address: ${programId}`);
  }
  const map = parseIdMap(read(o.agents), "agents");
  const url = o.url ?? DEFAULT_RPC_URL[cluster];
  const transport = deps.transport ? deps.transport(cluster, url) : new RpcTransport(url);
  const adapter = await SolanaAdapter.connect({
    cluster,
    transport,
    signer: null,
    ...(programId === undefined ? {} : { programId }),
  });
  const config = await adapter.config();
  return collectFromAdapter(adapter, {
    agents: [...map].map(([label, id]) => ({ label, id })),
    now: await adapter.now(),
    params: config.params,
    source: adapter.chainId,
    synthetic: false,
  });
}

/** Runs the CLI. Exit codes: 0 ok, 1 refused / unreadable / invalid input, 2 usage. */
export async function runWebCli(argv: readonly string[], deps: WebCliDeps): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    if (values.help === true) {
      deps.stdout(USAGE);
      return 0;
    }
    const [command] = positionals;
    const chain = (): ChainOptions => ({
      cluster: need(values.cluster, "cluster"),
      agents: need(values.agents, "agents"),
      url: values.url,
      programId: values["program-id"],
    });

    if (command === "snapshot") {
      const out = need(values.out, "out");
      const data = await fromChain(chain(), deps);
      writeFileSync(out, encodeSnapshot(data));
      deps.stdout(
        json({
          snapshot: out,
          source: data.source,
          takenAt: data.takenAt,
          calls: data.calls.length,
        }),
      );
      return 0;
    }
    if (command === "build") {
      const out = need(values.out, "out");
      if (values.snapshot !== undefined && values.cluster !== undefined) {
        throw new UsageError("use either --snapshot or --cluster, not both");
      }
      const data =
        values.snapshot !== undefined
          ? decodeSnapshot(read(values.snapshot))
          : await fromChain(chain(), deps);
      const model = buildModel(data);
      const pages = buildSite(model, out);
      deps.stdout(
        json({
          out,
          source: model.source,
          synthetic: model.synthetic,
          takenAt: model.takenAt,
          pages,
          agents: model.agents.map((a) => ({
            label: a.label,
            id: a.id,
            summary: a.summary,
            mismatches: a.mismatches,
          })),
        }),
      );
      return 0;
    }
    throw new UsageError(
      command === undefined ? "missing command" : `unknown command "${command}"`,
    );
  } catch (err) {
    if (
      err instanceof UsageError ||
      (err instanceof Error && "code" in err && String(err.code).startsWith("ERR_PARSE_ARGS"))
    ) {
      deps.stderr(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    if (err instanceof FileError) {
      deps.stderr(json({ error: "FILE_UNREADABLE", message: err.message }));
      return 1;
    }
    if (err instanceof CoreError) {
      deps.stderr(json({ error: err.code, message: err.message }));
      return 1;
    }
    deps.stderr(json({ error: "UNEXPECTED", message: (err as Error).message }));
    return 1;
  }
}
