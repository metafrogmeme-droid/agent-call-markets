use anchor_lang::prelude::*;

use crate::error::CallMarketsError;
use crate::events::CallRevealed;
use crate::logic::rule::{check_reveal_time, validate_call};
use crate::logic::seal::{CallFields, commitment};
use crate::state::{CALL_SEED, CONFIG_SEED, Call, Config, STATUS_REVEALED, STATUS_SEALED};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct RevealArgs {
    pub feed_id: [u8; 32],
    pub direction: u8,
    pub level_mantissa: i64,
    pub level_expo: i32,
    pub salt: [u8; 32],
}

#[derive(Accounts)]
pub struct RevealCall<'info> {
    pub agent: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [CALL_SEED, call.agent.as_ref(), call.commitment.as_ref()],
        bump = call.bump,
        has_one = agent @ CallMarketsError::WrongSigner,
    )]
    pub call: Box<Account<'info, Call>>,
}

/// Reveal-at-open (Q5): the agent opens the commitment strictly after the seal (later slot and
/// later second) and by the reveal deadline. Checks run in the same order as the core.
pub fn handle_reveal_call(ctx: Context<RevealCall>, args: RevealArgs) -> Result<()> {
    let call = &mut ctx.accounts.call;
    require!(call.status == STATUS_SEALED, CallMarketsError::WrongStatus);
    let clock = Clock::get()?;
    require!(
        clock.slot > call.seal_slot,
        CallMarketsError::RevealTooEarly
    );
    check_reveal_time(clock.unix_timestamp, call.seal_ts, call.reveal_deadline_ts)?;

    let fields = CallFields {
        agent: call.agent.to_bytes(),
        feed_id: args.feed_id,
        direction: args.direction,
        level_mantissa: args.level_mantissa,
        level_expo: args.level_expo,
        expiry_ts: call.expiry_ts,
    };
    require!(
        commitment(&fields, &args.salt) == call.commitment,
        CallMarketsError::CommitmentMismatch
    );
    let config = &ctx.accounts.config;
    validate_call(&fields, &args.salt, &config.params(), config.feeds())?;

    call.feed_id = args.feed_id;
    call.direction = args.direction;
    call.level_mantissa = args.level_mantissa;
    call.level_expo = args.level_expo;
    call.salt = args.salt;
    call.reveal_slot = clock.slot;
    call.reveal_ts = clock.unix_timestamp;
    call.status = STATUS_REVEALED;

    emit!(CallRevealed {
        call: call.key(),
        agent: call.agent,
    });
    Ok(())
}
