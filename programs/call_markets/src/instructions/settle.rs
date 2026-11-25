use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};

use crate::error::CallMarketsError;
use crate::events::CallSettled;
use crate::logic::rule::{Observation, Outcome, check_settle_time, decide_outcome};
use crate::state::{
    CALL_SEED, CONFIG_SEED, Call, Config, OUTCOME_HIT, OUTCOME_MISS, STATUS_REVEALED,
    STATUS_SETTLED, STATUS_VOID,
};

#[derive(Accounts)]
pub struct Settle<'info> {
    /// Settlement is permissionless; the signer only pays the transaction fee.
    pub settler: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [CALL_SEED, call.agent.as_ref(), call.commitment.as_ref()],
        bump = call.bump,
    )]
    pub call: Account<'info, Call>,
    /// A Pyth price update. `Account<PriceUpdateV2>` checks that the Pyth receiver program owns
    /// it; the handler requires full Wormhole verification and the core settlement rule.
    pub price_update: Account<'info, PriceUpdateV2>,
}

/// Decides HIT or MISS once, from the unique Pyth update covering expiry. Fails closed on any
/// rule violation; once settled, nothing can change the outcome.
pub fn handle_settle(ctx: Context<Settle>) -> Result<()> {
    let call = &mut ctx.accounts.call;
    match call.status {
        STATUS_SETTLED => return err!(CallMarketsError::AlreadySettled),
        STATUS_VOID => return err!(CallMarketsError::AlreadyVoid),
        STATUS_REVEALED => {}
        _ => return err!(CallMarketsError::WrongStatus),
    }
    let now = Clock::get()?.unix_timestamp;
    let params = ctx.accounts.config.params();
    check_settle_time(now, call.expiry_ts, &params)?;

    let update = &ctx.accounts.price_update;
    require!(
        matches!(update.verification_level, VerificationLevel::Full),
        CallMarketsError::OracleNotFullyVerified
    );
    let msg = &update.price_message;
    require!(
        msg.publish_time <= now,
        CallMarketsError::ObservationOutsideWindow
    );
    let obs = Observation {
        feed_id: msg.feed_id,
        price: msg.price,
        conf: msg.conf,
        expo: msg.exponent,
        publish_time: msg.publish_time,
        prev_publish_time: msg.prev_publish_time,
    };
    let outcome = decide_outcome(&call.fields(), &obs, &params)?;

    call.outcome = match outcome {
        Outcome::Hit => OUTCOME_HIT,
        Outcome::Miss => OUTCOME_MISS,
    };
    call.obs_price = obs.price;
    call.obs_conf = obs.conf;
    call.obs_expo = obs.expo;
    call.obs_publish_time = obs.publish_time;
    call.obs_prev_publish_time = obs.prev_publish_time;
    call.settled_ts = now;
    call.settler = ctx.accounts.settler.key();
    call.status = STATUS_SETTLED;

    emit!(CallSettled {
        call: call.key(),
        outcome: call.outcome,
        settler: call.settler,
    });
    Ok(())
}
