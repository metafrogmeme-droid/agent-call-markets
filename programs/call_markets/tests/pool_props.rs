//! Property tests for the on-chain pool maths (threat-model item 6: rounding and pool drain).

use call_markets::logic::parimutuel::{
    Pool, Resolution, SIDE_NO, SIDE_YES, add_stake, payout, projected_payout,
};
use proptest::prelude::*;

fn stakes() -> impl Strategy<Value = Vec<(u8, u64)>> {
    prop::collection::vec(
        (
            prop_oneof![Just(SIDE_YES), Just(SIDE_NO)],
            1u64..=1_000_000_000_000,
        ),
        1..40,
    )
}

fn pool_of(stakes: &[(u8, u64)]) -> Pool {
    stakes
        .iter()
        .try_fold(Pool::default(), |p, &(side, amount)| {
            add_stake(p, side, amount)
        })
        .expect("stakes fit")
}

proptest! {
    #[test]
    fn payouts_never_exceed_the_pool_and_dust_is_bounded(s in stakes(), yes_wins in any::<bool>()) {
        let pool = pool_of(&s);
        let resolution = if yes_wins { Resolution::Yes } else { Resolution::No };
        let paid: u128 = s.iter().map(|&(side, a)| u128::from(payout(side, a, pool, resolution))).sum();
        prop_assert!(paid <= pool.total());
        let winner = if yes_wins { SIDE_YES } else { SIDE_NO };
        let winners = s.iter().filter(|&&(side, _)| side == winner).count() as u128;
        if winners == 0 {
            prop_assert_eq!(paid, pool.total(), "nobody won: full refund");
        } else {
            prop_assert!(pool.total() - paid < winners, "dust < number of winning positions");
        }
    }

    #[test]
    fn losers_get_nothing_and_winners_at_least_their_stake(s in stakes()) {
        let pool = pool_of(&s);
        prop_assume!(pool.yes > 0);
        for &(side, a) in &s {
            let p = payout(side, a, pool, Resolution::Yes);
            if side == SIDE_NO { prop_assert_eq!(p, 0); } else { prop_assert!(p >= a); }
        }
    }

    #[test]
    fn void_refunds_every_stake_exactly(s in stakes()) {
        let pool = pool_of(&s);
        let paid: u128 = s.iter().map(|&(side, a)| u128::from(payout(side, a, pool, Resolution::Void))).sum();
        prop_assert_eq!(paid, pool.total());
    }

    #[test]
    fn near_u64_max_pools_never_overflow(yes in 1u64..=u64::MAX / 2, no in 1u64..=u64::MAX / 2, a in 1u64..=1_000) {
        let pool = Pool { yes, no };
        let p = payout(SIDE_YES, yes.min(a), pool, Resolution::Yes);
        prop_assert!(u128::from(p) <= pool.total());
        let _ = projected_payout(pool, SIDE_NO, a);
    }
}
