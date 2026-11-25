// Solana adapter for the call_markets program (devnet/localnet only; mainnet is refused).
// See packages/adapter-solana/README.md and docs/DEVNET.md.
export * from "./constants.ts";
export * from "./guard.ts";
export * from "./pda.ts";
export {
  SolanaAdapter,
  connectSolanaAdapter,
  addressFromBytes32,
  type ConnectOptions,
  type LoadedConfig,
  type SolanaCallRecord,
} from "./adapter.ts";
export { checkOutcome, type OutcomeCheck } from "./outcome.ts";
export {
  RpcTransport,
  TxFailedError,
  type AccountInfo,
  type MemcmpFilter,
  type SentTx,
  type SolanaTransport,
} from "./transport.ts";
export { decodePriceUpdateV2, observationOf, type PriceUpdateV2 } from "./pyth.ts";
export {
  addressToBytes32,
  callToState,
  configToParams,
  decodeCall,
  decodeConfig,
  decodePosition,
  type CallAccount,
  type ConfigAccount,
  type PositionAccount,
} from "./codec/accounts.ts";
export { PROGRAM_ERROR_TO_CORE, type TxFailure } from "./codec/errors.ts";
