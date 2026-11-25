use anchor_lang::prelude::*;

use crate::error::CallMarketsError;
use crate::events::MarketOpened;
use crate::logic::rule::trading_open;
use crate::state::{CALL_SEED, CONFIG_SEED, Call, Config, STATUS_REVEALED};

#[derive(Accounts)]
pub struct OpenMarket<'info> {
    /// Anyone may open a market on a revealed call.
    pub opener: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [CALL_SEED, call.agent.as_ref(), call.commitment.as_ref()],
        bump = call.bump,
    )]
    pub call: Account<'info, Call>,
}

/// Opens the market on a revealed call before the trading cutoff. M2 records the opening; the
/// pool, vault, buy and redeem come with the market engine in M3.
pub fn handle_open_market(ctx: Context<OpenMarket>) -> Result<()> {
    let call = &mut ctx.accounts.call;
    require!(
        call.status == STATUS_REVEALED,
        CallMarketsError::WrongStatus
    );
    require!(!call.market_open, CallMarketsError::MarketAlreadyOpen);
    let now = Clock::get()?.unix_timestamp;
    require!(
        trading_open(now, call.expiry_ts, &ctx.accounts.config.params()),
        CallMarketsError::TradingClosed
    );
    call.market_open = true;
    call.market_opened_ts = now;
    emit!(MarketOpened {
        call: call.key(),
        opened_ts: now,
    });
    Ok(())
}
