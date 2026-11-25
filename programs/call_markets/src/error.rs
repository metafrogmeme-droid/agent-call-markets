use anchor_lang::prelude::*;

use crate::logic::rule::RuleError;

/// Program errors. Names match the core's ErrorCode where the rule is shared.
#[error_code]
pub enum CallMarketsError {
    #[msg("Invalid protocol parameters")]
    InvalidParams,
    #[msg("Feed list must have 1-8 unique, non-zero feed ids")]
    InvalidFeedList,
    #[msg("Only the program upgrade authority can initialize the config")]
    Unauthorized,
    #[msg("Commitment must be a non-zero 32-byte hash")]
    ZeroCommitment,
    #[msg("Expiry is too soon after the seal")]
    ExpiryTooSoon,
    #[msg("Expiry is too far after the seal")]
    ExpiryTooFar,
    #[msg("Only the sealing agent can reveal")]
    WrongSigner,
    #[msg("Call is not in the required status")]
    WrongStatus,
    #[msg("Reveal must come strictly after the seal (later slot and later second)")]
    RevealTooEarly,
    #[msg("Reveal deadline has passed; the call counts as a miss")]
    RevealDeadlinePassed,
    #[msg("Call and salt do not open the commitment")]
    CommitmentMismatch,
    #[msg("Invalid direction")]
    InvalidDirection,
    #[msg("Feed id must be non-zero")]
    ZeroFeed,
    #[msg("Salt must be non-zero")]
    ZeroSalt,
    #[msg("Level mantissa must be positive")]
    InvalidLevel,
    #[msg("Exponent out of range")]
    InvalidExponent,
    #[msg("Feed is not in the allowlist")]
    FeedNotAllowed,
    #[msg("Market already open")]
    MarketAlreadyOpen,
    #[msg("Trading is closed")]
    TradingClosed,
    #[msg("Call has not expired yet")]
    NotExpired,
    #[msg("Settlement window closed; the call can only be voided")]
    SettlementWindowClosed,
    #[msg("Already settled")]
    AlreadySettled,
    #[msg("Already void")]
    AlreadyVoid,
    #[msg("Void is only possible after expiry + voidAfterSecs")]
    VoidTooEarly,
    #[msg("Oracle update is not fully verified")]
    OracleNotFullyVerified,
    #[msg("Observation feed does not match the committed feed")]
    FeedMismatch,
    #[msg("Observation publish time is outside the settlement window")]
    ObservationOutsideWindow,
    #[msg("Observation must be the unique update covering expiry")]
    ObservationNotUnique,
    #[msg("Observation price must be positive")]
    NonPositivePrice,
    #[msg("Observation confidence interval is too wide")]
    ConfidenceTooWide,
}

impl From<RuleError> for CallMarketsError {
    fn from(e: RuleError) -> Self {
        match e {
            RuleError::InvalidParams => CallMarketsError::InvalidParams,
            RuleError::InvalidFeedList => CallMarketsError::InvalidFeedList,
            RuleError::InvalidDirection => CallMarketsError::InvalidDirection,
            RuleError::ZeroFeed => CallMarketsError::ZeroFeed,
            RuleError::ZeroSalt => CallMarketsError::ZeroSalt,
            RuleError::InvalidLevel => CallMarketsError::InvalidLevel,
            RuleError::InvalidExponent => CallMarketsError::InvalidExponent,
            RuleError::FeedNotAllowed => CallMarketsError::FeedNotAllowed,
            RuleError::ExpiryTooSoon => CallMarketsError::ExpiryTooSoon,
            RuleError::ExpiryTooFar => CallMarketsError::ExpiryTooFar,
            RuleError::RevealTooEarly => CallMarketsError::RevealTooEarly,
            RuleError::RevealDeadlinePassed => CallMarketsError::RevealDeadlinePassed,
            RuleError::NotExpired => CallMarketsError::NotExpired,
            RuleError::SettlementWindowClosed => CallMarketsError::SettlementWindowClosed,
            RuleError::VoidTooEarly => CallMarketsError::VoidTooEarly,
            RuleError::FeedMismatch => CallMarketsError::FeedMismatch,
            RuleError::ObservationOutsideWindow => CallMarketsError::ObservationOutsideWindow,
            RuleError::ObservationNotUnique => CallMarketsError::ObservationNotUnique,
            RuleError::NonPositivePrice => CallMarketsError::NonPositivePrice,
            RuleError::ConfidenceTooWide => CallMarketsError::ConfidenceTooWide,
        }
    }
}

impl From<RuleError> for anchor_lang::error::Error {
    fn from(e: RuleError) -> Self {
        CallMarketsError::from(e).into()
    }
}
