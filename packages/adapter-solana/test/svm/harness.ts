// LiteSVM world for the adapter tests: the compiled call_markets SBF binary, the SPL Token program,
// a test mint and an initialised config. Identities are fresh in-memory keys, never written to disk.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LiteSVM } from "litesvm";
import {
  address,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  lamports,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import {
  bytes32,
  DEFAULT_PARAMS,
  type Bytes32,
  type OracleObservation,
  type OracleRef,
  type ProtocolParams,
} from "@agent-call-markets/core";
import { SolanaAdapter } from "../../src/adapter.ts";
import { addressToBytes32 } from "../../src/codec/accounts.ts";
import { PLACEHOLDER_PROGRAM_ID, PYTH_RECEIVER_PROGRAM_ID } from "../../src/constants.ts";
import { encodePriceUpdateV2, type VerificationLevel } from "../../src/pyth.ts";
import { LiteSvmTransport } from "./litesvm-transport.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Path of the compiled program (`cargo build-sbf`); CI passes it via CALL_MARKETS_SO. */
export function programSo(): string {
  const so = process.env["CALL_MARKETS_SO"] ?? `${REPO_ROOT}target/deploy/call_markets.so`;
  if (!existsSync(so)) {
    // Fail, never skip: these tests are the adapter's conformance run against the real program.
    throw new Error(
      `call_markets.so not found at ${so}: run \`cargo build-sbf\` or set CALL_MARKETS_SO`,
    );
  }
  return so;
}

/** Synthetic feed id, as in packages/core/test/fixtures.ts (not a real Pyth feed). */
export const FEED: Bytes32 = bytes32("f1".repeat(32));
export const PARAMS: ProtocolParams = { ...DEFAULT_PARAMS, allowedFeedIds: [FEED] };
export const T0 = 1_800_000_000n;
export const SOL = 1_000_000_000n;
const BPF_LOADER_UPGRADEABLE = address("BPFLoaderUpgradeab1e11111111111111111111111");

export interface World {
  readonly svm: LiteSVM;
  readonly transport: LiteSvmTransport;
  readonly authority: KeyPairSigner;
  readonly admin: SolanaAdapter;
  readonly mint: Address;
  newSigner(): Promise<KeyPairSigner>;
  adapter(signer: KeyPairSigner | null): Promise<SolanaAdapter>;
  advanceTo(ts: bigint): void;
  /** Writes a synthetic PriceUpdateV2 at a fresh address (owner defaults to the pinned receiver). */
  putPrice(
    obs: OracleObservation,
    opts?: { readonly owner?: Address; readonly level?: VerificationLevel; readonly at?: Address },
  ): Promise<OracleRef & { readonly kind: "account" }>;
}

/** Makes the program's upgrade authority `authority` (LiteSVM deploys with none). */
function setUpgradeAuthority(svm: LiteSVM, authority: Address): void {
  const program = svm.getAccount(PLACEHOLDER_PROGRAM_ID);
  if (!program.exists) throw new Error("program not loaded");
  const programData = getAddressDecoder().decode(program.data.slice(4, 36));
  const pd = svm.getAccount(programData);
  if (!pd.exists || pd.programAddress !== BPF_LOADER_UPGRADEABLE) throw new Error("no programdata");
  // UpgradeableLoaderState::ProgramData = u32 tag 3 | slot u64 | Option<Pubkey>; the ELF follows.
  const data = Uint8Array.from(pd.data);
  data[12] = 1;
  data.set(getAddressEncoder().encode(authority), 13);
  svm.setAccount({ ...pd, data });
}

export async function makeWorld(
  params: ProtocolParams = PARAMS,
  opts: { readonly initConfig?: boolean } = {},
): Promise<World> {
  const svm = new LiteSVM();
  svm.addProgramFromFile(PLACEHOLDER_PROGRAM_ID, programSo());
  const clock = svm.getClock();
  clock.unixTimestamp = T0;
  clock.slot = 10n;
  svm.setClock(clock);

  const transport = new LiteSvmTransport(svm);
  const newSigner = async () => {
    const s = await generateKeyPairSigner();
    svm.airdrop(s.address, lamports(10n * SOL));
    return s;
  };
  const authority = await newSigner();
  setUpgradeAuthority(svm, authority.address);
  const admin = await SolanaAdapter.connect({ cluster: "localnet", transport, signer: authority });
  const mint = (await admin.createTestMint(6)).value;
  if (opts.initConfig !== false) await admin.initializeConfig(params, mint);

  return {
    svm,
    transport,
    authority,
    admin,
    mint,
    newSigner,
    adapter: (signer) => SolanaAdapter.connect({ cluster: "localnet", transport, signer }),
    advanceTo(ts: bigint) {
      const c = svm.getClock();
      c.unixTimestamp = ts;
      c.slot += 1n;
      svm.setClock(c);
    },
    async putPrice(obs, opts = {}) {
      const at = opts.at ?? (await generateKeyPairSigner()).address;
      const data = encodePriceUpdateV2(
        obs,
        opts.level === undefined ? {} : { verificationLevel: opts.level },
      );
      svm.setAccount({
        address: at,
        data,
        executable: false,
        lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))),
        programAddress: opts.owner ?? PYTH_RECEIVER_PROGRAM_ID,
        space: BigInt(data.length),
      });
      return { kind: "account", address: at };
    },
  };
}

export const keyOf = (s: KeyPairSigner): Bytes32 => addressToBytes32(s.address);
