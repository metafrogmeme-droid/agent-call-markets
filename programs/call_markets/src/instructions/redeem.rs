use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount, TransferChecked, transfer_checked};

use crate::error::CallMarketsError;
use crate::events::Redeemed;
use crate::logic::parimutuel::payout;
use crate::state::{CALL_SEED, CONFIG_SEED, Call, Config, POSITION_SEED, Position, VAULT_SEED};

#[derive(Accounts)]
pub struct Redeem<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [CALL_SEED, call.agent.as_ref(), call.commitment.as_ref()],
        bump = call.bump,
    )]
    pub call: Box<Account<'info, Call>>,
    #[account(address = config.collateral_mint @ CallMarketsError::WrongMint)]
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [VAULT_SEED, call.key().as_ref()], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// Payouts go only to a token account the position owner owns.
    #[account(
        mut,
        constraint = owner_token.mint == config.collateral_mint @ CallMarketsError::WrongMint,
        constraint = owner_token.owner == owner.key() @ CallMarketsError::WrongSigner,
    )]
    pub owner_token: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [POSITION_SEED, call.key().as_ref(), owner.key().as_ref(), &[position.side]],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,
    pub token_program: Program<'info, Token>,
}

/// Pays out one position once the market is settled (winners split the pool) or void (refund).
/// Each position is redeemed once; losing positions are marked redeemed with a zero payout.
pub fn handle_redeem(ctx: Context<Redeem>) -> Result<()> {
    let call = &ctx.accounts.call;
    let resolution = call.resolution().ok_or(CallMarketsError::NotRedeemable)?;
    let position = &mut ctx.accounts.position;
    require!(!position.redeemed, CallMarketsError::NothingToRedeem);
    let amount = payout(position.side, position.amount, call.pool(), resolution);
    position.redeemed = true;

    if amount > 0 {
        let bump = [call.bump];
        let seeds: &[&[u8]] = &[
            CALL_SEED,
            call.agent.as_ref(),
            call.commitment.as_ref(),
            &bump,
        ];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    to: ctx.accounts.owner_token.to_account_info(),
                    authority: call.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.config.collateral_decimals,
        )?;
    }
    emit!(Redeemed {
        call: call.key(),
        owner: position.owner,
        side: position.side,
        payout: amount,
    });
    Ok(())
}
