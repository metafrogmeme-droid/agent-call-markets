import { getCreateAccountInstruction } from "@solana-program/system";
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getTokenDecoder,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  address,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  isAddress,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  bytesEqual,
  CallStatus,
  CoreError,
  ErrorCode,
  Outcome,
  quote as quotePool,
  U64_MAX,
  unwrap,
  type Bytes32,
  type CallRecord,
  type CallRef,
  type CallV1,
  type ChainAdapter,
  type MarketRef,
  type OracleRef,
  type ProtocolParams,
  type Quote,
  type Side,
  type Tx,
} from "@agent-call-markets/core";
import {
  ACCOUNT_DISCRIMINATOR,
  ACCOUNT_SIZE,
  callToState,
  configToParams,
  decodeCall,
  decodeConfig,
  decodePosition,
  sideToByte,
  type CallAccount,
  type ConfigAccount,
  type PositionAccount,
} from "./codec/accounts.ts";
import { toCoreError } from "./codec/errors.ts";
import { parseEvents } from "./codec/events.ts";
import { buildIx } from "./codec/instructions.ts";
import { OFFSETS } from "./codec/program.ts";
import { PLACEHOLDER_PROGRAM_ID, SIDE, type Cluster } from "./constants.ts";
import { assertClusterAllowed } from "./guard.ts";
import { checkOutcome, type OutcomeCheck } from "./outcome.ts";
import { callPda, collateralAta, configPda, positionPda, vaultPda } from "./pda.ts";
import { TxFailedError, type SentTx, type SolanaTransport } from "./transport.ts";

const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const BPF_LOADER_UPGRADEABLE = address("BPFLoaderUpgradeab1e11111111111111111111111");

export interface SolanaCallRecord extends CallRecord {
  readonly address: Address;
  readonly account: CallAccount;
  readonly positions: readonly (PositionAccount & { readonly address: Address })[];
  readonly outcomeCheck: OutcomeCheck;
}

export interface ConnectOptions {
  readonly cluster: Cluster;
  readonly transport: SolanaTransport;
  /** null = read-only: every write rejects with READ_ONLY. */
  readonly signer: TransactionSigner | null;
  readonly programId?: Address;
}

export interface LoadedConfig {
  readonly address: Address;
  readonly account: ConfigAccount;
  readonly params: ProtocolParams;
}

function inU64(v: bigint): boolean {
  return v >= 0n && v <= U64_MAX;
}

/**
 * ChainAdapter for the call_markets program. Construct only through `SolanaAdapter.connect`,
 * which applies the cluster guard; every send re-applies it. Adapters move data: the program
 * decides (and rejects), and its errors are mapped onto core ErrorCodes.
 */
export class SolanaAdapter implements ChainAdapter {
  readonly chainId: string;
  readonly cluster: Cluster;
  readonly programId: Address;
  readonly transport: SolanaTransport;
  readonly signer: TransactionSigner | null;
  private configCache: Promise<LoadedConfig> | null = null;

  private constructor(opts: ConnectOptions) {
    this.cluster = opts.cluster;
    this.chainId = `solana:${opts.cluster}`;
    this.transport = opts.transport;
    this.signer = opts.signer;
    this.programId = opts.programId ?? PLACEHOLDER_PROGRAM_ID;
  }

  /** Connects after checking the cluster (devnet or localnet only; mainnet is always refused). */
  static async connect(opts: ConnectOptions): Promise<SolanaAdapter> {
    const adapter = new SolanaAdapter(opts);
    await adapter.assertCluster();
    return adapter;
  }

  /** Same transport and checks, different signer (null = read-only). */
  async as(signer: TransactionSigner | null): Promise<SolanaAdapter> {
    return SolanaAdapter.connect({
      cluster: this.cluster,
      transport: this.transport,
      signer,
      programId: this.programId,
    });
  }

  private async assertCluster(): Promise<void> {
    const genesisHash = await this.transport.getGenesisHash();
    assertClusterAllowed(this.cluster, { endpoint: this.transport.endpoint, genesisHash });
  }

  // ---------------------------------------------------------------- ChainAdapter

  async sealCall(c: {
    readonly commitment: Bytes32;
    readonly expiryTs: bigint;
  }): Promise<Tx<CallRef>> {
    const agent = this.requireSigner();
    const call = await callPda(this.programId, agent.address, c.commitment);
    if ((await this.transport.getAccount(call)) !== null) {
      throw new CoreError(ErrorCode.DuplicateCall, "this agent already sealed this commitment");
    }
    const config = await this.config();
    const sent = await this.send([
      buildIx(
        this.programId,
        "sealCall",
        { agent, config: config.address, call, system_program: SYSTEM_PROGRAM },
        { commitment: c.commitment, expiry_ts: c.expiryTs },
      ),
    ]);
    return { txId: sent.signature, value: { chainId: this.chainId, id: call } };
  }

  async revealCall(ref: CallRef, call: CallV1, salt: Bytes32): Promise<Tx> {
    const agent = this.requireSigner();
    const addr = this.refAddress(ref);
    await this.loadCall(addr);
    const config = await this.config();
    const sent = await this.send([
      buildIx(
        this.programId,
        "revealCall",
        { agent, config: config.address, call: addr },
        {
          feed_id: call.feedId,
          direction: call.direction,
          level_mantissa: call.level.mantissa,
          level_expo: call.level.expo,
          salt,
        },
      ),
    ]);
    return { txId: sent.signature, value: undefined };
  }

  async openMarket(ref: CallRef): Promise<Tx<MarketRef>> {
    const opener = this.requireSigner();
    const addr = this.refAddress(ref);
    await this.loadCall(addr);
    const config = await this.config();
    const sent = await this.send([
      buildIx(
        this.programId,
        "openMarket",
        {
          opener,
          config: config.address,
          call: addr,
          collateral_mint: config.account.collateral_mint,
          vault: await vaultPda(this.programId, addr),
          token_program: TOKEN_PROGRAM_ADDRESS,
          system_program: SYSTEM_PROGRAM,
        },
        {},
      ),
    ]);
    return { txId: sent.signature, value: { chainId: this.chainId, id: addr } };
  }

  async quote(market: MarketRef, side: Side, amount: bigint): Promise<Quote> {
    const call = await this.loadCall(this.refAddress(market));
    if (!call.market_open) throw new CoreError(ErrorCode.MarketNotOpen, "market is not open");
    return unwrap(quotePool({ yes: call.pool_yes, no: call.pool_no }, side, amount));
  }

  async trade(
    market: MarketRef,
    side: Side,
    amount: bigint,
    minProjectedPayout: bigint,
  ): Promise<Tx> {
    const buyer = this.requireSigner();
    if (!inU64(amount) || !inU64(minProjectedPayout)) {
      throw new CoreError(ErrorCode.InvalidAmount, "amounts must fit in u64");
    }
    const addr = this.refAddress(market);
    await this.loadCall(addr);
    const config = await this.config();
    const buyerToken = await collateralAta(buyer.address, config.account.collateral_mint);
    if ((await this.transport.getAccount(buyerToken)) === null) {
      throw new CoreError(ErrorCode.InsufficientBalance, "no test-token account for this signer");
    }
    const sideByte = sideToByte(side);
    const position = await positionPda(this.programId, addr, buyer.address, sideByte);
    const ixs: Instruction[] = [];
    if ((await this.transport.getAccount(position)) === null) {
      ixs.push(
        buildIx(
          this.programId,
          "openPosition",
          { owner: buyer, call: addr, position, system_program: SYSTEM_PROGRAM },
          { side: sideByte },
        ),
      );
    }
    ixs.push(
      buildIx(
        this.programId,
        "buy",
        {
          buyer,
          config: config.address,
          call: addr,
          collateral_mint: config.account.collateral_mint,
          vault: await vaultPda(this.programId, addr),
          buyer_token: buyerToken,
          position,
          token_program: TOKEN_PROGRAM_ADDRESS,
        },
        { amount, min_projected_payout: minProjectedPayout },
      ),
    );
    const sent = await this.send(ixs, { buyIx: [ixs.length - 1] });
    return { txId: sent.signature, value: undefined };
  }

  async redeem(market: MarketRef): Promise<Tx<bigint>> {
    const owner = this.requireSigner();
    const addr = this.refAddress(market);
    const call = await this.loadCall(addr);
    const config = await this.config();
    const open: Address[] = [];
    for (const side of [SIDE.yes, SIDE.no]) {
      const position = await positionPda(this.programId, addr, owner.address, side);
      const info = await this.transport.getAccount(position);
      if (info !== null && !decodePosition(info.data).redeemed) open.push(position);
    }
    if (open.length === 0) {
      // Same order as the core: an undecided market is NOT_REDEEMABLE before anything else.
      const decided = call.market_open && (call.status === 3 || call.status === 4);
      throw decided
        ? new CoreError(ErrorCode.NothingToRedeem, "no unredeemed position for this owner")
        : new CoreError(ErrorCode.NotRedeemable, "market is not settled or void");
    }
    const ownerToken = await collateralAta(owner.address, config.account.collateral_mint);
    const vault = await vaultPda(this.programId, addr);
    const ixs: Instruction[] = [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: owner,
        ata: ownerToken,
        owner: owner.address,
        mint: config.account.collateral_mint,
      }),
      ...open.map((position) =>
        buildIx(
          this.programId,
          "redeem",
          {
            owner,
            config: config.address,
            call: addr,
            collateral_mint: config.account.collateral_mint,
            vault,
            owner_token: ownerToken,
            position,
            token_program: TOKEN_PROGRAM_ADDRESS,
          },
          {},
        ),
      ),
    ];
    const sent = await this.send(ixs, { programIx: open.map((_, i) => i + 1) });
    const payout = parseEvents(sent.logs, "Redeemed")
      .filter((e) => e.call === addr && e.owner === owner.address)
      .reduce((sum, e) => sum + e.payout, 0n);
    return { txId: sent.signature, value: payout };
  }

  async settle(ref: CallRef, oracle: OracleRef): Promise<Tx<Outcome>> {
    const settler = this.requireSigner();
    if (oracle.kind !== "account" || !isAddress(oracle.address)) {
      throw new CoreError(
        ErrorCode.UnsupportedOracleRef,
        "settle takes the address of an existing Pyth PriceUpdateV2 account",
      );
    }
    const addr = this.refAddress(ref);
    await this.loadCall(addr);
    const config = await this.config();
    // Exactly one price account per settle; the program accepts one update per market.
    const sent = await this.send([
      buildIx(
        this.programId,
        "settle",
        { settler, config: config.address, call: addr, price_update: oracle.address },
        {},
      ),
    ]);
    const after = await this.loadCall(addr);
    if (after.outcome !== 1 && after.outcome !== 2) {
      throw new CoreError(ErrorCode.ChainError, "settle confirmed but no outcome was recorded");
    }
    return { txId: sent.signature, value: after.outcome === 1 ? Outcome.Hit : Outcome.Miss };
  }

  async voidUnsettled(ref: CallRef): Promise<Tx> {
    const caller = this.requireSigner();
    const addr = this.refAddress(ref);
    await this.loadCall(addr);
    const config = await this.config();
    const sent = await this.send([
      buildIx(this.programId, "voidUnsettled", { caller, config: config.address, call: addr }, {}),
    ]);
    return { txId: sent.signature, value: undefined };
  }

  async getCall(ref: CallRef): Promise<SolanaCallRecord | null> {
    let addr: Address;
    try {
      addr = this.refAddress(ref);
    } catch {
      return null;
    }
    const info = await this.transport.getAccount(addr);
    if (info?.owner !== this.programId) return null;
    return this.toRecord(addr, decodeCall(info.data));
  }

  async listCalls(agent: Bytes32): Promise<SolanaCallRecord[]> {
    const accounts = await this.transport.getProgramAccounts(this.programId, ACCOUNT_SIZE.Call, [
      { offset: 0, bytes: ACCOUNT_DISCRIMINATOR.Call },
      { offset: OFFSETS.callAgent, bytes: agent },
    ]);
    const records = await Promise.all(
      accounts.map((a) => this.toRecord(a.address, decodeCall(a.data))),
    );
    return records
      .filter((r) => bytesEqual(r.state.agent, agent))
      .sort((a, b) =>
        a.account.seal_ts === b.account.seal_ts
          ? a.address.localeCompare(b.address)
          : a.account.seal_ts < b.account.seal_ts
            ? -1
            : 1,
      );
  }

  // ---------------------------------------------------------------- extras (not in ChainAdapter)

  /** The program's immutable Config (cached after the first read). */
  config(): Promise<LoadedConfig> {
    this.configCache ??= (async () => {
      const addr = await configPda(this.programId);
      const info = await this.transport.getAccount(addr);
      if (info?.owner !== this.programId) {
        this.configCache = null;
        throw new CoreError(ErrorCode.ChainError, "program config is not initialized");
      }
      const account = decodeConfig(info.data);
      return { address: addr, account, params: configToParams(account) };
    })();
    return this.configCache;
  }

  /** The cluster clock (unix seconds). */
  async now(): Promise<bigint> {
    return this.transport.getUnixTimestamp();
  }

  /** Test-token balance of `owner` (its associated account for the config mint; 0 if none). */
  async tokenBalance(owner: Address): Promise<bigint> {
    const config = await this.config();
    const info = await this.transport.getAccount(
      await collateralAta(owner, config.account.collateral_mint),
    );
    return info === null ? 0n : getTokenDecoder().decode(info.data).amount;
  }

  /** Devnet/localnet faucet for the signer (guarded like every write). */
  async airdrop(lamportAmount: bigint): Promise<string> {
    const signer = this.requireSigner();
    await this.assertCluster();
    return this.transport.requestAirdrop(signer.address, lamportAmount);
  }

  /** Creates an SPL Token test mint whose mint authority is the signer. */
  async createTestMint(decimals: number): Promise<Tx<Address>> {
    const payer = this.requireSigner();
    const mint = await generateKeyPairSigner();
    const space = getMintSize();
    const sent = await this.send(
      [
        getCreateAccountInstruction({
          payer,
          newAccount: mint,
          lamports: await this.transport.rentExempt(space),
          space,
          programAddress: TOKEN_PROGRAM_ADDRESS,
        }),
        getInitializeMint2Instruction({
          mint: mint.address,
          decimals,
          mintAuthority: payer.address,
        }),
      ],
      { programIx: [] },
    );
    return { txId: sent.signature, value: mint.address };
  }

  /** Mints test tokens to `owner`'s associated account (signer must be the mint authority). */
  async mintTestTokens(mint: Address, owner: Address, amount: bigint): Promise<Tx<Address>> {
    const authority = this.requireSigner();
    if (amount <= 0n || amount > U64_MAX) {
      throw new CoreError(ErrorCode.InvalidAmount, "mint amount must be in (0, u64]");
    }
    const ata = await collateralAta(owner, mint);
    const sent = await this.send(
      [
        getCreateAssociatedTokenIdempotentInstruction({ payer: authority, ata, owner, mint }),
        getMintToInstruction({ mint, token: ata, mintAuthority: authority, amount }),
      ],
      { programIx: [] },
    );
    return { txId: sent.signature, value: ata };
  }

  /** One-time config, signed by the program's upgrade authority. */
  async initializeConfig(params: ProtocolParams, collateralMint: Address): Promise<Tx<Address>> {
    const authority = this.requireSigner();
    const config = await configPda(this.programId);
    const [programData] = await getProgramDerivedAddress({
      programAddress: BPF_LOADER_UPGRADEABLE,
      seeds: [getAddressEncoder().encode(this.programId)],
    });
    const sent = await this.send([
      buildIx(
        this.programId,
        "initializeConfig",
        {
          authority,
          config,
          program_data: programData,
          collateral_mint: collateralMint,
          system_program: SYSTEM_PROGRAM,
        },
        {
          reveal_window_secs: params.revealWindowSecs,
          min_lead_secs: params.minLeadSecs,
          max_horizon_secs: params.maxHorizonSecs,
          trade_cutoff_secs: params.tradeCutoffSecs,
          settle_window_secs: params.settleWindowSecs,
          max_conf_bps: Number(params.maxConfBps),
          void_after_secs: params.voidAfterSecs,
          min_level_expo: params.minLevelExpo,
          max_level_expo: params.maxLevelExpo,
          allowed_feed_ids: params.allowedFeedIds,
        },
      ),
    ]);
    this.configCache = null;
    return { txId: sent.signature, value: config };
  }

  // ---------------------------------------------------------------- internals

  private requireSigner(): TransactionSigner {
    if (this.signer === null) {
      throw new CoreError(ErrorCode.ReadOnly, "read-only adapter cannot send");
    }
    return this.signer;
  }

  private refAddress(ref: CallRef | MarketRef): Address {
    if (ref.chainId !== this.chainId || !isAddress(ref.id)) {
      throw new CoreError(ErrorCode.UnknownCall, `unknown call ${ref.chainId}/${ref.id}`);
    }
    return ref.id;
  }

  private async loadCall(addr: Address): Promise<CallAccount> {
    const info = await this.transport.getAccount(addr);
    if (info?.owner !== this.programId) {
      throw new CoreError(ErrorCode.UnknownCall, `unknown call ${addr}`);
    }
    return decodeCall(info.data);
  }

  private async positionsOf(call: Address) {
    const accounts = await this.transport.getProgramAccounts(
      this.programId,
      ACCOUNT_SIZE.Position,
      [
        { offset: 0, bytes: ACCOUNT_DISCRIMINATOR.Position },
        { offset: OFFSETS.positionCall, bytes: getAddressEncoder().encode(call) as Uint8Array },
      ],
    );
    return accounts
      .map((a) => ({ ...decodePosition(a.data), address: a.address }))
      .filter((p) => p.call === call)
      .sort((a, b) => (a.owner === b.owner ? a.side - b.side : a.owner.localeCompare(b.owner)));
  }

  private async toRecord(addr: Address, account: CallAccount): Promise<SolanaCallRecord> {
    const positions = account.market_open ? await this.positionsOf(addr) : [];
    const state = callToState(account, positions);
    let outcomeCheck: OutcomeCheck = "n/a";
    if (state.status === CallStatus.Settled) {
      outcomeCheck = checkOutcome(state, (await this.config()).params);
    }
    return {
      ref: { chainId: this.chainId, id: addr },
      market: account.market_open ? { chainId: this.chainId, id: addr } : null,
      state,
      address: addr,
      account,
      positions,
      outcomeCheck,
    };
  }

  /**
   * Re-checks the cluster, then sends. Failures become CoreErrors: custom codes of call_markets
   * instructions map through the program's error list (`programIx` defaults to every instruction).
   */
  private async send(
    ixs: readonly Instruction[],
    opts: { readonly programIx?: readonly number[]; readonly buyIx?: readonly number[] } = {},
  ): Promise<SentTx> {
    const signer = this.requireSigner();
    await this.assertCluster();
    try {
      return await this.transport.send(ixs, signer);
    } catch (e) {
      if (e instanceof TxFailedError) {
        throw toCoreError(e.failure, opts.programIx ?? ixs.map((_, i) => i), opts.buyIx ?? []);
      }
      throw e;
    }
  }
}

/** Convenience alias for `SolanaAdapter.connect`. */
export const connectSolanaAdapter = (opts: ConnectOptions): Promise<SolanaAdapter> =>
  SolanaAdapter.connect(opts);

/** Address ↔ the core's 32-byte agent id. */
export function addressFromBytes32(b: Bytes32): Address {
  return getAddressDecoder().decode(b);
}
