use anchor_lang::prelude::*;

use crate::error::CallMarketsError;
use crate::events::PositionOpened;
use crate::logic::parimutuel::check_side;
use crate::state::{CALL_SEED, Call, POSITION_SEED, Position};

#[derive(Accounts)]
#[instruction(side: u8)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [CALL_SEED, call.agent.as_ref(), call.commitment.as_ref()],
        bump = call.bump,
    )]
    pub call: Box<Account<'info, Call>>,
    #[account(
        init,
        payer = owner,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, call.key().as_ref(), owner.key().as_ref(), &[side]],
        bump,
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

/// Creates the owner's position for one side of an open market (explicit init; no
/// init-if-needed). Stakes are added with `buy`.
pub fn handle_open_position(ctx: Context<OpenPosition>, side: u8) -> Result<()> {
    check_side(side)?;
    require!(
        ctx.accounts.call.market_open,
        CallMarketsError::MarketNotOpen
    );
    let position = &mut ctx.accounts.position;
    position.bump = ctx.bumps.position;
    position.call = ctx.accounts.call.key();
    position.owner = ctx.accounts.owner.key();
    position.side = side;
    position.amount = 0;
    position.redeemed = false;
    emit!(PositionOpened {
        call: position.call,
        owner: position.owner,
        side,
    });
    Ok(())
}
