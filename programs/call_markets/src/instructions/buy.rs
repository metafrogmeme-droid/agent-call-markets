use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount, TransferChecked, transfer_checked};

use crate::error::CallMarketsError;
use crate::events::Bought;
use crate::logic::parimutuel::{add_stake, projected_payout};
use crate::logic::rule::trading_open;
use crate::state::{
    CALL_SEED, CONFIG_SEED, Call, Config, POSITION_SEED, Position, STATUS_REVEALED, VAULT_SEED,
};

#[derive(Accounts)]
pub struct Buy<'info> {
    pub buyer: Signer<'info>,
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
    #[account(mut, seeds = [VAULT_SEED, call.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = buyer_token.mint == config.collateral_mint @ CallMarketsError::WrongMint,
    )]
    pub buyer_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [POSITION_SEED, call.key().as_ref(), buyer.key().as_ref(), &[position.side]],
        bump = position.bump,
    )]
    pub position: Account<'info, Position>,
    pub token_program: Program<'info, Token>,
}

/// Adds `amount` test tokens to the buyer's position. Checks run in the core's order (market
/// open, trading open, amount, payout limit). `min_projected_payout` guards against the pool
/// moving between quote and buy; the final payout is only known at settlement (parimutuel).
pub fn handle_buy(ctx: Context<Buy>, amount: u64, min_projected_payout: u64) -> Result<()> {
    let call = &mut ctx.accounts.call;
    require!(call.market_open, CallMarketsError::MarketNotOpen);
    let now = Clock::get()?.unix_timestamp;
    require!(
        call.status == STATUS_REVEALED
            && trading_open(now, call.expiry_ts, &ctx.accounts.config.params()),
        CallMarketsError::TradingClosed
    );
    let side = ctx.accounts.position.side;
    let projected = projected_payout(call.pool(), side, amount)?;
    require!(
        projected >= min_projected_payout,
        CallMarketsError::LimitNotMet
    );
    let pool = add_stake(call.pool(), side, amount)?;

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.buyer_token.to_account_info(),
                mint: ctx.accounts.collateral_mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.config.collateral_decimals,
    )?;

    call.pool_yes = pool.yes;
    call.pool_no = pool.no;
    let position = &mut ctx.accounts.position;
    position.amount = position
        .amount
        .checked_add(amount)
        .ok_or(CallMarketsError::InvalidAmount)?;
    emit!(Bought {
        call: call.key(),
        owner: position.owner,
        side,
        amount,
    });
    Ok(())
}
