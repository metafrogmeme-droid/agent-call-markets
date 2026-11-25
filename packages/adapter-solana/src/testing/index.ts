// Test and localnet-fixture helpers ("@agent-call-markets/adapter-solana/testing").
// Synthetic Pyth accounts only exist in tests and on a local validator; on a real cluster price
// updates are posted by the Pyth receiver program.
export {
  encodePriceUpdateV2,
  PRICE_UPDATE_V2_DISCRIMINATOR,
  PRICE_UPDATE_V2_LEN,
  type VerificationLevel,
} from "../pyth.ts";
