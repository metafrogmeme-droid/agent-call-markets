//! Instruction-level tests in solana-program-test's in-process runtime (BanksClient).
//! Locally the program runs natively; with SBF_OUT_DIR set (CI), the same tests load the compiled
//! SBF binary. Every identity is a throwaway keypair created in memory for the test run; nothing
//! is written to disk and no network is used. Price accounts are synthetic fixtures owned by the
//! Pyth receiver program id (Q3: mocks only).

use anchor_lang::prelude::{AccountInfo, Pubkey, UpgradeableLoaderState};
use anchor_lang::solana_program::bpf_loader_upgradeable::{self, get_program_data_address};
use anchor_lang::solana_program::entrypoint::ProgramResult;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use call_markets::error::CallMarketsError;
use call_markets::instructions::{ConfigArgs, RevealArgs};
use call_markets::logic::rule::{DEFAULT_PARAMS, Observation, Outcome, decide_outcome};
use call_markets::logic::seal::{CallFields, DIRECTION_ABOVE, commitment};
use call_markets::state::{
    CALL_SEED, CONFIG_SEED, Call, OUTCOME_HIT, OUTCOME_MISS, STATUS_REVEALED, STATUS_SEALED,
    STATUS_SETTLED, STATUS_VOID,
};
use pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, PriceUpdateV2, VerificationLevel};
use solana_account::{Account, AccountSharedData};
use solana_clock::Clock;
use solana_instruction::{Instruction, error::InstructionError};
use solana_keypair::Keypair;
use solana_program_test::{BanksClientError, ProgramTest, ProgramTestContext, processor};
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

const FEED: [u8; 32] = [0xf1; 32];
const OTHER_FEED: [u8; 32] = [0xf2; 32];
const SALT: [u8; 32] = [0x5a; 32];
const T0: i64 = 1_800_000_000;
const LEVEL: i64 = 100_000_000; // 100.000000 at expo -6
const SOL: u64 = 1_000_000_000;

fn entry(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // Anchor's entry wants one lifetime for all three arguments; leaking test-only copies of the
    // id, the account slice and the data gives them that lifetime.
    let program_id: &'static Pubkey = Box::leak(Box::new(*program_id));
    let accounts = Box::leak(Box::new(accounts.to_vec()));
    let data: &'static [u8] = Box::leak(data.to_vec().into_boxed_slice());
    call_markets::entry(program_id, accounts, data)
}

struct Env {
    ctx: ProgramTestContext,
    authority: Keypair,
    agent: Keypair,
    other: Keypair,
    slot: u64,
}

fn funded() -> Account {
    Account::new(10 * SOL, 0, &anchor_lang::system_program::ID)
}

async fn env() -> Env {
    let authority = Keypair::new();
    let agent = Keypair::new();
    let other = Keypair::new();
    let mut pt = ProgramTest::new("call_markets", call_markets::ID, processor!(entry));
    for k in [&authority, &agent, &other] {
        pt.add_account(k.pubkey(), funded());
    }
    // The program's ProgramData account, as the upgradeable loader would hold it, naming
    // `authority` as upgrade authority.
    let program_data = bincode::serialize(&UpgradeableLoaderState::ProgramData {
        slot: 0,
        upgrade_authority_address: Some(authority.pubkey()),
    })
    .expect("serialize program data");
    pt.add_account(
        get_program_data_address(&call_markets::ID),
        Account {
            lamports: SOL,
            data: program_data,
            owner: bpf_loader_upgradeable::ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    let ctx = pt.start_with_context().await;
    let mut e = Env {
        ctx,
        authority,
        agent,
        other,
        slot: 10,
    };
    e.set_time(T0).await;
    e
}

fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &call_markets::ID).0
}

fn call_pda(agent: &Pubkey, commitment: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(
        &[CALL_SEED, agent.as_ref(), commitment.as_ref()],
        &call_markets::ID,
    )
    .0
}

fn default_config_args() -> ConfigArgs {
    let p = DEFAULT_PARAMS;
    ConfigArgs {
        reveal_window_secs: p.reveal_window_secs,
        min_lead_secs: p.min_lead_secs,
        max_horizon_secs: p.max_horizon_secs,
        trade_cutoff_secs: p.trade_cutoff_secs,
        settle_window_secs: p.settle_window_secs,
        max_conf_bps: p.max_conf_bps,
        void_after_secs: p.void_after_secs,
        min_level_expo: p.min_level_expo,
        max_level_expo: p.max_level_expo,
        allowed_feed_ids: vec![FEED],
    }
}

fn custom(e: CallMarketsError) -> u32 {
    e.into()
}

fn assert_custom(r: Result<(), BanksClientError>, expected: u32) {
    match r {
        Err(BanksClientError::TransactionError(TransactionError::InstructionError(
            _,
            InstructionError::Custom(code),
        ))) => assert_eq!(code, expected, "custom error code"),
        other => panic!("expected custom error {expected}, got {other:?}"),
    }
}

fn assert_err(r: Result<(), BanksClientError>, expected: CallMarketsError) {
    assert_custom(r, custom(expected));
}

impl Env {
    /// Moves to the next slot and sets the clock's unix timestamp.
    async fn set_time(&mut self, unix_timestamp: i64) {
        self.slot += 2;
        self.ctx.warp_to_slot(self.slot).expect("warp");
        let mut clock: Clock = self.ctx.banks_client.get_sysvar().await.expect("clock");
        clock.unix_timestamp = unix_timestamp;
        self.ctx.set_sysvar(&clock);
    }

    /// Sets the timestamp without moving to a new slot.
    async fn set_time_same_slot(&mut self, unix_timestamp: i64) {
        let mut clock: Clock = self.ctx.banks_client.get_sysvar().await.expect("clock");
        clock.unix_timestamp = unix_timestamp;
        self.ctx.set_sysvar(&clock);
    }

    async fn send(&mut self, ix: Instruction, signer: &Keypair) -> Result<(), BanksClientError> {
        let blockhash = self
            .ctx
            .get_new_latest_blockhash()
            .await
            .expect("blockhash");
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&self.ctx.payer.pubkey()),
            &[&self.ctx.payer, signer],
            blockhash,
        );
        self.ctx.banks_client.process_transaction(tx).await
    }

    async fn init_config_with(
        &mut self,
        signer_is_authority: bool,
        args: ConfigArgs,
    ) -> Result<(), BanksClientError> {
        let signer = if signer_is_authority {
            self.authority.insecure_clone()
        } else {
            self.other.insecure_clone()
        };
        let ix = Instruction {
            program_id: call_markets::ID,
            accounts: call_markets::accounts::InitializeConfig {
                authority: signer.pubkey(),
                config: config_pda(),
                program_data: get_program_data_address(&call_markets::ID),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: call_markets::instruction::InitializeConfig { args }.data(),
        };
        self.send(ix, &signer).await
    }

    async fn init_config(&mut self) {
        self.init_config_with(true, default_config_args())
            .await
            .expect("init config");
    }

    async fn seal_as(
        &mut self,
        signer: &Keypair,
        commitment: [u8; 32],
        expiry_ts: i64,
    ) -> Result<Pubkey, BanksClientError> {
        let pda = call_pda(&signer.pubkey(), &commitment);
        let ix = Instruction {
            program_id: call_markets::ID,
            accounts: call_markets::accounts::SealCall {
                agent: signer.pubkey(),
                config: config_pda(),
                call: pda,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: call_markets::instruction::SealCall {
                commitment,
                expiry_ts,
            }
            .data(),
        };
        self.send(ix, signer).await.map(|()| pda)
    }

    async fn reveal_as(
        &mut self,
        signer: &Keypair,
        call: Pubkey,
        f: &CallFields,
        salt: [u8; 32],
    ) -> Result<(), BanksClientError> {
        let ix = Instruction {
            program_id: call_markets::ID,
            accounts: call_markets::accounts::RevealCall {
                agent: signer.pubkey(),
                config: config_pda(),
                call,
            }
            .to_account_metas(None),
            data: call_markets::instruction::RevealCall {
                args: RevealArgs {
                    feed_id: f.feed_id,
                    direction: f.direction,
                    level_mantissa: f.level_mantissa,
                    level_expo: f.level_expo,
                    salt,
                },
            }
            .data(),
        };
        self.send(ix, signer).await
    }

    async fn open(&mut self, call: Pubkey) -> Result<(), BanksClientError> {
        let other = self.other.insecure_clone();
        let ix = Instruction {
            program_id: call_markets::ID,
            accounts: call_markets::accounts::OpenMarket {
                opener: other.pubkey(),
                config: config_pda(),
                call,
            }
            .to_account_metas(None),
            data: call_markets::instruction::OpenMarket {}.data(),
        };
        self.send(ix, &other).await
    }

    async fn settle(&mut self, call: Pubkey, price_update: Pubkey) -> Result<(), BanksClientError> {
        let other = self.other.insecure_clone();
        let ix = Instruction {
            program_id: call_markets::ID,
            accounts: call_markets::accounts::Settle {
                settler: other.pubkey(),
                config: config_pda(),
                call,
                price_update,
            }
            .to_account_metas(None),
            data: call_markets::instruction::Settle {}.data(),
        };
        self.send(ix, &other).await
    }

    async fn void(&mut self, call: Pubkey) -> Result<(), BanksClientError> {
        let other = self.other.insecure_clone();
        let ix = Instruction {
            program_id: call_markets::ID,
            accounts: call_markets::accounts::VoidUnsettled {
                caller: other.pubkey(),
                config: config_pda(),
                call,
            }
            .to_account_metas(None),
            data: call_markets::instruction::VoidUnsettled {}.data(),
        };
        self.send(ix, &other).await
    }

    async fn fetch_call(&mut self, pda: Pubkey) -> Call {
        let acc = self
            .ctx
            .banks_client
            .get_account(pda)
            .await
            .expect("rpc")
            .expect("call account");
        Call::try_deserialize(&mut acc.data.as_slice()).expect("deserialize call")
    }

    /// Writes a synthetic PriceUpdateV2 account (owned by the Pyth receiver id unless `owner`).
    fn put_price(
        &mut self,
        obs: &Observation,
        level: VerificationLevel,
        owner: Option<Pubkey>,
    ) -> Pubkey {
        let key = Keypair::new().pubkey();
        let update = PriceUpdateV2 {
            write_authority: Pubkey::default(),
            verification_level: level,
            price_message: PriceFeedMessage {
                feed_id: obs.feed_id,
                price: obs.price,
                conf: obs.conf,
                exponent: obs.expo,
                publish_time: obs.publish_time,
                prev_publish_time: obs.prev_publish_time,
                ema_price: obs.price,
                ema_conf: obs.conf,
            },
            posted_slot: 0,
        };
        let mut data = Vec::new();
        update
            .try_serialize(&mut data)
            .expect("serialize price update");
        let account = Account {
            lamports: SOL,
            data,
            owner: owner.unwrap_or(pyth_solana_receiver_sdk::ID),
            executable: false,
            rent_epoch: 0,
        };
        self.ctx
            .set_account(&key, &AccountSharedData::from(account));
        key
    }

    fn fields(&self, direction: u8, feed: [u8; 32]) -> CallFields {
        CallFields {
            agent: self.agent.pubkey().to_bytes(),
            feed_id: feed,
            direction,
            level_mantissa: LEVEL,
            level_expo: -6,
            expiry_ts: T0 + DEFAULT_PARAMS.min_lead_secs,
        }
    }

    /// Config + a sealed call by `agent` (at T0) on FEED.
    async fn sealed(&mut self) -> (Pubkey, CallFields) {
        self.init_config().await;
        let f = self.fields(DIRECTION_ABOVE, FEED);
        let agent = self.agent.insecure_clone();
        let pda = self
            .seal_as(&agent, commitment(&f, &SALT), f.expiry_ts)
            .await
            .expect("seal");
        (pda, f)
    }

    /// Config + a sealed and revealed call (reveal one slot and one second after the seal).
    async fn revealed(&mut self) -> (Pubkey, CallFields) {
        let (pda, f) = self.sealed().await;
        self.set_time(T0 + 1).await;
        let agent = self.agent.insecure_clone();
        self.reveal_as(&agent, pda, &f, SALT).await.expect("reveal");
        (pda, f)
    }
}

fn obs(f: &CallFields, price: i64, conf: u64) -> Observation {
    Observation {
        feed_id: f.feed_id,
        price,
        conf,
        expo: -6,
        publish_time: f.expiry_ts,
        prev_publish_time: f.expiry_ts - 1,
    }
}

#[tokio::test]
async fn config_init_is_restricted_and_validated() {
    let mut e = env().await;
    assert_err(
        e.init_config_with(false, default_config_args()).await,
        CallMarketsError::Unauthorized,
    );
    let mut bad = default_config_args();
    bad.max_conf_bps = 0;
    assert_err(
        e.init_config_with(true, bad).await,
        CallMarketsError::InvalidParams,
    );
    let mut no_feeds = default_config_args();
    no_feeds.allowed_feed_ids.clear();
    assert_err(
        e.init_config_with(true, no_feeds).await,
        CallMarketsError::InvalidFeedList,
    );
    let mut dup = default_config_args();
    dup.allowed_feed_ids = vec![FEED, FEED];
    assert_err(
        e.init_config_with(true, dup).await,
        CallMarketsError::InvalidFeedList,
    );
    e.init_config().await;
    // Immutable: there is no update instruction, and a second init cannot recreate the account.
    assert!(
        e.init_config_with(true, default_config_args())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn seal_checks_expiry_and_records_the_commitment() {
    let mut e = env().await;
    e.init_config().await;
    let agent = e.agent.insecure_clone();
    let c = [0x77; 32];
    assert_err(
        e.seal_as(&agent, c, T0 + 3_599).await.map(|_| ()),
        CallMarketsError::ExpiryTooSoon,
    );
    assert_err(
        e.seal_as(&agent, c, T0 + 2_592_001).await.map(|_| ()),
        CallMarketsError::ExpiryTooFar,
    );
    assert_err(
        e.seal_as(&agent, [0; 32], T0 + 3_600).await.map(|_| ()),
        CallMarketsError::ZeroCommitment,
    );
    let pda = e.seal_as(&agent, c, T0 + 3_600).await.expect("seal");
    let call = e.fetch_call(pda).await;
    assert_eq!(call.status, STATUS_SEALED);
    assert_eq!(call.agent, agent.pubkey());
    assert_eq!(call.commitment, c);
    assert_eq!(call.seal_ts, T0);
    assert_eq!(call.expiry_ts, T0 + 3_600);
    assert_eq!(call.reveal_deadline_ts, T0 + 900);
    assert_eq!(call.feed_id, [0; 32], "content stays hidden until reveal");
    e.set_time(T0 + 1).await;
    assert!(
        e.seal_as(&agent, c, T0 + 3_600).await.is_err(),
        "same agent + commitment twice"
    );
}

#[tokio::test]
async fn reveal_enforces_order_signer_commitment_and_deadline() {
    let mut e = env().await;
    let (pda, f) = e.sealed().await;
    let agent = e.agent.insecure_clone();
    let other = e.other.insecure_clone();
    // Same slot and same second as the seal.
    assert_err(
        e.reveal_as(&agent, pda, &f, SALT).await,
        CallMarketsError::RevealTooEarly,
    );
    // Later slot but the same second.
    e.set_time(T0).await;
    assert_err(
        e.reveal_as(&agent, pda, &f, SALT).await,
        CallMarketsError::RevealTooEarly,
    );
    e.set_time(T0 + 1).await;
    assert_err(
        e.reveal_as(&agent, pda, &f, [0xa5; 32]).await,
        CallMarketsError::CommitmentMismatch,
    );
    assert_err(
        e.reveal_as(&other, pda, &f, SALT).await,
        CallMarketsError::WrongSigner,
    );
    e.set_time(T0 + 901).await;
    assert_err(
        e.reveal_as(&agent, pda, &f, SALT).await,
        CallMarketsError::RevealDeadlinePassed,
    );
    assert_eq!(
        e.fetch_call(pda).await.status,
        STATUS_SEALED,
        "unrevealed: counts as a miss"
    );
}

#[tokio::test]
async fn reveal_rejects_a_matching_commitment_to_a_disallowed_feed() {
    let mut e = env().await;
    e.init_config().await;
    let agent = e.agent.insecure_clone();
    let f = e.fields(DIRECTION_ABOVE, OTHER_FEED);
    let pda = e
        .seal_as(&agent, commitment(&f, &SALT), f.expiry_ts)
        .await
        .expect("seal");
    e.set_time(T0 + 1).await;
    assert_err(
        e.reveal_as(&agent, pda, &f, SALT).await,
        CallMarketsError::FeedNotAllowed,
    );
}

#[tokio::test]
async fn reveal_records_the_call_and_open_market_respects_the_cutoff() {
    let mut e = env().await;
    let (pda, f) = e.sealed().await;
    assert_err(e.open(pda).await, CallMarketsError::WrongStatus);
    e.set_time(T0 + 900).await; // exactly at the deadline
    let agent = e.agent.insecure_clone();
    e.reveal_as(&agent, pda, &f, SALT)
        .await
        .expect("reveal at deadline");
    let call = e.fetch_call(pda).await;
    assert_eq!(call.status, STATUS_REVEALED);
    assert_eq!(
        (
            call.feed_id,
            call.direction,
            call.level_mantissa,
            call.level_expo
        ),
        (FEED, DIRECTION_ABOVE, LEVEL, -6)
    );
    assert_eq!(call.salt, SALT, "salt is public after reveal");
    e.open(pda).await.expect("open");
    assert!(e.fetch_call(pda).await.market_open);
    assert_err(e.open(pda).await, CallMarketsError::MarketAlreadyOpen);

    let mut late = env().await;
    let (pda2, f2) = late.revealed().await;
    late.set_time(f2.expiry_ts - 600).await;
    assert_err(late.open(pda2).await, CallMarketsError::TradingClosed);
}

#[tokio::test]
async fn settle_fails_closed_on_bad_oracle_input() {
    let mut e = env().await;
    let (pda, f) = e.revealed().await;
    let good = e.put_price(&obs(&f, 101_000_000, 0), VerificationLevel::Full, None);
    assert_err(e.settle(pda, good).await, CallMarketsError::NotExpired);
    e.set_time(f.expiry_ts + 20).await;

    let partial = e.put_price(
        &obs(&f, 101_000_000, 0),
        VerificationLevel::Partial { num_signatures: 5 },
        None,
    );
    assert_err(
        e.settle(pda, partial).await,
        CallMarketsError::OracleNotFullyVerified,
    );
    let fake_owner = e.put_price(
        &obs(&f, 101_000_000, 0),
        VerificationLevel::Full,
        Some(Pubkey::new_unique()),
    );
    // Anchor's owner check on Account<PriceUpdateV2>: AccountOwnedByWrongProgram.
    assert_custom(e.settle(pda, fake_owner).await, 3007);
    let wrong_feed = e.put_price(
        &Observation {
            feed_id: OTHER_FEED,
            ..obs(&f, 101_000_000, 0)
        },
        VerificationLevel::Full,
        None,
    );
    assert_err(
        e.settle(pda, wrong_feed).await,
        CallMarketsError::FeedMismatch,
    );
    let late = e.put_price(
        &Observation {
            publish_time: f.expiry_ts + 11,
            ..obs(&f, 101_000_000, 0)
        },
        VerificationLevel::Full,
        None,
    );
    assert_err(
        e.settle(pda, late).await,
        CallMarketsError::ObservationOutsideWindow,
    );
    let not_unique = e.put_price(
        &Observation {
            publish_time: f.expiry_ts + 5,
            prev_publish_time: f.expiry_ts,
            ..obs(&f, 101_000_000, 0)
        },
        VerificationLevel::Full,
        None,
    );
    assert_err(
        e.settle(pda, not_unique).await,
        CallMarketsError::ObservationNotUnique,
    );
    let wide = e.put_price(
        &obs(&f, 100_000_000, 500_001),
        VerificationLevel::Full,
        None,
    );
    assert_err(
        e.settle(pda, wide).await,
        CallMarketsError::ConfidenceTooWide,
    );

    // A price published after "now" cannot be used.
    e.set_time_same_slot(f.expiry_ts + 2).await;
    let future = e.put_price(
        &Observation {
            publish_time: f.expiry_ts + 5,
            ..obs(&f, 101_000_000, 0)
        },
        VerificationLevel::Full,
        None,
    );
    assert_err(
        e.settle(pda, future).await,
        CallMarketsError::ObservationOutsideWindow,
    );
    assert_eq!(e.fetch_call(pda).await.status, STATUS_REVEALED);
}

#[tokio::test]
async fn settle_decides_once_and_stores_the_observation() {
    let mut e = env().await;
    let (pda, f) = e.revealed().await;
    e.set_time(f.expiry_ts + 1).await;
    let o = obs(&f, 100_500_000, 100_000);
    let update = e.put_price(&o, VerificationLevel::Full, None);
    e.settle(pda, update).await.expect("settle");
    let call = e.fetch_call(pda).await;
    assert_eq!(call.status, STATUS_SETTLED);
    assert_eq!(call.outcome, OUTCOME_HIT);
    assert_eq!(call.settler, e.other.pubkey());
    // Anyone can recompute the outcome from the stored call and observation.
    let stored = Observation {
        feed_id: call.feed_id,
        price: call.obs_price,
        conf: call.obs_conf,
        expo: call.obs_expo,
        publish_time: call.obs_publish_time,
        prev_publish_time: call.obs_prev_publish_time,
    };
    assert_eq!(stored, o);
    assert_eq!(
        decide_outcome(&call.fields(), &stored, &DEFAULT_PARAMS),
        Ok(Outcome::Hit)
    );

    let miss = e.put_price(&obs(&f, 1_000_000, 0), VerificationLevel::Full, None);
    assert_err(e.settle(pda, miss).await, CallMarketsError::AlreadySettled);
    assert_eq!(
        e.fetch_call(pda).await.outcome,
        OUTCOME_HIT,
        "outcome cannot change"
    );
    assert_err(e.void(pda).await, CallMarketsError::AlreadySettled);
}

#[tokio::test]
async fn confidence_touching_the_level_is_a_miss() {
    let mut e = env().await;
    let (pda, f) = e.revealed().await;
    e.set_time(f.expiry_ts).await;
    let update = e.put_price(
        &obs(&f, 100_100_000, 100_000),
        VerificationLevel::Full,
        None,
    );
    e.settle(pda, update).await.expect("settle");
    assert_eq!(e.fetch_call(pda).await.outcome, OUTCOME_MISS);
}

#[tokio::test]
async fn void_only_after_the_settlement_window() {
    let mut e = env().await;
    let (sealed_only, _) = e.sealed().await;
    assert_err(e.void(sealed_only).await, CallMarketsError::WrongStatus);

    let mut e = env().await;
    let (pda, f) = e.revealed().await;
    let void_at = f.expiry_ts + DEFAULT_PARAMS.void_after_secs;
    e.set_time(void_at - 1).await;
    assert_err(e.void(pda).await, CallMarketsError::VoidTooEarly);
    e.set_time(void_at).await;
    let update = e.put_price(&obs(&f, 101_000_000, 0), VerificationLevel::Full, None);
    assert_err(
        e.settle(pda, update).await,
        CallMarketsError::SettlementWindowClosed,
    );
    e.void(pda).await.expect("void");
    assert_eq!(e.fetch_call(pda).await.status, STATUS_VOID);
    assert_err(e.void(pda).await, CallMarketsError::AlreadyVoid);
    assert_err(e.settle(pda, update).await, CallMarketsError::AlreadyVoid);
}
