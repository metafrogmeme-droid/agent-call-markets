//! Agent Call Markets: an agent seals a call before the outcome is known, reveals it, a market
//! can open on it, and a Pyth price update settles it once.
//!
//! Hackathon demo on Solana devnet with test tokens only. Not a live market, not gambling, and
//! not financial advice. Unaudited.
//!
//! The chain-agnostic core (`packages/core`) is the reference spec; `logic` mirrors it and is
//! checked against the shared golden vectors.

use anchor_lang::prelude::*;

pub mod error;
pub mod events;
pub mod instructions;
pub mod logic;
pub mod state;

pub use instructions::*;

// Placeholder id: sha256("agent-call-markets/call_markets/placeholder-program-id/v1"), not a key
// anyone holds. A human runs `anchor keys sync` before any devnet deploy (docs/DECISIONS.md).
declare_id!("4SG3dvvHerGBWpbCTTEfcSXRLCiPqBtgF9za8CTnFgVq");

#[program]
pub mod call_markets {
    use super::*;

    /// One-time config by the program upgrade authority. Immutable afterwards.
    pub fn initialize_config(ctx: Context<InitializeConfig>, args: ConfigArgs) -> Result<()> {
        handle_initialize_config(ctx, args)
    }

    pub fn seal_call(ctx: Context<SealCall>, commitment: [u8; 32], expiry_ts: i64) -> Result<()> {
        handle_seal_call(ctx, commitment, expiry_ts)
    }

    pub fn reveal_call(ctx: Context<RevealCall>, args: RevealArgs) -> Result<()> {
        handle_reveal_call(ctx, args)
    }

    pub fn open_market(ctx: Context<OpenMarket>) -> Result<()> {
        handle_open_market(ctx)
    }

    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        handle_settle(ctx)
    }

    pub fn void_unsettled(ctx: Context<VoidUnsettled>) -> Result<()> {
        handle_void_unsettled(ctx)
    }
}
