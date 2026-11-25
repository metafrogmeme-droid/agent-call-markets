use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable::get_program_data_address;

use crate::error::CallMarketsError;
use crate::events::ConfigInitialized;
use crate::logic::rule::{MAX_FEEDS, Params, validate_feeds, validate_params};
use crate::state::{CONFIG_SEED, Config};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ConfigArgs {
    pub reveal_window_secs: i64,
    pub min_lead_secs: i64,
    pub max_horizon_secs: i64,
    pub trade_cutoff_secs: i64,
    pub settle_window_secs: i64,
    pub max_conf_bps: u16,
    pub void_after_secs: i64,
    pub min_level_expo: i32,
    pub max_level_expo: i32,
    pub allowed_feed_ids: Vec<[u8; 32]>,
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,
    /// This program's ProgramData account (owned by the upgradeable loader). Only the upgrade
    /// authority can initialize, which prevents a front-run init with hostile parameters.
    #[account(
        address = get_program_data_address(&crate::ID) @ CallMarketsError::Unauthorized,
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ CallMarketsError::Unauthorized,
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(ctx: Context<InitializeConfig>, args: ConfigArgs) -> Result<()> {
    let params = Params {
        reveal_window_secs: args.reveal_window_secs,
        min_lead_secs: args.min_lead_secs,
        max_horizon_secs: args.max_horizon_secs,
        trade_cutoff_secs: args.trade_cutoff_secs,
        settle_window_secs: args.settle_window_secs,
        max_conf_bps: args.max_conf_bps,
        void_after_secs: args.void_after_secs,
        min_level_expo: args.min_level_expo,
        max_level_expo: args.max_level_expo,
    };
    validate_params(&params)?;
    validate_feeds(&args.allowed_feed_ids)?;

    let mut feeds = [[0u8; 32]; MAX_FEEDS];
    feeds[..args.allowed_feed_ids.len()].copy_from_slice(&args.allowed_feed_ids);
    let feed_count =
        u8::try_from(args.allowed_feed_ids.len()).map_err(|_| CallMarketsError::InvalidFeedList)?;

    let config = &mut ctx.accounts.config;
    config.bump = ctx.bumps.config;
    config.reveal_window_secs = params.reveal_window_secs;
    config.min_lead_secs = params.min_lead_secs;
    config.max_horizon_secs = params.max_horizon_secs;
    config.trade_cutoff_secs = params.trade_cutoff_secs;
    config.settle_window_secs = params.settle_window_secs;
    config.max_conf_bps = params.max_conf_bps;
    config.void_after_secs = params.void_after_secs;
    config.min_level_expo = params.min_level_expo;
    config.max_level_expo = params.max_level_expo;
    config.feed_count = feed_count;
    config.allowed_feed_ids = feeds;

    emit!(ConfigInitialized {
        authority: ctx.accounts.authority.key(),
        feed_count,
    });
    Ok(())
}
