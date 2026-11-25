//! Protocol rules mirrored from the chain-agnostic core (`packages/core`), which is the reference
//! spec. Pure functions with no Anchor types so they can be unit tested on the host and checked
//! against `packages/core/test-vectors/settlement-v1.json`. Time arithmetic uses i128 so results
//! match the core's bigint arithmetic exactly (no overflow, no saturation).

use core::cmp::Ordering;

use super::seal::{CallFields, DIRECTION_ABOVE, DIRECTION_BELOW};

/// Exponents beyond this are rejected (core: MAX_ABS_EXPO).
pub const MAX_ABS_EXPO: u32 = 30;
/// Maximum number of allowed feeds stored in the config account.
pub const MAX_FEEDS: usize = 8;

/// Protocol parameters (core: ProtocolParams, without the feed list).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Params {
    pub reveal_window_secs: i64,
    pub min_lead_secs: i64,
    pub max_horizon_secs: i64,
    pub trade_cutoff_secs: i64,
    pub settle_window_secs: i64,
    pub max_conf_bps: u16,
    pub void_after_secs: i64,
    pub min_level_expo: i32,
    pub max_level_expo: i32,
}

/// Conservative defaults, provisional until Q9 is answered (core: DEFAULT_PARAMS).
pub const DEFAULT_PARAMS: Params = Params {
    reveal_window_secs: 900,
    min_lead_secs: 3_600,
    max_horizon_secs: 2_592_000,
    trade_cutoff_secs: 600,
    settle_window_secs: 10,
    max_conf_bps: 50,
    void_after_secs: 259_200,
    min_level_expo: -18,
    max_level_expo: 0,
};

/// One oracle price (core: OracleObservation). Pyth `conf` is unsigned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Observation {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
    pub prev_publish_time: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Hit,
    Miss,
}

/// Rule violations. `core_code` gives the matching core ErrorCode string.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuleError {
    InvalidParams,
    InvalidFeedList,
    InvalidDirection,
    ZeroFeed,
    ZeroSalt,
    InvalidLevel,
    InvalidExponent,
    FeedNotAllowed,
    ExpiryTooSoon,
    ExpiryTooFar,
    RevealTooEarly,
    RevealDeadlinePassed,
    NotExpired,
    SettlementWindowClosed,
    VoidTooEarly,
    FeedMismatch,
    ObservationOutsideWindow,
    ObservationNotUnique,
    NonPositivePrice,
    ConfidenceTooWide,
}

impl RuleError {
    pub fn core_code(self) -> &'static str {
        match self {
            RuleError::InvalidParams | RuleError::InvalidFeedList => "INVALID_PARAMS",
            RuleError::InvalidDirection => "INVALID_DIRECTION",
            RuleError::ZeroFeed => "ZERO_FEED",
            RuleError::ZeroSalt => "ZERO_SALT",
            RuleError::InvalidLevel => "INVALID_LEVEL",
            RuleError::InvalidExponent => "INVALID_EXPONENT",
            RuleError::FeedNotAllowed => "FEED_NOT_ALLOWED",
            RuleError::ExpiryTooSoon => "EXPIRY_TOO_SOON",
            RuleError::ExpiryTooFar => "EXPIRY_TOO_FAR",
            RuleError::RevealTooEarly => "REVEAL_TOO_EARLY",
            RuleError::RevealDeadlinePassed => "REVEAL_DEADLINE_PASSED",
            RuleError::NotExpired => "NOT_EXPIRED",
            RuleError::SettlementWindowClosed => "SETTLEMENT_WINDOW_CLOSED",
            RuleError::VoidTooEarly => "VOID_TOO_EARLY",
            RuleError::FeedMismatch => "FEED_MISMATCH",
            RuleError::ObservationOutsideWindow => "OBSERVATION_OUTSIDE_WINDOW",
            RuleError::ObservationNotUnique => "OBSERVATION_NOT_UNIQUE",
            RuleError::NonPositivePrice => "NON_POSITIVE_PRICE",
            RuleError::ConfidenceTooWide => "CONFIDENCE_TOO_WIDE",
        }
    }
}

/// core: validateParams (minus the feed list, see `validate_feeds`).
pub fn validate_params(p: &Params) -> Result<(), RuleError> {
    let secs = [
        p.reveal_window_secs,
        p.min_lead_secs,
        p.max_horizon_secs,
        p.trade_cutoff_secs,
        p.settle_window_secs,
        p.void_after_secs,
    ];
    if secs.iter().any(|&s| s <= 0) || p.max_conf_bps == 0 {
        return Err(RuleError::InvalidParams);
    }
    if i128::from(p.min_lead_secs)
        <= i128::from(p.reveal_window_secs) + i128::from(p.trade_cutoff_secs)
    {
        return Err(RuleError::InvalidParams);
    }
    if p.max_horizon_secs < p.min_lead_secs
        || p.max_conf_bps > 10_000
        || p.void_after_secs <= p.settle_window_secs
    {
        return Err(RuleError::InvalidParams);
    }
    if p.min_level_expo > p.max_level_expo || p.min_level_expo < -30 || p.max_level_expo > 30 {
        return Err(RuleError::InvalidParams);
    }
    Ok(())
}

/// On-chain feed list: 1..=MAX_FEEDS non-zero, unique ids. (Stricter than core, which allows an
/// empty list: an immutable on-chain config with no feeds could never be used.)
pub fn validate_feeds(feeds: &[[u8; 32]]) -> Result<(), RuleError> {
    if feeds.is_empty() || feeds.len() > MAX_FEEDS {
        return Err(RuleError::InvalidFeedList);
    }
    for (i, f) in feeds.iter().enumerate() {
        if *f == [0u8; 32] || feeds[..i].contains(f) {
            return Err(RuleError::InvalidFeedList);
        }
    }
    Ok(())
}

/// core: validateCall. Version is fixed to v1 on-chain; the agent is the transaction signer.
pub fn validate_call(
    call: &CallFields,
    salt: &[u8; 32],
    params: &Params,
    allowed_feeds: &[[u8; 32]],
) -> Result<(), RuleError> {
    if call.direction != DIRECTION_ABOVE && call.direction != DIRECTION_BELOW {
        return Err(RuleError::InvalidDirection);
    }
    if call.feed_id == [0u8; 32] {
        return Err(RuleError::ZeroFeed);
    }
    if *salt == [0u8; 32] {
        return Err(RuleError::ZeroSalt);
    }
    if call.level_mantissa <= 0 {
        return Err(RuleError::InvalidLevel);
    }
    if call.level_expo < params.min_level_expo || call.level_expo > params.max_level_expo {
        return Err(RuleError::InvalidExponent);
    }
    if !allowed_feeds.contains(&call.feed_id) {
        return Err(RuleError::FeedNotAllowed);
    }
    Ok(())
}

/// Exact comparison of `a_m * 10^a_e` and `b_m * 10^b_e` (core: compareFixed). Scales the side
/// with the larger exponent down to the smaller one; if that overflows u128, its true magnitude
/// exceeds u128::MAX and therefore the unscaled side, so the comparison is still exact.
pub fn compare_fixed(a_m: i128, a_e: i32, b_m: i128, b_e: i32) -> Ordering {
    let (sa, sb) = (a_m.signum(), b_m.signum());
    if sa != sb {
        return sa.cmp(&sb);
    }
    if sa == 0 {
        return Ordering::Equal;
    }
    let min_e = a_e.min(b_e);
    let scale = |m: i128, d: u32| {
        10u128
            .checked_pow(d)
            .and_then(|p| m.unsigned_abs().checked_mul(p))
    };
    let magnitude = match (
        scale(a_m, a_e.abs_diff(min_e)),
        scale(b_m, b_e.abs_diff(min_e)),
    ) {
        (Some(x), Some(y)) => x.cmp(&y),
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        // Unreachable: one side always has a zero scale.
        (None, None) => Ordering::Equal,
    };
    if sa > 0 {
        magnitude
    } else {
        magnitude.reverse()
    }
}

/// The settlement rule (core: decideOutcome), checks in the same order as the core.
pub fn decide_outcome(
    call: &CallFields,
    obs: &Observation,
    params: &Params,
) -> Result<Outcome, RuleError> {
    if obs.feed_id != call.feed_id {
        return Err(RuleError::FeedMismatch);
    }
    let expiry = i128::from(call.expiry_ts);
    let publish = i128::from(obs.publish_time);
    if publish < expiry || publish > expiry + i128::from(params.settle_window_secs) {
        return Err(RuleError::ObservationOutsideWindow);
    }
    if i128::from(obs.prev_publish_time) >= expiry {
        return Err(RuleError::ObservationNotUnique);
    }
    if obs.expo.unsigned_abs() > MAX_ABS_EXPO || call.level_expo.unsigned_abs() > MAX_ABS_EXPO {
        return Err(RuleError::InvalidExponent);
    }
    if obs.price <= 0 {
        return Err(RuleError::NonPositivePrice);
    }
    // price > 0 here, so the cast is lossless.
    if u128::from(obs.conf) * 10_000 > u128::from(params.max_conf_bps) * obs.price as u128 {
        return Err(RuleError::ConfidenceTooWide);
    }
    let price = i128::from(obs.price);
    let conf = i128::from(obs.conf);
    let level = i128::from(call.level_mantissa);
    let hit = if call.direction == DIRECTION_ABOVE {
        compare_fixed(price - conf, obs.expo, level, call.level_expo) == Ordering::Greater
    } else {
        compare_fixed(price + conf, obs.expo, level, call.level_expo) == Ordering::Less
    };
    Ok(if hit { Outcome::Hit } else { Outcome::Miss })
}

/// core: sealCall timing. Returns the reveal deadline.
pub fn seal_reveal_deadline(now: i64, expiry_ts: i64, params: &Params) -> Result<i64, RuleError> {
    let lead = i128::from(expiry_ts) - i128::from(now);
    if lead < i128::from(params.min_lead_secs) {
        return Err(RuleError::ExpiryTooSoon);
    }
    if lead > i128::from(params.max_horizon_secs) {
        return Err(RuleError::ExpiryTooFar);
    }
    now.checked_add(params.reveal_window_secs)
        .ok_or(RuleError::ExpiryTooFar)
}

/// core: revealCall timing (strictly after the seal, at or before the deadline).
pub fn check_reveal_time(now: i64, seal_ts: i64, reveal_deadline_ts: i64) -> Result<(), RuleError> {
    if now <= seal_ts {
        return Err(RuleError::RevealTooEarly);
    }
    if now > reveal_deadline_ts {
        return Err(RuleError::RevealDeadlinePassed);
    }
    Ok(())
}

/// core: tradingOpen (now < expiry - tradeCutoff).
pub fn trading_open(now: i64, expiry_ts: i64, params: &Params) -> bool {
    i128::from(now) < i128::from(expiry_ts) - i128::from(params.trade_cutoff_secs)
}

/// core: settleCall timing (now in [expiry, expiry + voidAfter)).
pub fn check_settle_time(now: i64, expiry_ts: i64, params: &Params) -> Result<(), RuleError> {
    if now < expiry_ts {
        return Err(RuleError::NotExpired);
    }
    if i128::from(now) >= i128::from(expiry_ts) + i128::from(params.void_after_secs) {
        return Err(RuleError::SettlementWindowClosed);
    }
    Ok(())
}

/// core: voidCall timing (now >= expiry + voidAfter).
pub fn check_void_time(now: i64, expiry_ts: i64, params: &Params) -> Result<(), RuleError> {
    if i128::from(now) < i128::from(expiry_ts) + i128::from(params.void_after_secs) {
        return Err(RuleError::VoidTooEarly);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEED: [u8; 32] = [0xf1; 32];

    fn call(direction: u8) -> CallFields {
        CallFields {
            agent: [0x11; 32],
            feed_id: FEED,
            direction,
            level_mantissa: 100_000_000,
            level_expo: -6,
            expiry_ts: 1_800_003_600,
        }
    }

    #[test]
    fn default_params_are_valid() {
        assert_eq!(validate_params(&DEFAULT_PARAMS), Ok(()));
    }

    #[test]
    fn invalid_params_are_rejected() {
        let bad = [
            Params {
                reveal_window_secs: 0,
                ..DEFAULT_PARAMS
            },
            Params {
                max_conf_bps: 0,
                ..DEFAULT_PARAMS
            },
            Params {
                min_lead_secs: 1_500,
                ..DEFAULT_PARAMS
            },
            Params {
                max_horizon_secs: 3_000,
                ..DEFAULT_PARAMS
            },
            Params {
                max_conf_bps: 10_001,
                ..DEFAULT_PARAMS
            },
            Params {
                void_after_secs: 10,
                ..DEFAULT_PARAMS
            },
            Params {
                min_level_expo: 1,
                ..DEFAULT_PARAMS
            },
            Params {
                min_level_expo: -31,
                ..DEFAULT_PARAMS
            },
            Params {
                reveal_window_secs: i64::MAX,
                trade_cutoff_secs: i64::MAX,
                ..DEFAULT_PARAMS
            },
        ];
        for p in bad {
            assert_eq!(validate_params(&p), Err(RuleError::InvalidParams), "{p:?}");
        }
    }

    #[test]
    fn feed_list_rules() {
        assert_eq!(validate_feeds(&[FEED]), Ok(()));
        assert_eq!(validate_feeds(&[]), Err(RuleError::InvalidFeedList));
        assert_eq!(
            validate_feeds(&[[0u8; 32]]),
            Err(RuleError::InvalidFeedList)
        );
        assert_eq!(
            validate_feeds(&[FEED, FEED]),
            Err(RuleError::InvalidFeedList)
        );
        assert_eq!(
            validate_feeds(&[FEED; MAX_FEEDS + 1]),
            Err(RuleError::InvalidFeedList)
        );
    }

    #[test]
    fn call_validation_mirrors_core() {
        let p = DEFAULT_PARAMS;
        let salt = [0x5a; 32];
        let ok = call(DIRECTION_ABOVE);
        assert_eq!(validate_call(&ok, &salt, &p, &[FEED]), Ok(()));
        let cases = [
            (
                CallFields { direction: 0, ..ok },
                salt,
                RuleError::InvalidDirection,
            ),
            (
                CallFields {
                    feed_id: [0; 32],
                    ..ok
                },
                salt,
                RuleError::ZeroFeed,
            ),
            (ok, [0; 32], RuleError::ZeroSalt),
            (
                CallFields {
                    level_mantissa: 0,
                    ..ok
                },
                salt,
                RuleError::InvalidLevel,
            ),
            (
                CallFields {
                    level_expo: 1,
                    ..ok
                },
                salt,
                RuleError::InvalidExponent,
            ),
            (
                CallFields {
                    level_expo: -19,
                    ..ok
                },
                salt,
                RuleError::InvalidExponent,
            ),
            (
                CallFields {
                    feed_id: [0xf2; 32],
                    ..ok
                },
                salt,
                RuleError::FeedNotAllowed,
            ),
        ];
        for (c, s, e) in cases {
            assert_eq!(validate_call(&c, &s, &p, &[FEED]), Err(e));
        }
    }

    /// Exact reference for small ranges: both sides fit i128 after scaling.
    fn reference(a_m: i128, a_e: i32, b_m: i128, b_e: i32) -> Ordering {
        let min_e = a_e.min(b_e);
        let a = a_m * 10i128.pow(a_e.abs_diff(min_e));
        let b = b_m * 10i128.pow(b_e.abs_diff(min_e));
        a.cmp(&b)
    }

    #[test]
    fn compare_fixed_matches_reference_on_a_grid() {
        let mantissas = [
            -1_000_001i128,
            -1_000,
            -7,
            -1,
            0,
            1,
            7,
            999,
            1_000,
            1_000_001,
        ];
        for &a in &mantissas {
            for &b in &mantissas {
                for ae in -6..=6 {
                    for be in -6..=6 {
                        assert_eq!(
                            compare_fixed(a, ae, b, be),
                            reference(a, ae, b, be),
                            "{a}e{ae} vs {b}e{be}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn compare_fixed_handles_overflowing_scales() {
        assert_eq!(
            compare_fixed(1, 30, i128::from(i64::MAX), -30),
            Ordering::Greater
        );
        assert_eq!(
            compare_fixed(-1, 30, -i128::from(i64::MAX), -30),
            Ordering::Less
        );
        assert_eq!(
            compare_fixed(i128::from(i64::MAX), -30, 1, 30),
            Ordering::Less
        );
        assert_eq!(compare_fixed(100, -2, 1, 0), Ordering::Equal);
    }

    #[test]
    fn timing_rules_mirror_core() {
        let p = DEFAULT_PARAMS;
        let now = 1_000_000;
        assert_eq!(
            seal_reveal_deadline(now, now + 3_599, &p),
            Err(RuleError::ExpiryTooSoon)
        );
        assert_eq!(
            seal_reveal_deadline(now, now + 2_592_001, &p),
            Err(RuleError::ExpiryTooFar)
        );
        assert_eq!(seal_reveal_deadline(now, now + 3_600, &p), Ok(now + 900));
        assert_eq!(
            seal_reveal_deadline(i64::MIN, i64::MAX, &p),
            Err(RuleError::ExpiryTooFar)
        );
        assert_eq!(
            check_reveal_time(now, now, now + 900),
            Err(RuleError::RevealTooEarly)
        );
        assert_eq!(
            check_reveal_time(now + 901, now, now + 900),
            Err(RuleError::RevealDeadlinePassed)
        );
        assert_eq!(check_reveal_time(now + 900, now, now + 900), Ok(()));
        let expiry = now + 3_600;
        assert!(trading_open(expiry - 601, expiry, &p));
        assert!(!trading_open(expiry - 600, expiry, &p));
        assert_eq!(
            check_settle_time(expiry - 1, expiry, &p),
            Err(RuleError::NotExpired)
        );
        assert_eq!(check_settle_time(expiry, expiry, &p), Ok(()));
        assert_eq!(
            check_settle_time(expiry + 259_200, expiry, &p),
            Err(RuleError::SettlementWindowClosed)
        );
        assert_eq!(
            check_void_time(expiry + 259_199, expiry, &p),
            Err(RuleError::VoidTooEarly)
        );
        assert_eq!(check_void_time(expiry + 259_200, expiry, &p), Ok(()));
    }

    #[test]
    fn below_direction_and_unknown_direction() {
        let obs = Observation {
            feed_id: FEED,
            price: 99_000_000,
            conf: 0,
            expo: -6,
            publish_time: 1_800_003_600,
            prev_publish_time: 1_800_003_599,
        };
        assert_eq!(
            decide_outcome(&call(DIRECTION_BELOW), &obs, &DEFAULT_PARAMS),
            Ok(Outcome::Hit)
        );
        assert_eq!(
            decide_outcome(&call(DIRECTION_ABOVE), &obs, &DEFAULT_PARAMS),
            Ok(Outcome::Miss)
        );
        let bad_level = CallFields {
            level_expo: 31,
            ..call(DIRECTION_ABOVE)
        };
        assert_eq!(
            decide_outcome(&bad_level, &obs, &DEFAULT_PARAMS),
            Err(RuleError::InvalidExponent)
        );
    }
}
