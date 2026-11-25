//! Seal format ACM-SEAL-V1 (provisional, docs/DECISIONS.md Q6). Mirrors
//! `packages/core/src/seal/codec.ts` and `commit.ts` byte for byte; checked against the shared
//! golden vectors in `packages/core/test-vectors/seal-v1.json`.

use solana_sha256_hasher::hashv;

pub const SEAL_VERSION_V1: u8 = 1;
/// "ACM-SEAL-V1" followed by a 0x00 separator.
pub const SEAL_DOMAIN_PREFIX: &[u8; 12] = b"ACM-SEAL-V1\0";
pub const SEAL_V1_PREIMAGE_LEN: usize = 118;

pub const DIRECTION_ABOVE: u8 = 1;
pub const DIRECTION_BELOW: u8 = 2;

/// The public content of a call (the salt is kept separately).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CallFields {
    pub agent: [u8; 32],
    pub feed_id: [u8; 32],
    pub direction: u8,
    pub level_mantissa: i64,
    pub level_expo: i32,
    pub expiry_ts: i64,
}

/// Fixed-width big-endian preimage: version | agent | feed | direction | level mantissa |
/// level expo | expiry | salt.
pub fn encode_preimage(call: &CallFields, salt: &[u8; 32]) -> [u8; SEAL_V1_PREIMAGE_LEN] {
    let mut out = [0u8; SEAL_V1_PREIMAGE_LEN];
    out[0] = SEAL_VERSION_V1;
    out[1..33].copy_from_slice(&call.agent);
    out[33..65].copy_from_slice(&call.feed_id);
    out[65] = call.direction;
    out[66..74].copy_from_slice(&call.level_mantissa.to_be_bytes());
    out[74..78].copy_from_slice(&call.level_expo.to_be_bytes());
    out[78..86].copy_from_slice(&call.expiry_ts.to_be_bytes());
    out[86..118].copy_from_slice(salt);
    out
}

/// commitment = SHA-256("ACM-SEAL-V1" || 0x00 || preimage)
pub fn commitment(call: &CallFields, salt: &[u8; 32]) -> [u8; 32] {
    hashv(&[SEAL_DOMAIN_PREFIX, &encode_preimage(call, salt)]).to_bytes()
}
