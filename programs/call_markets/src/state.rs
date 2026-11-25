use anchor_lang::prelude::*;

use crate::logic::rule::{MAX_FEEDS, Params};
use crate::logic::seal::CallFields;

pub const CONFIG_SEED: &[u8] = b"config";
pub const CALL_SEED: &[u8] = b"call";

pub const STATUS_SEALED: u8 = 1;
pub const STATUS_REVEALED: u8 = 2;
pub const STATUS_SETTLED: u8 = 3;
pub const STATUS_VOID: u8 = 4;

pub const OUTCOME_NONE: u8 = 0;
pub const OUTCOME_HIT: u8 = 1;
pub const OUTCOME_MISS: u8 = 2;

/// Protocol parameters, written once by the program's upgrade authority. There is no update
/// instruction and no outcome override (docs/DECISIONS.md, Q15).
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub bump: u8,
    pub reveal_window_secs: i64,
    pub min_lead_secs: i64,
    pub max_horizon_secs: i64,
    pub trade_cutoff_secs: i64,
    pub settle_window_secs: i64,
    pub max_conf_bps: u16,
    pub void_after_secs: i64,
    pub min_level_expo: i32,
    pub max_level_expo: i32,
    pub feed_count: u8,
    pub allowed_feed_ids: [[u8; 32]; MAX_FEEDS],
}

impl Config {
    pub fn params(&self) -> Params {
        Params {
            reveal_window_secs: self.reveal_window_secs,
            min_lead_secs: self.min_lead_secs,
            max_horizon_secs: self.max_horizon_secs,
            trade_cutoff_secs: self.trade_cutoff_secs,
            settle_window_secs: self.settle_window_secs,
            max_conf_bps: self.max_conf_bps,
            void_after_secs: self.void_after_secs,
            min_level_expo: self.min_level_expo,
            max_level_expo: self.max_level_expo,
        }
    }

    pub fn feeds(&self) -> &[[u8; 32]] {
        let n = usize::from(self.feed_count).min(MAX_FEEDS);
        &self.allowed_feed_ids[..n]
    }
}

/// One sealed call, PDA ["call", agent, commitment]. Holds the full public record of the call:
/// seal, reveal, market opening and settlement observation, so the record page can recompute
/// every outcome from chain data with the core.
#[account]
#[derive(InitSpace)]
pub struct Call {
    pub bump: u8,
    pub status: u8,
    pub agent: Pubkey,
    pub commitment: [u8; 32],
    pub seal_slot: u64,
    pub seal_ts: i64,
    pub expiry_ts: i64,
    pub reveal_deadline_ts: i64,
    // Revealed call (zero until revealed).
    pub feed_id: [u8; 32],
    pub direction: u8,
    pub level_mantissa: i64,
    pub level_expo: i32,
    pub salt: [u8; 32],
    pub reveal_slot: u64,
    pub reveal_ts: i64,
    // Market (M2 records the opening; the pool and vault arrive in M3).
    pub market_open: bool,
    pub market_opened_ts: i64,
    // Settlement.
    pub outcome: u8,
    pub obs_price: i64,
    pub obs_conf: u64,
    pub obs_expo: i32,
    pub obs_publish_time: i64,
    pub obs_prev_publish_time: i64,
    pub settled_ts: i64,
    pub settler: Pubkey,
}

impl Call {
    /// The revealed call as committed (only meaningful once revealed).
    pub fn fields(&self) -> CallFields {
        CallFields {
            agent: self.agent.to_bytes(),
            feed_id: self.feed_id,
            direction: self.direction,
            level_mantissa: self.level_mantissa,
            level_expo: self.level_expo,
            expiry_ts: self.expiry_ts,
        }
    }
}
