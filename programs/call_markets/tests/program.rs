//! Instruction-level tests in solana-program-test's in-process runtime (BanksClient).
//! Locally the program runs natively; with SBF_OUT_DIR set (CI), the same tests load the compiled
//! SBF binary. Every identity is a throwaway keypair created in memory for the test run; nothing
//! is written to disk and no network is used. Price accounts are synthetic fixtures (Q3: mocks
//! only); the collateral is a synthetic test-token mint created inside the test runtime.

use anchor_lang::prelude::{AccountInfo, Pubkey, UpgradeableLoaderState};
use anchor_lang::solana_program::bpf_loader_upgradeable::{self, get_program_data_address};
use anchor_lang::solana_program::entrypoint::ProgramResult;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token;
use call_markets::error::CallMarketsError;
use call_markets::instructions::{ConfigArgs, RevealArgs};
use call_markets::logic::parimutuel::{SIDE_NO, SIDE_YES};
use call_markets::logic::rule::{DEFAULT_PARAMS, Observation, Outcome, decide_outcome};
use call_markets::logic::seal::{CallFields, DIRECTION_ABOVE, commitment};
use call_markets::state::{
    CALL_SEED, CONFIG_SEED, Call, OUTCOME_HIT, OUTCOME_MISS, POSITION_SEED,
    PYTH_RECEIVER_PROGRAM_ID, Position, STATUS_REVEALED, STATUS_SEALED, STATUS_SETTLED,
    STATUS_VOID, VAULT_SEED,
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
const DECIMALS: u8 = 6;
const START_BALANCE: u64 = 1_000_000_000;
/// The Pyth Core Compatible receiver: a real Pyth program, but not the one we accept.
const PYTH_CORE_COMPATIBLE_RECEIVER: Pubkey =
    anchor_lang::pubkey!("rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp");

// Anchor framework error codes used below.
const ANCHOR_ACCOUNT_NOT_INITIALIZED: u32 = 3012;
const ANCHOR_ACCOUNT_OWNED_BY_WRONG_PROGRAM: u32 = 3007;

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
    third: Keypair,
    mint: Pubkey,
    other_mint: Pubkey,
    slot: u64,
}

fn funded() -> Account {
    Account::new(10 * SOL, 0, &anchor_lang::system_program::ID)
}

fn token_program_account(data: Vec<u8>) -> Account {
    Account {
        lamports: SOL,
        data,
        owner: spl_token::ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn mint_account() -> Account {
    let mut data = vec![0u8; spl_token::state::Mint::LEN];
    spl_token::state::Mint {
        mint_authority: COption::None,
        supply: 10 * START_BALANCE,
        decimals: DECIMALS,
        is_initialized: true,
        freeze_authority: COption::None,
    }
    .pack_into_slice(&mut data);
    token_program_account(data)
}

fn token_account(mint: Pubkey, owner: Pubkey, amount: u64) -> Account {
    let mut data = vec![0u8; spl_token::state::Account::LEN];
    spl_token::state::Account {
        mint,
        owner,
        amount,
        delegate: COption::None,
        state: spl_token::state::AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    }
    .pack_into_slice(&mut data);
    token_program_account(data)
}

/// The token account the test creates for `owner` (address derived from the owner, test only).
fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"test-token", owner.as_ref(), mint.as_ref()],
        &Pubkey::default(),
    )
    .0
}

async fn env() -> Env {
    let authority = Keypair::new();
    let agent = Keypair::new();
    let other = Keypair::new();
    let third = Keypair::new();
    let mint = Keypair::new().pubkey();
    let other_mint = Keypair::new().pubkey();
    let mut pt = ProgramTest::new("call_markets", call_markets::ID, processor!(entry));
    for k in [&authority, &agent, &other, &third] {
        pt.add_account(k.pubkey(), funded());
    }
    pt.add_account(mint, mint_account());
    pt.add_account(other_mint, mint_account());
    for k in [&agent, &other, &third] {
        pt.add_account(
            ata(&k.pubkey(), &mint),
            token_account(mint, k.pubkey(), START_BALANCE),
        );
        pt.add_account(
            ata(&k.pubkey(), &other_mint),
            token_account(other_mint, k.pubkey(), START_BALANCE),
        );
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
        third,
        mint,
        other_mint,
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

fn vault_pda(call: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[VAULT_SEED, call.as_ref()], &call_markets::ID).0
}

fn position_pda(call: &Pubkey, owner: &Pubkey, side: u8) -> Pubkey {
    Pubkey::find_program_address(
        &[POSITION_SEED, call.as_ref(), owner.as_ref(), &[side]],
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

impl Env {
    /// Moves to the next slot and sets the clock's unix timestamp.
    async fn set_time(&mut self, unix_timestamp: i64) {
        self.slot += 2;
        self.ctx.warp_to_slot(self.slot).expect("warp");
        self.set_time_same_slot(unix_timestamp).await;
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
        collateral_mint: Pubkey,
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
                collateral_mint,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: call_markets::instruction::InitializeConfig { args }.data(),
        };
        self.send(ix, &signer).await
    }

    async fn init_config(&mut self) {
        let mint = self.mint;
        self.init_config_with(true, default_config_args(), mint)
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

    async fn open_with_mint(
        &mut self,
        call: Pubkey,
        collateral_mint: Pubkey,
    ) -> Result<(), BanksClientError> {
        let other = self.other.insecure_clone();
        let ix = Instruction {
            program_id: call_markets::ID,
            accounts: call_markets::accounts::OpenMarket {
                opener: other.pubkey(),
                config: config_pda(),
                call,
                collateral_mint,
                vault: vault_pda(&call),
                token_program: spl_token::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: call_markets::instruction::OpenMarket {}.data(),
        };
        self.send(ix, &other).await
    }

    async fn open(&mut self, call: Pubkey) -> Result<(), BanksClientError> {
        let mint = self.mint;
        self.open_with_mint(call, mint).await
    }

    async fn open_position(
        &mut self,
        owner: &Keypair,
        call: Pubkey,
        side: u8,
    ) -> Result<(), BanksClientError> {
        let ix = Instruction {
            program_id: call_markets::ID,
            accounts: call_markets::accounts::OpenPosition {
                owner: owner.pubkey(),
                call,
                position: position_pda(&call, &owner.pubkey(), side),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: call_markets::instruction::OpenPosition { side }.data(),
        };
        self.send(ix, owner).await
    }

    async fn buy_from(
        &mut self,
        owner: &Keypair,
        call: Pubkey,
        side: u8,
        amount: u64,
        min_projected_payout: u64,
        from: Pubkey,
    ) -> Result<(), BanksClientError> {
        let ix = Instruction {
            program_id: call_markets::ID,
            accounts: call_markets::accounts::Buy {
                buyer: owner.pubkey(),
                config: config_pda(),
                call,
                collateral_mint: self.mint,
                vault: vault_pda(&call),
                buyer_token: from,
                position: position_pda(&call, &owner.pubkey(), side),
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
            data: call_markets::instruction::Buy {
                amount,
                min_projected_payout,
            }
            .data(),
        };
        self.send(ix, owner).await
    }

    async fn buy(
        &mut self,
        owner: &Keypair,
        call: Pubkey,
        side: u8,
        amount: u64,
        min: u64,
    ) -> Result<(), BanksClientError> {
        let from = ata(&owner.pubkey(), &self.mint);
        self.buy_from(owner, call, side, amount, min, from).await
    }

    /// Opens a position and buys into it.
    async fn stake(&mut self, owner: &Keypair, call: Pubkey, side: u8, amount: u64) {
        self.open_position(owner, call, side)
            .await
            .expect("open position");
        self.buy(owner, call, side, amount, 0).await.expect("buy");
    }

    async fn redeem_to(
        &mut self,
        owner: &Keypair,
        call: Pubkey,
        side: u8,
        to: Pubkey,
    ) -> Result<(), BanksClientError> {
        let ix = Instruction {
            program_id: call_markets::ID,
            accounts: call_markets::accounts::Redeem {
                owner: owner.pubkey(),
                config: config_pda(),
                call,
                collateral_mint: self.mint,
                vault: vault_pda(&call),
                owner_token: to,
                position: position_pda(&call, &owner.pubkey(), side),
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
            data: call_markets::instruction::Redeem {}.data(),
        };
        self.send(ix, owner).await
    }

    async fn redeem(
        &mut self,
        owner: &Keypair,
        call: Pubkey,
        side: u8,
    ) -> Result<(), BanksClientError> {
        let to = ata(&owner.pubkey(), &self.mint);
        self.redeem_to(owner, call, side, to).await
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

    async fn fetch_position(&mut self, pda: Pubkey) -> Position {
        let acc = self
            .ctx
            .banks_client
            .get_account(pda)
            .await
            .expect("rpc")
            .expect("position account");
        Position::try_deserialize(&mut acc.data.as_slice()).expect("deserialize position")
    }

    async fn token_state(&mut self, account: Pubkey) -> spl_token::state::Account {
        let acc = self
            .ctx
            .banks_client
            .get_account(account)
            .await
            .expect("rpc")
            .expect("token account");
        spl_token::state::Account::unpack(&acc.data).expect("unpack token account")
    }

    async fn balance_of(&mut self, owner: &Pubkey) -> u64 {
        let a = ata(owner, &self.mint);
        self.token_state(a).await.amount
    }

    /// Writes a synthetic PriceUpdateV2 account owned by `owner` (default: the pinned receiver).
    fn put_price_at(
        &mut self,
        key: Pubkey,
        o: &Observation,
        level: VerificationLevel,
        owner: Option<Pubkey>,
    ) -> Pubkey {
        let update = PriceUpdateV2 {
            write_authority: Pubkey::default(),
            verification_level: level,
            price_message: PriceFeedMessage {
                feed_id: o.feed_id,
                price: o.price,
                conf: o.conf,
                exponent: o.expo,
                publish_time: o.publish_time,
                prev_publish_time: o.prev_publish_time,
                ema_price: o.price,
                ema_conf: o.conf,
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
            owner: owner.unwrap_or(PYTH_RECEIVER_PROGRAM_ID),
            executable: false,
            rent_epoch: 0,
        };
        self.ctx
            .set_account(&key, &AccountSharedData::from(account));
        key
    }

    fn put_price(
        &mut self,
        o: &Observation,
        level: VerificationLevel,
        owner: Option<Pubkey>,
    ) -> Pubkey {
        self.put_price_at(Keypair::new().pubkey(), o, level, owner)
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

    /// A revealed call with an open market.
    async fn market(&mut self) -> (Pubkey, CallFields) {
        let (pda, f) = self.revealed().await;
        self.set_time(T0 + 2).await;
        self.open(pda).await.expect("open market");
        (pda, f)
    }
}

// ---------------------------------------------------------------------------------------------
// Config, seal, reveal
// ---------------------------------------------------------------------------------------------

#[test]
fn pinned_receiver_is_the_original_pyth_core_receiver() {
    assert_eq!(
        PYTH_RECEIVER_PROGRAM_ID.to_string(),
        "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"
    );
    // The SDK default (no `pro-compatible` feature) must stay the same program.
    assert_eq!(pyth_solana_receiver_sdk::ID, PYTH_RECEIVER_PROGRAM_ID);
    assert_ne!(PYTH_RECEIVER_PROGRAM_ID, PYTH_CORE_COMPATIBLE_RECEIVER);
}

#[tokio::test]
async fn config_init_is_restricted_and_validated() {
    let mut e = env().await;
    let mint = e.mint;
    assert_err(
        e.init_config_with(false, default_config_args(), mint).await,
        CallMarketsError::Unauthorized,
    );
    let mut bad = default_config_args();
    bad.max_conf_bps = 0;
    assert_err(
        e.init_config_with(true, bad, mint).await,
        CallMarketsError::InvalidParams,
    );
    let mut no_feeds = default_config_args();
    no_feeds.allowed_feed_ids.clear();
    assert_err(
        e.init_config_with(true, no_feeds, mint).await,
        CallMarketsError::InvalidFeedList,
    );
    let mut dup = default_config_args();
    dup.allowed_feed_ids = vec![FEED, FEED];
    assert_err(
        e.init_config_with(true, dup, mint).await,
        CallMarketsError::InvalidFeedList,
    );
    // The collateral must be an SPL Token mint.
    let not_a_mint = e.agent.pubkey();
    assert_custom(
        e.init_config_with(true, default_config_args(), not_a_mint)
            .await,
        ANCHOR_ACCOUNT_OWNED_BY_WRONG_PROGRAM,
    );
    e.init_config().await;
    // Immutable: there is no update instruction, and a second init cannot recreate the account.
    assert!(
        e.init_config_with(true, default_config_args(), mint)
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
    assert_err(
        e.reveal_as(&agent, pda, &f, SALT).await,
        CallMarketsError::RevealTooEarly,
    );
    e.set_time(T0).await; // later slot, same second
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

// ---------------------------------------------------------------------------------------------
// Market opening and the vault
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn open_market_creates_the_vault_and_respects_the_cutoff() {
    let mut e = env().await;
    let (pda, f) = e.sealed().await;
    assert_err(e.open(pda).await, CallMarketsError::WrongStatus);
    e.set_time(T0 + 900).await; // reveal exactly at the deadline
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

    let other_mint = e.other_mint;
    assert_err(
        e.open_with_mint(pda, other_mint).await,
        CallMarketsError::WrongMint,
    );
    e.open(pda).await.expect("open");
    let vault = e.token_state(vault_pda(&pda)).await;
    assert_eq!(vault.mint, e.mint);
    assert_eq!(vault.owner, pda, "the call PDA is the vault authority");
    assert_eq!(vault.amount, 0);
    assert!(e.fetch_call(pda).await.market_open);
    assert!(
        e.open(pda).await.is_err(),
        "a second open cannot recreate the vault"
    );

    let mut late = env().await;
    let (pda2, f2) = late.revealed().await;
    late.set_time(f2.expiry_ts - 600).await;
    assert_err(late.open(pda2).await, CallMarketsError::TradingClosed);
}

// ---------------------------------------------------------------------------------------------
// Settlement: pinned oracle owner, fail-closed checks, exactly one accepted update
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn settle_rejects_every_owner_but_the_pinned_pyth_receiver() {
    let mut e = env().await;
    let (pda, f) = e.revealed().await;
    e.set_time(f.expiry_ts + 1).await;
    let good = obs(&f, 101_000_000, 0);
    for owner in [
        PYTH_CORE_COMPATIBLE_RECEIVER,
        call_markets::ID,
        anchor_lang::system_program::ID,
        spl_token::ID,
        Pubkey::new_unique(),
    ] {
        let fake = e.put_price(&good, VerificationLevel::Full, Some(owner));
        assert_err(
            e.settle(pda, fake).await,
            CallMarketsError::OracleOwnerMismatch,
        );
    }
    assert_eq!(e.fetch_call(pda).await.status, STATUS_REVEALED);
    let real = e.put_price(&good, VerificationLevel::Full, None);
    e.settle(pda, real)
        .await
        .expect("the pinned receiver is accepted");
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
    // Owned by the receiver but not a PriceUpdateV2.
    let garbage_key = Pubkey::new_unique();
    e.ctx.set_account(
        &garbage_key,
        &AccountSharedData::from(Account {
            lamports: SOL,
            data: vec![7u8; 134],
            owner: PYTH_RECEIVER_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        }),
    );
    assert!(e.settle(pda, garbage_key).await.is_err());

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
async fn exactly_one_price_update_is_accepted_per_market() {
    let mut e = env().await;
    let (pda, f) = e.revealed().await;
    e.set_time(f.expiry_ts + 1).await;
    let accepted = obs(&f, 100_500_000, 100_000);
    let update = e.put_price(&accepted, VerificationLevel::Full, None);
    e.settle(pda, update).await.expect("settle");
    let call = e.fetch_call(pda).await;
    assert_eq!((call.status, call.outcome), (STATUS_SETTLED, OUTCOME_HIT));
    assert_eq!(call.accepted_update, update);
    assert_eq!(call.settler, e.other.pubkey());
    let stored = Observation {
        feed_id: call.feed_id,
        price: call.obs_price,
        conf: call.obs_conf,
        expo: call.obs_expo,
        publish_time: call.obs_publish_time,
        prev_publish_time: call.obs_prev_publish_time,
    };
    assert_eq!(stored, accepted);
    assert_eq!(
        decide_outcome(&call.fields(), &stored, &DEFAULT_PARAMS),
        Ok(Outcome::Hit)
    );

    // The same update again: same account, or the same message posted into another account.
    assert_err(
        e.settle(pda, update).await,
        CallMarketsError::DuplicatePriceUpdate,
    );
    let copy = e.put_price(&accepted, VerificationLevel::Full, None);
    assert_err(
        e.settle(pda, copy).await,
        CallMarketsError::DuplicatePriceUpdate,
    );
    // Any other update, later or not, is rejected.
    let later = e.put_price(
        &Observation {
            publish_time: f.expiry_ts + 3,
            prev_publish_time: f.expiry_ts + 2,
            ..obs(&f, 1_000_000, 0)
        },
        VerificationLevel::Full,
        None,
    );
    assert_err(e.settle(pda, later).await, CallMarketsError::AlreadySettled);
    let other_price = e.put_price(&obs(&f, 1_000_000, 0), VerificationLevel::Full, None);
    assert_err(
        e.settle(pda, other_price).await,
        CallMarketsError::AlreadySettled,
    );
    let after = e.fetch_call(pda).await;
    assert_eq!(
        (after.outcome, after.accepted_update),
        (OUTCOME_HIT, update),
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

// ---------------------------------------------------------------------------------------------
// Parimutuel pool: positions, buy, redeem
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn positions_and_buys_follow_the_market_rules() {
    let mut e = env().await;
    let (pda, f) = e.revealed().await;
    let other = e.other.insecure_clone();
    let agent = e.agent.insecure_clone();
    assert_err(
        e.open_position(&other, pda, SIDE_YES).await,
        CallMarketsError::MarketNotOpen,
    );
    e.set_time(T0 + 2).await;
    e.open(pda).await.expect("open");
    assert_err(
        e.open_position(&other, pda, 3).await,
        CallMarketsError::InvalidSide,
    );
    // Buying needs an existing position (explicit init, no init-if-needed).
    assert_custom(
        e.buy(&other, pda, SIDE_NO, 10, 0).await,
        ANCHOR_ACCOUNT_NOT_INITIALIZED,
    );
    e.open_position(&other, pda, SIDE_NO)
        .await
        .expect("position");
    assert_err(
        e.buy(&other, pda, SIDE_NO, 0, 0).await,
        CallMarketsError::InvalidAmount,
    );
    // Wrong collateral token account.
    let wrong = ata(&other.pubkey(), &e.other_mint);
    assert_err(
        e.buy_from(&other, pda, SIDE_NO, 10, 0, wrong).await,
        CallMarketsError::WrongMint,
    );
    // Empty pool: projected payout equals the stake; a higher limit fails.
    assert_err(
        e.buy(&other, pda, SIDE_NO, 300, 301).await,
        CallMarketsError::LimitNotMet,
    );
    e.buy(&other, pda, SIDE_NO, 300, 300).await.expect("buy NO");
    e.stake(&agent, pda, SIDE_YES, 100).await; // the agent's own key: a public self-trade
    let call = e.fetch_call(pda).await;
    assert_eq!((call.pool_yes, call.pool_no), (100, 300));
    assert_eq!(e.token_state(vault_pda(&pda)).await.amount, 400);
    assert_eq!(e.balance_of(&other.pubkey()).await, START_BALANCE - 300);
    let pos = e
        .fetch_position(position_pda(&pda, &agent.pubkey(), SIDE_YES))
        .await;
    assert_eq!(
        (pos.owner, pos.side, pos.amount, pos.redeemed),
        (agent.pubkey(), SIDE_YES, 100, false)
    );
    // Redeem before the market is decided.
    assert_err(
        e.redeem(&other, pda, SIDE_NO).await,
        CallMarketsError::NotRedeemable,
    );
    // No trading in the last tradeCutoffSecs.
    e.set_time(f.expiry_ts - 600).await;
    assert_err(
        e.buy(&other, pda, SIDE_NO, 10, 0).await,
        CallMarketsError::TradingClosed,
    );
}

#[tokio::test]
async fn a_hit_pays_yes_holders_and_the_vault_empties() {
    let mut e = env().await;
    let (pda, f) = e.market().await;
    let (agent, other, third) = (
        e.agent.insecure_clone(),
        e.other.insecure_clone(),
        e.third.insecure_clone(),
    );
    e.stake(&agent, pda, SIDE_YES, 100).await;
    e.stake(&other, pda, SIDE_NO, 300).await;
    e.stake(&third, pda, SIDE_YES, 50).await;
    e.set_time(f.expiry_ts).await;
    let update = e.put_price(&obs(&f, 101_000_000, 0), VerificationLevel::Full, None);
    e.settle(pda, update).await.expect("settle HIT");

    e.redeem(&agent, pda, SIDE_YES)
        .await
        .expect("agent redeems");
    e.redeem(&third, pda, SIDE_YES)
        .await
        .expect("third redeems");
    e.redeem(&other, pda, SIDE_NO)
        .await
        .expect("loser redeems zero");
    // 450 in the pool; YES total 150: 100 -> 300, 50 -> 150; NO gets nothing.
    assert_eq!(
        e.balance_of(&agent.pubkey()).await,
        START_BALANCE - 100 + 300
    );
    assert_eq!(
        e.balance_of(&third.pubkey()).await,
        START_BALANCE - 50 + 150
    );
    assert_eq!(e.balance_of(&other.pubkey()).await, START_BALANCE - 300);
    assert_eq!(e.token_state(vault_pda(&pda)).await.amount, 0);
    assert!(
        e.fetch_position(position_pda(&pda, &other.pubkey(), SIDE_NO))
            .await
            .redeemed
    );
    assert_err(
        e.redeem(&agent, pda, SIDE_YES).await,
        CallMarketsError::NothingToRedeem,
    );
    assert_err(
        e.redeem(&other, pda, SIDE_NO).await,
        CallMarketsError::NothingToRedeem,
    );
}

#[tokio::test]
async fn floor_rounding_dust_stays_in_the_vault() {
    let mut e = env().await;
    let (pda, f) = e.market().await;
    let (agent, other, third) = (
        e.agent.insecure_clone(),
        e.other.insecure_clone(),
        e.third.insecure_clone(),
    );
    e.stake(&agent, pda, SIDE_YES, 1).await;
    e.stake(&third, pda, SIDE_YES, 2).await;
    e.stake(&other, pda, SIDE_NO, 1).await;
    e.set_time(f.expiry_ts).await;
    let update = e.put_price(&obs(&f, 101_000_000, 0), VerificationLevel::Full, None);
    e.settle(pda, update).await.expect("settle HIT");
    e.redeem(&agent, pda, SIDE_YES).await.expect("redeem");
    e.redeem(&third, pda, SIDE_YES).await.expect("redeem");
    assert_eq!(e.balance_of(&agent.pubkey()).await, START_BALANCE); // 1 * 4 / 3 = 1
    assert_eq!(e.balance_of(&third.pubkey()).await, START_BALANCE); // 2 * 4 / 3 = 2
    assert_eq!(
        e.token_state(vault_pda(&pda)).await.amount,
        1,
        "dust stays in the vault"
    );
}

#[tokio::test]
async fn nobody_on_the_winning_side_means_refunds() {
    let mut e = env().await;
    let (pda, f) = e.market().await;
    let (other, third) = (e.other.insecure_clone(), e.third.insecure_clone());
    e.stake(&other, pda, SIDE_NO, 70).await;
    e.stake(&third, pda, SIDE_NO, 30).await;
    e.set_time(f.expiry_ts).await;
    let update = e.put_price(&obs(&f, 101_000_000, 0), VerificationLevel::Full, None);
    e.settle(pda, update)
        .await
        .expect("settle HIT with no YES stakes");
    e.redeem(&other, pda, SIDE_NO).await.expect("refund");
    e.redeem(&third, pda, SIDE_NO).await.expect("refund");
    assert_eq!(e.balance_of(&other.pubkey()).await, START_BALANCE);
    assert_eq!(e.balance_of(&third.pubkey()).await, START_BALANCE);
    assert_eq!(e.token_state(vault_pda(&pda)).await.amount, 0);
}

#[tokio::test]
async fn a_void_market_refunds_every_stake() {
    let mut e = env().await;
    let (pda, f) = e.market().await;
    let (agent, other) = (e.agent.insecure_clone(), e.other.insecure_clone());
    e.stake(&agent, pda, SIDE_YES, 40).await;
    e.stake(&other, pda, SIDE_NO, 60).await;
    e.set_time(f.expiry_ts + DEFAULT_PARAMS.void_after_secs)
        .await;
    e.void(pda).await.expect("void");
    e.redeem(&agent, pda, SIDE_YES).await.expect("refund");
    e.redeem(&other, pda, SIDE_NO).await.expect("refund");
    assert_eq!(e.balance_of(&agent.pubkey()).await, START_BALANCE);
    assert_eq!(e.balance_of(&other.pubkey()).await, START_BALANCE);
    assert_eq!(e.token_state(vault_pda(&pda)).await.amount, 0);
}

#[tokio::test]
async fn payouts_only_go_to_the_owners_own_token_account() {
    let mut e = env().await;
    let (pda, f) = e.market().await;
    let (agent, other) = (e.agent.insecure_clone(), e.other.insecure_clone());
    e.stake(&agent, pda, SIDE_YES, 10).await;
    e.set_time(f.expiry_ts).await;
    let update = e.put_price(&obs(&f, 101_000_000, 0), VerificationLevel::Full, None);
    e.settle(pda, update).await.expect("settle");
    let someone_else = ata(&other.pubkey(), &e.mint);
    assert_err(
        e.redeem_to(&agent, pda, SIDE_YES, someone_else).await,
        CallMarketsError::WrongSigner,
    );
    // Another signer cannot redeem the agent's position (seeds bind the position to its owner).
    assert!(e.redeem(&other, pda, SIDE_YES).await.is_err());
    e.redeem(&agent, pda, SIDE_YES).await.expect("redeem");
    assert_eq!(e.balance_of(&agent.pubkey()).await, START_BALANCE);
}
