use anchor_lang::prelude::*;

#[event]
pub struct ConfigInitialized {
    pub authority: Pubkey,
    pub feed_count: u8,
}

#[event]
pub struct CallSealed {
    pub call: Pubkey,
    pub agent: Pubkey,
    pub commitment: [u8; 32],
    pub expiry_ts: i64,
    pub reveal_deadline_ts: i64,
}

#[event]
pub struct CallRevealed {
    pub call: Pubkey,
    pub agent: Pubkey,
}

#[event]
pub struct MarketOpened {
    pub call: Pubkey,
    pub opened_ts: i64,
}

#[event]
pub struct CallSettled {
    pub call: Pubkey,
    pub outcome: u8,
    pub settler: Pubkey,
}

#[event]
pub struct CallVoided {
    pub call: Pubkey,
}
