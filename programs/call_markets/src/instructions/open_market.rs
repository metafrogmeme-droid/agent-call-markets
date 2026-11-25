use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::error::CallMarketsError;
use crate::events::MarketOpened;
use crate::logic::rule::trading_open;
use crate::state::{CALL_SEED, CONFIG_SEED, Call, Config, STATUS_REVEALED, VAULT_SEED};

#[derive(Accounts)]
pub struct OpenMarket<'info> {
    /// Anyone may open a market on a revealed call; the opener pays the vault's rent.
    #[account(mut)]
    pub opener: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [CALL_SEED, call.agent.as_ref(), call.commitment.as_ref()],
        bump = call.bump,
    )]
    pub call: Account<'info, Call>,
    #[account(address = config.collateral_mint @ CallMarketsError::WrongMint)]
    pub collateral_mint: Account<'info, Mint>,
    /// The market's vault, PDA ["vault", call]; its token authority is the call PDA, so only this
    /// program can move funds out (redeem).
    #[account(
        init,
        payer = opener,
        seeds = [VAULT_SEED, call.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = call,
        token::token_program = token_program,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Opens the parimutuel market on a revealed call before the trading cutoff and creates its vault.
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
    call.pool_yes = 0;
    call.pool_no = 0;
    emit!(MarketOpened {
        call: call.key(),
        opened_ts: now,
    });
    Ok(())
}
