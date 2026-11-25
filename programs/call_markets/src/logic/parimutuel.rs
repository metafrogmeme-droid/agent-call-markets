//! Parimutuel pool maths, mirrored from `packages/core/src/parimutuel.ts` and checked against
//! `packages/core/test-vectors/pool-v1.json`. No fees. Winners split the whole pool pro rata with
//! floor rounding (dust stays in the vault); VOID, or nobody on the winning side, refunds stakes.
//! Pool totals stay <= u64::MAX; products use u128 so nothing can overflow.

pub const SIDE_YES: u8 = 1;
pub const SIDE_NO: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolution {
    Yes,
    No,
    Void,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoolError {
    /// Stake is zero, or the pool total would exceed u64::MAX (core: INVALID_AMOUNT).
    InvalidAmount,
    /// Side is neither YES nor NO.
    InvalidSide,
}

impl PoolError {
    pub fn core_code(self) -> &'static str {
        match self {
            PoolError::InvalidAmount => "INVALID_AMOUNT",
            PoolError::InvalidSide => "INVALID_SIDE",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pool {
    pub yes: u64,
    pub no: u64,
}

impl Pool {
    pub fn total(&self) -> u128 {
        u128::from(self.yes) + u128::from(self.no)
    }

    fn side_total(&self, side: u8) -> u64 {
        if side == SIDE_YES { self.yes } else { self.no }
    }
}

pub fn check_side(side: u8) -> Result<(), PoolError> {
    if side == SIDE_YES || side == SIDE_NO {
        Ok(())
    } else {
        Err(PoolError::InvalidSide)
    }
}

/// core: addStake.
pub fn add_stake(pool: Pool, side: u8, amount: u64) -> Result<Pool, PoolError> {
    check_side(side)?;
    if amount == 0 {
        return Err(PoolError::InvalidAmount);
    }
    let next = if side == SIDE_YES {
        Pool {
            yes: pool
                .yes
                .checked_add(amount)
                .ok_or(PoolError::InvalidAmount)?,
            ..pool
        }
    } else {
        Pool {
            no: pool
                .no
                .checked_add(amount)
                .ok_or(PoolError::InvalidAmount)?,
            ..pool
        }
    };
    if next.total() > u128::from(u64::MAX) {
        return Err(PoolError::InvalidAmount);
    }
    Ok(next)
}

/// core: payout. Floor(amount * total / winningTotal) for a winner, 0 for a loser, the stake back
/// on VOID or when nobody is on the winning side.
pub fn payout(side: u8, amount: u64, pool: Pool, resolution: Resolution) -> u64 {
    if amount == 0 {
        return 0;
    }
    let winner = match resolution {
        Resolution::Void => return amount,
        Resolution::Yes => SIDE_YES,
        Resolution::No => SIDE_NO,
    };
    let winning_total = pool.side_total(winner);
    if winning_total == 0 {
        return amount;
    }
    if side != winner {
        return 0;
    }
    let p = u128::from(amount) * pool.total() / u128::from(winning_total);
    // amount <= winning_total, so p <= total <= u64::MAX.
    u64::try_from(p).unwrap_or(u64::MAX)
}

/// core: quote().projectedPayout: the payout if `side` wins and nobody trades after this stake.
pub fn projected_payout(pool: Pool, side: u8, amount: u64) -> Result<u64, PoolError> {
    let after = add_stake(pool, side, amount)?;
    let resolution = if side == SIDE_YES {
        Resolution::Yes
    } else {
        Resolution::No
    };
    Ok(payout(side, amount, after, resolution))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_cases_mirror_core() {
        let pool = Pool { yes: 100, no: 300 };
        assert_eq!(payout(SIDE_YES, 100, pool, Resolution::No), 0);
        assert_eq!(payout(SIDE_NO, 300, pool, Resolution::No), 400);
        assert_eq!(payout(SIDE_YES, 100, pool, Resolution::Void), 100);
        assert_eq!(payout(SIDE_NO, 0, pool, Resolution::No), 0);
        assert_eq!(
            payout(SIDE_NO, 7, Pool { yes: 0, no: 7 }, Resolution::Yes),
            7
        );
    }

    #[test]
    fn stake_and_quote_validation() {
        assert_eq!(
            add_stake(Pool::default(), 3, 1),
            Err(PoolError::InvalidSide)
        );
        assert_eq!(
            add_stake(Pool::default(), SIDE_YES, 0),
            Err(PoolError::InvalidAmount)
        );
        assert_eq!(
            add_stake(
                Pool {
                    yes: u64::MAX,
                    no: 0
                },
                SIDE_NO,
                1
            ),
            Err(PoolError::InvalidAmount)
        );
        assert_eq!(
            add_stake(
                Pool {
                    yes: u64::MAX,
                    no: 0
                },
                SIDE_YES,
                1
            ),
            Err(PoolError::InvalidAmount)
        );
        assert_eq!(
            projected_payout(Pool { yes: 100, no: 300 }, SIDE_YES, 100),
            Ok(250)
        );
        assert_eq!(projected_payout(Pool::default(), SIDE_NO, 10), Ok(10));
    }
}
