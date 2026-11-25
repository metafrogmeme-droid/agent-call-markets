use anchor_lang::prelude::*;

use crate::error::CallMarketsError;
use crate::events::CallVoided;
use crate::logic::rule::check_void_time;
use crate::state::{
    CALL_SEED, CONFIG_SEED, Call, Config, STATUS_REVEALED, STATUS_SETTLED, STATUS_VOID,
};

#[derive(Accounts)]
pub struct VoidUnsettled<'info> {
    /// Permissionless.
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [CALL_SEED, call.agent.as_ref(), call.commitment.as_ref()],
        bump = call.bump,
    )]
    pub call: Account<'info, Call>,
}

/// Voids a revealed call that was not settled by expiry + voidAfterSecs, so stakes can be
/// refunded (M3). A void is never counted as a hit or a miss (Q10).
pub fn handle_void_unsettled(ctx: Context<VoidUnsettled>) -> Result<()> {
    let call = &mut ctx.accounts.call;
    match call.status {
        STATUS_SETTLED => return err!(CallMarketsError::AlreadySettled),
        STATUS_VOID => return err!(CallMarketsError::AlreadyVoid),
        STATUS_REVEALED => {}
        _ => return err!(CallMarketsError::WrongStatus),
    }
    let now = Clock::get()?.unix_timestamp;
    check_void_time(now, call.expiry_ts, &ctx.accounts.config.params())?;
    call.status = STATUS_VOID;
    call.settled_ts = now;
    emit!(CallVoided { call: call.key() });
    Ok(())
}
