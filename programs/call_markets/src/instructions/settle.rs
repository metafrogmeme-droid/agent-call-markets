use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};

use crate::error::CallMarketsError;
use crate::events::CallSettled;
use crate::logic::rule::{Observation, Outcome, check_settle_time, decide_outcome};
use crate::state::{
    CALL_SEED, CONFIG_SEED, Call, Config, OUTCOME_HIT, OUTCOME_MISS, PYTH_RECEIVER_PROGRAM_ID,
    STATUS_REVEALED, STATUS_SETTLED, STATUS_VOID,
};

#[derive(Accounts)]
pub struct Settle<'info> {
    /// Settlement is permissionless; the signer only pays the transaction fee.
    pub settler: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [CALL_SEED, call.agent.as_ref(), call.commitment.as_ref()],
        bump = call.bump,
    )]
    pub call: Box<Account<'info, Call>>,
    /// CHECK: owner pinned to PYTH_RECEIVER_PROGRAM_ID (any other owner is rejected); the data is
    /// decoded as a PriceUpdateV2, discriminator included, in the handler.
    #[account(owner = PYTH_RECEIVER_PROGRAM_ID @ CallMarketsError::OracleOwnerMismatch)]
    pub price_update: UncheckedAccount<'info>,
}

fn observation_of(update: &PriceUpdateV2) -> Observation {
    let msg = &update.price_message;
    Observation {
        feed_id: msg.feed_id,
        price: msg.price,
        conf: msg.conf,
        expo: msg.exponent,
        publish_time: msg.publish_time,
        prev_publish_time: msg.prev_publish_time,
    }
}

fn is_accepted_observation(call: &Call, obs: &Observation) -> bool {
    obs.feed_id == call.feed_id
        && obs.price == call.obs_price
        && obs.conf == call.obs_conf
        && obs.expo == call.obs_expo
        && obs.publish_time == call.obs_publish_time
        && obs.prev_publish_time == call.obs_prev_publish_time
}

/// Decides HIT or MISS from exactly one accepted price update per market: the unique Pyth update
/// covering expiry, published inside the settlement window. Fails closed on any rule violation.
/// Once settled, the same update again (same account or same message) is rejected as a duplicate,
/// and any other update is rejected too; the outcome never changes.
pub fn handle_settle(ctx: Context<Settle>) -> Result<()> {
    let update_key = ctx.accounts.price_update.key();
    let update = {
        let data = ctx.accounts.price_update.try_borrow_data()?;
        PriceUpdateV2::try_deserialize(&mut &data[..])?
    };
    let obs = observation_of(&update);

    let call = &mut ctx.accounts.call;
    match call.status {
        STATUS_SETTLED => {
            if update_key == call.accepted_update || is_accepted_observation(call, &obs) {
                return err!(CallMarketsError::DuplicatePriceUpdate);
            }
            return err!(CallMarketsError::AlreadySettled);
        }
        STATUS_VOID => return err!(CallMarketsError::AlreadyVoid),
        STATUS_REVEALED => {}
        _ => return err!(CallMarketsError::WrongStatus),
    }
    let now = Clock::get()?.unix_timestamp;
    let params = ctx.accounts.config.params();
    check_settle_time(now, call.expiry_ts, &params)?;
    require!(
        matches!(update.verification_level, VerificationLevel::Full),
        CallMarketsError::OracleNotFullyVerified
    );
    require!(
        obs.publish_time <= now,
        CallMarketsError::ObservationOutsideWindow
    );
    let outcome = decide_outcome(&call.fields(), &obs, &params)?;

    call.outcome = match outcome {
        Outcome::Hit => OUTCOME_HIT,
        Outcome::Miss => OUTCOME_MISS,
    };
    call.accepted_update = update_key;
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
