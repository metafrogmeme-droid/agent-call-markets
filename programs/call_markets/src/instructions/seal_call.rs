use anchor_lang::prelude::*;

use crate::error::CallMarketsError;
use crate::events::CallSealed;
use crate::logic::rule::seal_reveal_deadline;
use crate::state::{CALL_SEED, CONFIG_SEED, Call, Config, OUTCOME_NONE, STATUS_SEALED};

#[derive(Accounts)]
#[instruction(commitment: [u8; 32])]
pub struct SealCall<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = agent,
        space = 8 + Call::INIT_SPACE,
        seeds = [CALL_SEED, agent.key().as_ref(), commitment.as_ref()],
        bump,
    )]
    pub call: Box<Account<'info, Call>>,
    pub system_program: Program<'info, System>,
}

/// Records the commitment and the public expiry. The call's content stays hidden until reveal.
pub fn handle_seal_call(
    ctx: Context<SealCall>,
    commitment: [u8; 32],
    expiry_ts: i64,
) -> Result<()> {
    require!(commitment != [0u8; 32], CallMarketsError::ZeroCommitment);
    let clock = Clock::get()?;
    let reveal_deadline_ts = seal_reveal_deadline(
        clock.unix_timestamp,
        expiry_ts,
        &ctx.accounts.config.params(),
    )?;

    let agent = ctx.accounts.agent.key();
    let call = &mut ctx.accounts.call;
    call.bump = ctx.bumps.call;
    call.status = STATUS_SEALED;
    call.agent = agent;
    call.commitment = commitment;
    call.seal_slot = clock.slot;
    call.seal_ts = clock.unix_timestamp;
    call.expiry_ts = expiry_ts;
    call.reveal_deadline_ts = reveal_deadline_ts;
    call.outcome = OUTCOME_NONE;

    emit!(CallSealed {
        call: call.key(),
        agent,
        commitment,
        expiry_ts,
        reveal_deadline_ts,
    });
    Ok(())
}
