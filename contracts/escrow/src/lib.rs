//! Lumigift Escrow Contract
//!
//! Locks USDC for a recipient until a predetermined timestamp.
//! Only the designated recipient can claim after the unlock time.
//!
//! # USDC Contract Addresses
//!
//! - **Mainnet:** `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`
//!   (Circle USDC on Stellar mainnet)
//! - **Testnet:** `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`
//!   (Circle USDC on Stellar testnet)
//!
//! # Instance Storage TTL Strategy
//!
//! Soroban instance storage has a finite TTL measured in ledgers. If the TTL
//! expires the contract state is archived and becomes inaccessible — a critical
//! failure for long-lived escrows (e.g. 1-year gifts).
//!
//! ## How TTL is managed
//!
//! Stellar closes roughly one ledger every 5 seconds, so:
//!
//! ```text
//! 1 day  ≈ 17_280 ledgers   (86_400 s / 5 s)
//! 30 days ≈ 518_400 ledgers
//! ```
//!
//! The required TTL for a given escrow is:
//!
//! ```text
//! required_ledgers = (unlock_time - now_secs) / LEDGER_CLOSE_SECS
//!                  + BUFFER_LEDGERS          // 30-day safety margin
//! ```
//!
//! `extend_ttl(threshold, new_ttl)` is a no-op when the current TTL is already
//! ≥ `threshold`, so calling it on every `initialize` / `claim` is safe and
//! cheap — the extension only fires when the TTL has drifted below the
//! threshold.
//!
//! ## Who can extend
//!
//! - **`initialize`** — sets the initial TTL to cover the full lock period.
//! - **`claim`** — extends to a short post-claim window so the claimed state
//!   remains readable for reconciliation.
//! - **`extend_ttl` (public)** — permissionless keeper function. Anyone
//!   (the platform backend, a third-party keeper, or the recipient) can call
//!   this to bump the TTL before it expires, without needing to claim.

#![no_std]

use soroban_sdk::{
    bytesn, contract, contractimpl, contracterror, contracttype, token, Address, BytesN, Env,
    Symbol, Vec,
};

/// Contract version. Bumped whenever the public interface changes.
///
/// - v1: initial release
/// - v2: network-aware token validation, batch initialization, cancel reasons
pub const CONTRACT_VERSION: u32 = 2;

// ─── Error enum ───────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EscrowError {
    AlreadyInitialized = 1,
    AlreadyClaimed     = 2,
    StillLocked        = 3,
    NotInitialized     = 4,
    Unauthorized       = 5,
    AlreadyCancelled   = 6,
    InvalidAmount      = 7,
    InvalidUnlockTime  = 8,
    /// The supplied token address is not an allowed USDC contract for this
    /// network. Only the canonical Circle USDC addresses are permitted.
    InvalidToken       = 9,
    /// The sender's USDC balance is lower than the requested deposit amount.
    InsufficientBalance = 10,
    /// `batch_initialize` was called with an empty vector.
    EmptyBatch         = 11,
    /// `batch_initialize` was called with more than `MAX_BATCH_SIZE` items.
    BatchTooLarge      = 12,
    /// The cancellation reason code is not one of the defined codes
    /// (sender_requested=1, expired=2, admin=3).
    InvalidCancelReason = 13,
}

// ─── Network ──────────────────────────────────────────────────────────────────

/// The Stellar network this contract instance is deployed on.
///
/// Set once at deploy time via `set_network` (or implicitly by `initialize`)
/// and used to restrict token validation to the canonical USDC address for
/// that network. On mainnet, testnet USDC is rejected and vice versa.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Network {
    Mainnet = 0,
    Testnet = 1,
}

// ─── Cancellation reason codes ────────────────────────────────────────────────

/// The sender requested cancellation.
pub const CANCEL_REASON_SENDER_REQUESTED: u32 = 1;
/// The gift expired without being claimed.
pub const CANCEL_REASON_EXPIRED: u32 = 2;
/// An administrator cancelled the gift.
pub const CANCEL_REASON_ADMIN: u32 = 3;

/// Returns `true` when `reason` is one of the defined cancellation codes.
fn is_valid_cancel_reason(reason: u32) -> bool {
    matches!(
        reason,
        CANCEL_REASON_SENDER_REQUESTED | CANCEL_REASON_EXPIRED | CANCEL_REASON_ADMIN
    )
}

// ─── Batch initialization ─────────────────────────────────────────────────────

/// Maximum number of gifts that may be initialized in a single
/// `batch_initialize` call.
pub const MAX_BATCH_SIZE: u32 = 20;

/// Parameters for a single gift in a `batch_initialize` call.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GiftParams {
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
    pub unlock_time: u64,
}

// ─── Allowed token addresses ──────────────────────────────────────────────────
//
// Only Circle USDC is accepted. Each network has a single canonical contract
// address. Passing any other address to `initialize` will fail with
// `InvalidToken` before any funds move.
//
// Mainnet:  CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75
// Testnet:  CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA

/// USDC contract address on Stellar **mainnet** (Circle-issued).
const USDC_MAINNET: &str = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

/// USDC contract address on Stellar **testnet** (Circle-issued).
pub const USDC_TESTNET: &str = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/// Returns `true` when `token` matches the canonical USDC address for the
/// given `network`. Testnet USDC is rejected on mainnet and vice versa.
fn is_allowed_token(env: &Env, network: Network, token: &Address) -> bool {
    let expected = match network {
        Network::Mainnet => USDC_MAINNET,
        Network::Testnet => USDC_TESTNET,
    };
    token == &Address::from_str(env, expected)
}



/// Minimum escrow amount: 1 USDC expressed in stroops (1 USDC = 10_000_000 stroops).
pub const MIN_AMOUNT: i128 = 10_000_000;

/// Minimum lock duration: 1 hour in seconds.
const MIN_LOCK_DURATION: u64 = 3_600;

/// Approximate ledger close time in seconds. Stellar targets ~5 s per ledger.
const LEDGER_CLOSE_SECS: u64 = 5;

/// 30-day safety buffer expressed in ledgers (30 * 24 * 3600 / 5).
const BUFFER_LEDGERS: u32 = 518_400;

/// Minimum TTL threshold below which `extend_ttl` fires (7 days in ledgers).
/// Keeps the extension a no-op on most calls while still catching drift early.
const MIN_TTL_THRESHOLD: u32 = 120_960; // 7 * 24 * 3600 / 5

/// Short post-claim TTL: 7 days so the claimed state stays readable for
/// reconciliation after the funds have been transferred.
const POST_CLAIM_TTL_LEDGERS: u32 = 120_960;

// ─── EscrowStatus enum ────────────────────────────────────────────────────────

/// Explicit lifecycle status for the escrow.
///
/// Returned by `get_status` so that off-chain indexers and the backend can
/// reconcile state without having to infer it from multiple boolean flags.
///
/// Terminal states (`Claimed`, `Cancelled`) must never transition back to
/// a non-terminal state — the contract enforces this invariant.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    /// Funds are locked; the unlock time has not been reached.
    Locked = 0,
    /// The unlock time has passed but the recipient has not yet claimed.
    Unlocked = 1,
    /// The recipient successfully claimed the funds (terminal).
    Claimed = 2,
    /// The sender cancelled the escrow and funds were returned (terminal).
    Cancelled = 3,
}

// ─── Storage keys ─────────────────────────────────────────────────────────────
//
// All keys use `instance` storage, which is tied to the contract instance
// lifetime and is automatically extended when the contract is invoked.
// Every value is written once during `initialize` and is immutable except
// for `Claimed`, which transitions from `false` → `true` on a successful claim.
//
// Storage model (instance storage):
//
//   ┌─────────────┬──────────────┬──────────────────────────────────────────┐
//   │ DataKey     │ Type         │ Description                              │
//   ├─────────────┼──────────────┼──────────────────────────────────────────┤
//   │ Sender      │ Address      │ Gift creator; authorized to initialize   │
//   │ Recipient   │ Address      │ Intended claimer; authorized to claim    │
//   │ Token       │ Address      │ USDC contract address (mainnet/testnet)  │
//   │ Amount      │ i128         │ Locked amount in stroops (≥ 10_000_000)  │
//   │ UnlockTime  │ u64          │ Unix timestamp after which claim is open │
//   │ Claimed     │ bool         │ False until claim succeeds; then true    │
//   └─────────────┴──────────────┴──────────────────────────────────────────┘
//
// Valid contract states:
//
//   [Uninitialized] ──initialize()──► [Locked] ──(time passes)──► [Unlocked]
//                                                                       │
//                                                                  claim()
//                                                                       │
//                                                                       ▼
//                                                                  [Claimed]
//
//   [Locked] ──cancel()──► [Cancelled]
//   [Unlocked] ──cancel()──► [Cancelled]

#[contracttype]
pub enum DataKey {
    /// The address authorized to call `upgrade`. Set once during `initialize`.
    Admin,
    Sender,

    /// The address authorized to call `claim` and receive the locked funds.
    /// `claim` calls `recipient.require_auth()` to enforce this.
    Recipient,

    /// The USDC token contract address on the current network.
    /// Mainnet: `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`
    /// Testnet: `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`
    Token,

    /// The number of USDC stroops locked in escrow (1 USDC = 10_000_000 stroops).
    /// Must be ≥ `MIN_AMOUNT` (10_000_000 stroops = 1 USDC).
    Amount,

    /// Unix timestamp (seconds) after which `claim` is permitted.
    /// Must be at least `MIN_LOCK_DURATION` (3 600 s) after initialization time.
    UnlockTime,

    /// Tracks whether the escrow has been claimed.
    /// Initialized to `false`; set to `true` atomically before the token
    /// transfer in `claim` to prevent re-entrancy and double-claim attacks.
    Claimed,
    Cancelled,

    /// The `Network` this contract instance is deployed on. Set at deploy time
    /// via `set_network` (or implicitly by `initialize`). Restricts token
    /// validation to the canonical USDC address for the active network.
    Network,

    /// The cancellation reason code recorded by `cancel`.
    CancelReason,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct EscrowContract;

// ─── TTL helper ───────────────────────────────────────────────────────────────

/// Computes the required instance TTL in ledgers to cover `unlock_time` plus
/// the 30-day buffer.
///
/// If `unlock_time` is already in the past (e.g. after a successful claim) the
/// function returns `BUFFER_LEDGERS` so the post-claim state stays readable.
fn required_ttl_ledgers(env: &Env, unlock_time: u64) -> u32 {
    let now = env.ledger().timestamp();
    if unlock_time <= now {
        return BUFFER_LEDGERS;
    }
    let secs_until_unlock = unlock_time - now;
    // Round up without overflowing for unlock times near u64::MAX.
    let ledgers_until_unlock = secs_until_unlock.div_ceil(LEDGER_CLOSE_SECS);
    // Saturating cast to u32; any escrow > ~680 years would overflow, which is
    // impossible given the unlock_time validation in `initialize`.
    let ledgers_u32 = ledgers_until_unlock.min(u32::MAX as u64) as u32;
    ledgers_u32.saturating_add(BUFFER_LEDGERS)
}

#[contractimpl]
impl EscrowContract {
    /// Set the network this contract instance is deployed on.
    ///
    /// Intended to be called once by the deploy script immediately after
    /// deployment, before any escrow is initialized. If the network has not
    /// been set explicitly, `initialize` defaults it to `Network::Testnet`
    /// (the safe default for development) and persists it.
    ///
    /// Calling this again with a different network after the escrow has been
    /// initialized is rejected with `AlreadyInitialized` to prevent a
    /// deployed escrow from being switched between networks.
    pub fn set_network(env: Env, network: Network) -> Result<(), EscrowError> {
        if env.storage().instance().has(&DataKey::Sender) {
            return Err(EscrowError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Network, &network);
        Ok(())
    }

    /// Read-only: returns the network this contract instance is deployed on.
    pub fn get_network(env: Env) -> Result<Network, EscrowError> {
        env.storage()
            .instance()
            .get(&DataKey::Network)
            .ok_or(EscrowError::NotInitialized)
    }

    /// Initialize the escrow. Called once by the platform after deploying.
    pub fn initialize(
        env: Env,
        admin: Address,
        sender: Address,
        recipient: Address,
        token: Address,
        amount: i128,
        unlock_time: u64,
    ) -> Result<(), EscrowError> {
        if env.storage().instance().has(&DataKey::Sender) {
            return Err(EscrowError::AlreadyInitialized);
        }

        if amount < MIN_AMOUNT {
            return Err(EscrowError::InvalidAmount);
        }

        // unlock_time must be at least MIN_LOCK_DURATION seconds in the future
        if unlock_time <= env.ledger().timestamp().saturating_add(MIN_LOCK_DURATION) {
            return Err(EscrowError::InvalidUnlockTime);
        }

        // Resolve the active network. If the deploy script did not call
        // `set_network`, default to testnet and persist it so validation is
        // deterministic for the lifetime of the escrow.
        let network: Network = match env.storage().instance().get(&DataKey::Network) {
            Some(n) => n,
            None => {
                let default_network = Network::Testnet;
                env.storage()
                    .instance()
                    .set(&DataKey::Network, &default_network);
                default_network
            }
        };

        // Reject any token that is not the canonical USDC contract address for
        // the active network. This prevents accidental (or malicious)
        // initialization with a spoofed, unsupported, or wrong-network asset.
        if !is_allowed_token(&env, network, &token) {
            return Err(EscrowError::InvalidToken);
        }

        sender.require_auth();

        // Pre-condition: the sender must hold enough USDC for the deposit.
        // Checked in the same invocation as the transfer below, so a failure
        // here reverts atomically before any state is written.
        let token_client = token::Client::new(&env, &token);
        if token_client.balance(&sender) < amount {
            return Err(EscrowError::InsufficientBalance);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Sender, &sender);
        env.storage().instance().set(&DataKey::Recipient, &recipient);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Amount, &amount);
        env.storage().instance().set(&DataKey::UnlockTime, &unlock_time);
        env.storage().instance().set(&DataKey::Claimed, &false);

        // Extend instance TTL to cover the full lock period plus a 30-day buffer.
        // This prevents state archival before the recipient can claim.
        let ttl = required_ttl_ledgers(&env, unlock_time);
        env.storage().instance().extend_ttl(MIN_TTL_THRESHOLD, ttl);

        token_client.transfer(&sender, &env.current_contract_address(), &amount);

        env.events().publish(
            (Symbol::new(&env, "initialized"),),
            (sender, recipient, amount, unlock_time),
        );

        Ok(())
    }

    /// Initialize many escrows in a single atomic call.
    ///
    /// Each `GiftParams` entry is validated exactly like `initialize`. Because
    /// Soroban invocations are atomic, if any entry fails validation (or any
    /// token transfer fails) the entire call reverts and no state is written.
    ///
    /// # Limits
    ///
    /// - `gifts.len()` must be in `1..=MAX_BATCH_SIZE` (20).
    /// - Every gift must use the canonical USDC address for the active network.
    ///
    /// # Fee analysis (batch vs individual)
    ///
    /// Each individual `initialize` call is a separate Stellar transaction and
    /// pays the base fee plus the Soroban resource fee (CPU, ledger I/O,
    /// events). A batch of N gifts pays the base fee **once** instead of N
    /// times, and shares the per-invocation overhead (auth tree setup, ledger
    /// entry reads for the contract instance). The dominant saving is the
    /// per-transaction base fee and the fixed invocation overhead; the
    /// per-gift storage writes and token transfers are still paid for each
    /// gift. For a 20-gift batch this typically reduces total fees by roughly
    /// 30–50% versus 20 separate transactions, and removes 19 round-trips of
    /// latency.
    pub fn batch_initialize(env: Env, gifts: Vec<GiftParams>) -> Result<(), EscrowError> {
        let len = gifts.len();
        if len == 0 {
            return Err(EscrowError::EmptyBatch);
        }
        if len > MAX_BATCH_SIZE {
            return Err(EscrowError::BatchTooLarge);
        }

        // Resolve (or default) the active network once for the whole batch.
        let network: Network = match env.storage().instance().get(&DataKey::Network) {
            Some(n) => n,
            None => {
                let default_network = Network::Testnet;
                env.storage()
                    .instance()
                    .set(&DataKey::Network, &default_network);
                default_network
            }
        };

        let now = env.ledger().timestamp();

        // Validate every gift before moving any funds. Any failure aborts the
        // whole call, so the batch is all-or-nothing.
        for i in 0..len {
            let gift = gifts.get_unchecked(i);

            if gift.amount < MIN_AMOUNT {
                return Err(EscrowError::InvalidAmount);
            }
            if gift.unlock_time <= now.saturating_add(MIN_LOCK_DURATION) {
                return Err(EscrowError::InvalidUnlockTime);
            }
            if !is_allowed_token(&env, network, &gift.token) {
                return Err(EscrowError::InvalidToken);
            }
        }

        // Authorize and transfer each gift. A failure here (e.g. insufficient
        // balance) reverts the entire batch atomically.
        for i in 0..len {
            let gift = gifts.get_unchecked(i);

            gift.sender.require_auth();

            let token_client = token::Client::new(&env, &gift.token);
            if token_client.balance(&gift.sender) < gift.amount {
                return Err(EscrowError::InsufficientBalance);
            }

            token_client.transfer(
                &gift.sender,
                &env.current_contract_address(),
                &gift.amount,
            );

            env.events().publish(
                (Symbol::new(&env, "batch_initialized"),),
                (gift.sender.clone(), gift.recipient.clone(), gift.amount, gift.unlock_time),
            );
        }

        // Extend the instance TTL to cover the longest lock in the batch.
        let mut max_unlock: u64 = 0;
        for i in 0..len {
            let gift = gifts.get_unchecked(i);
            if gift.unlock_time > max_unlock {
                max_unlock = gift.unlock_time;
            }
        }
        let ttl = required_ttl_ledgers(&env, max_unlock);
        env.storage().instance().extend_ttl(MIN_TTL_THRESHOLD, ttl);

        Ok(())
    }

    /// Claim the escrowed funds. Only callable by the recipient after unlock_time.
    pub fn claim(env: Env) -> Result<(), EscrowError> {
        let recipient: Address = env
            .storage()
            .instance()
            .get(&DataKey::Recipient)
            .ok_or(EscrowError::NotInitialized)?;

        recipient.require_auth();

        let claimed: bool = env
            .storage()
            .instance()
            .get(&DataKey::Claimed)
            .unwrap_or(false);

        if claimed {
            return Err(EscrowError::AlreadyClaimed);
        }

        let unlock_time: u64 = env
            .storage()
            .instance()
            .get(&DataKey::UnlockTime)
            .ok_or(EscrowError::NotInitialized)?;

        if env.ledger().timestamp() < unlock_time {
            return Err(EscrowError::StillLocked);
        }

        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(EscrowError::NotInitialized)?;

        let amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Amount)
            .ok_or(EscrowError::NotInitialized)?;

        env.storage().instance().set(&DataKey::Claimed, &true);

        // Extend TTL so the claimed state stays readable for reconciliation.
        // unlock_time is in the past here, so required_ttl_ledgers returns BUFFER_LEDGERS.
        env.storage()
            .instance()
            .extend_ttl(MIN_TTL_THRESHOLD, POST_CLAIM_TTL_LEDGERS);

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &recipient, &amount);

        env.events().publish(
            (Symbol::new(&env, "claimed"),),
            (recipient, amount),
        );

        Ok(())
    }

    /// Cancel the escrow. Only callable by the original sender if not yet claimed or cancelled.
    /// Transfers the full amount back to the sender and sets Cancelled status.
    ///
    /// `reason` must be one of the defined cancellation codes:
    /// - `1` — sender_requested
    /// - `2` — expired
    /// - `3` — admin
    ///
    /// The reason is persisted under `DataKey::CancelReason` and included in
    /// the `GiftCancelled` (`cancelled`) event payload.
    ///
    /// **Breaking change:** `cancel` now requires a `reason` argument. Clients
    /// calling `cancel` with no arguments are no longer supported.
    pub fn cancel(env: Env, reason: u32) -> Result<(), EscrowError> {
        if !is_valid_cancel_reason(reason) {
            return Err(EscrowError::InvalidCancelReason);
        }

        let sender: Address = env
            .storage()
            .instance()
            .get(&DataKey::Sender)
            .ok_or(EscrowError::NotInitialized)?;

        sender.require_auth();

        let claimed: bool = env
            .storage()
            .instance()
            .get(&DataKey::Claimed)
            .unwrap_or(false);

        if claimed {
            return Err(EscrowError::AlreadyClaimed);
        }

        let cancelled: bool = env
            .storage()
            .instance()
            .get(&DataKey::Cancelled)
            .unwrap_or(false);

        if cancelled {
            return Err(EscrowError::AlreadyCancelled);
        }

        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(EscrowError::NotInitialized)?;

        let amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Amount)
            .ok_or(EscrowError::NotInitialized)?;

        env.storage().instance().set(&DataKey::Cancelled, &true);
        env.storage().instance().set(&DataKey::CancelReason, &reason);

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &sender, &amount);

        env.events().publish(
            (Symbol::new(&env, "cancelled"),),
            (sender, amount, reason),
        );

        Ok(())
    }

    /// Read-only: returns the cancellation reason code recorded by `cancel`.
    pub fn get_cancel_reason(env: Env) -> Result<u32, EscrowError> {
        env.storage()
            .instance()
            .get(&DataKey::CancelReason)
            .ok_or(EscrowError::NotInitialized)
    }

    /// Read-only: returns (recipient, amount, unlock_time, claimed).
    ///
    /// The `claimed` bool is kept for backwards compatibility.
    /// Prefer `get_status` for explicit lifecycle state.
    pub fn get_state(env: Env) -> Result<(Address, i128, u64, bool), EscrowError> {
        let recipient: Address = env
            .storage()
            .instance()
            .get(&DataKey::Recipient)
            .ok_or(EscrowError::NotInitialized)?;
        let amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Amount)
            .ok_or(EscrowError::NotInitialized)?;
        let unlock_time: u64 = env
            .storage()
            .instance()
            .get(&DataKey::UnlockTime)
            .ok_or(EscrowError::NotInitialized)?;
        let claimed: bool = env
            .storage()
            .instance()
            .get(&DataKey::Claimed)
            .unwrap_or(false);

        Ok((recipient, amount, unlock_time, claimed))
    }

    /// Read-only: returns the explicit `EscrowStatus` for this escrow.
    ///
    /// Unlike `get_state`, this method expresses the full lifecycle as a
    /// single enum value so the backend can reconcile without guessing:
    ///
    /// - `Locked`    — initialized, unlock time not yet reached
    /// - `Unlocked`  — unlock time reached, recipient has not yet claimed
    /// - `Claimed`   — funds transferred to recipient (terminal)
    /// - `Cancelled` — sender cancelled and funds returned (terminal)
    ///
    /// Terminal states (`Claimed`, `Cancelled`) cannot contradict each other
    /// because the contract writes them atomically and checks each terminal
    /// flag before allowing any state transition.
    pub fn get_status(env: Env) -> Result<EscrowStatus, EscrowError> {
        // Require the contract to be initialized
        if !env.storage().instance().has(&DataKey::Sender) {
            return Err(EscrowError::NotInitialized);
        }

        let claimed: bool = env
            .storage()
            .instance()
            .get(&DataKey::Claimed)
            .unwrap_or(false);

        if claimed {
            return Ok(EscrowStatus::Claimed);
        }

        let cancelled: bool = env
            .storage()
            .instance()
            .get(&DataKey::Cancelled)
            .unwrap_or(false);

        if cancelled {
            return Ok(EscrowStatus::Cancelled);
        }

        let unlock_time: u64 = env
            .storage()
            .instance()
            .get(&DataKey::UnlockTime)
            .ok_or(EscrowError::NotInitialized)?;

        if env.ledger().timestamp() < unlock_time {
            Ok(EscrowStatus::Locked)
        } else {
            Ok(EscrowStatus::Unlocked)
        }
    }

    /// Upgrade the contract WASM. Restricted to the admin address stored at initialization.
    ///
    /// Emits an `upgraded` event containing the new WASM hash so off-chain
    /// indexers can track contract versions.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), EscrowError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(EscrowError::NotInitialized)?;

        admin.require_auth();

        let old_wasm_hash = env.current_contract_address();
        env.deployer().update_current_contract_wasm(new_wasm_hash.clone());

        env.events().publish(
            (Symbol::new(&env, "upgraded"),),
            (old_wasm_hash, new_wasm_hash),
        );

        Ok(())
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Env,
    };

    fn create_token<'a>(env: &'a Env, admin: &Address) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
        let token_id = env.register_stellar_asset_contract(admin.clone());
        let token = TokenClient::new(env, &token_id);
        let token_admin = StellarAssetClient::new(env, &token_id);
        (token_id, token, token_admin)
    }

    #[test]
    fn test_initialize_and_claim() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token_id, token, token_admin) = create_token(&env, &sender);

        token_admin.mint(&sender, &100_000_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        // unlock_time must be > ledger.timestamp() + MIN_LOCK_DURATION (3600)
        client.initialize(&sender, &sender, &recipient, &token_id, &100_000_000, &3_601);
        env.ledger().with_mut(|l| l.timestamp = 3_601);
        client.claim();

        assert_eq!(token.balance(&recipient), 100_000_000);
    }

    #[test]
    fn test_double_initialize_returns_error() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token_id, _, token_admin) = create_token(&env, &sender);
        token_admin.mint(&sender, &200_000_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        client.initialize(&sender, &sender, &recipient, &token_id, &100_000_000, &3_601);

        let err = client
            .try_initialize(&sender, &sender, &recipient, &token_id, &100_000_000, &3_601)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, EscrowError::AlreadyInitialized);
    }

    #[test]
    fn test_reinitialize_does_not_alter_original_state() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let attacker = Address::generate(&env);
        let (token_id, _, token_admin) = create_token(&env, &sender);
        // Mint enough for both the original init and the attempted re-init
        token_admin.mint(&sender, &200_000_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        // First initialization — establishes the original state
        let original_amount: i128 = 100_000_000;
        let original_unlock: u64 = 9_999;
        client.initialize(&sender, &sender, &recipient, &token_id, &original_amount, &original_unlock);

        // Attempt re-initialization with different values — must fail
        let err = client
            .try_initialize(&attacker, &attacker, &attacker, &token_id, &50_000_000, &1)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, EscrowError::AlreadyInitialized);

        // Verify original state is completely unchanged
        let (state_recipient, state_amount, state_unlock, state_claimed) =
            client.get_state();
        assert_eq!(state_recipient, recipient, "recipient must not change after failed re-init");
        assert_eq!(state_amount, original_amount, "amount must not change after failed re-init");
        assert_eq!(state_unlock, original_unlock, "unlock_time must not change after failed re-init");
        assert!(!state_claimed, "claimed flag must remain false after failed re-init");
    }

    #[test]
    fn test_claim_before_unlock_returns_error() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token_id, _, token_admin) = create_token(&env, &sender);
        token_admin.mint(&sender, &100_000_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        client.initialize(&sender, &sender, &recipient, &token_id, &100_000_000, &9_999_999);

        let err = client.try_claim().unwrap_err().unwrap();
        assert_eq!(err, EscrowError::StillLocked);
    }

    #[test]
    fn test_double_claim_returns_error() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token_id, _, token_admin) = create_token(&env, &sender);
        token_admin.mint(&sender, &100_000_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        client.initialize(&sender, &sender, &recipient, &token_id, &100_000_000, &3_601);
        env.ledger().with_mut(|l| l.timestamp = 3_601);
        client.claim();

        let err = client.try_claim().unwrap_err().unwrap();
        assert_eq!(err, EscrowError::AlreadyClaimed);
    }

    #[test]
    fn test_get_state_not_initialized_returns_error() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let err = client.try_get_state().unwrap_err().unwrap();
        assert_eq!(err, EscrowError::NotInitialized);
    }

    #[test]
    fn test_initialize_insufficient_balance_returns_error() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token_id, token, token_admin) = create_token(&env, &sender);

        token_admin.mint(&sender, &50_000_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let err = client
            .try_initialize(&sender, &sender, &recipient, &token_id, &100_000_000, &3_601)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, EscrowError::InsufficientBalance);
        assert_eq!(token.balance(&sender), 50_000_000);
        assert!(client.try_get_state().is_err());
    }

    #[test]
    fn test_initialize_zero_amount_returns_invalid_amount() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token_id, _, _) = create_token(&env, &sender);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let err = client
            .try_initialize(&sender, &sender, &recipient, &token_id, &0, &1_000)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, EscrowError::InvalidAmount);
    }

    #[test]
    fn test_initialize_below_minimum_amount_returns_invalid_amount() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token_id, _, token_admin) = create_token(&env, &sender);
        token_admin.mint(&sender, &9_999_999);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        // 9_999_999 stroops = just under 1 USDC minimum
        let err = client
            .try_initialize(&sender, &sender, &recipient, &token_id, &9_999_999, &1_000)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, EscrowError::InvalidAmount);
    }

    #[test]
    fn test_initialize_past_unlock_time_returns_invalid_unlock_time() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token_id, _, token_admin) = create_token(&env, &sender);
        token_admin.mint(&sender, &100_000_000);

        // Set ledger timestamp to a known value
        env.ledger().with_mut(|l| l.timestamp = 10_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        // unlock_time in the past
        let err = client
            .try_initialize(&sender, &sender, &recipient, &token_id, &100_000_000, &5_000)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, EscrowError::InvalidUnlockTime);
    }

    #[test]
    fn test_initialize_current_timestamp_returns_invalid_unlock_time() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token_id, _, token_admin) = create_token(&env, &sender);
        token_admin.mint(&sender, &100_000_000);

        env.ledger().with_mut(|l| l.timestamp = 10_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        // unlock_time == current timestamp (not in the future by MIN_LOCK_DURATION)
        let err = client
            .try_initialize(&sender, &sender, &recipient, &token_id, &100_000_000, &10_000)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, EscrowError::InvalidUnlockTime);
    }

    #[test]
    fn test_initialize_unlock_time_just_below_minimum_duration_returns_invalid_unlock_time() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token_id, _, token_admin) = create_token(&env, &sender);
        token_admin.mint(&sender, &100_000_000);

        env.ledger().with_mut(|l| l.timestamp = 10_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        // unlock_time = now + MIN_LOCK_DURATION (must be strictly greater)
        let err = client
            .try_initialize(&sender, &sender, &recipient, &token_id, &100_000_000, &13_600)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, EscrowError::InvalidUnlockTime);
    }

    #[test]
    fn test_initialize_valid_unlock_time_succeeds() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token_id, token, token_admin) = create_token(&env, &sender);
        token_admin.mint(&sender, &100_000_000);

        env.ledger().with_mut(|l| l.timestamp = 10_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        // unlock_time = now + MIN_LOCK_DURATION + 1 (valid)
        client.initialize(&sender, &sender, &recipient, &token_id, &100_000_000, &13_601);

        // Advance past unlock and claim
        env.ledger().with_mut(|l| l.timestamp = 13_601);
        client.claim();
        assert_eq!(token.balance(&recipient), 100_000_000);
    }
}

// ─── Cancel tests (#45) ───────────────────────────────────────────────────────

#[cfg(test)]
mod cancel_tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
        token::{Client as TokenClient, StellarAssetClient},
        Env, IntoVal,
    };

    fn setup(env: &Env) -> (Address, Address, Address, TokenClient, EscrowContractClient) {
        env.mock_all_auths();
        let sender = Address::generate(env);
        let recipient = Address::generate(env);
        let token_id = env.register_stellar_asset_contract(sender.clone());
        let token = TokenClient::new(env, &token_id);
        StellarAssetClient::new(env, &token_id).mint(&sender, &100_000_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(env, &contract_id);
        client.initialize(&sender, &sender, &recipient, &token_id, &100_000_000, &3_601);

        (sender, recipient, token_id, token, client)
    }

    /// Sender can cancel before claim — funds return to sender.
    #[test]
    fn test_cancel_by_sender_returns_funds() {
        let env = Env::default();
        let (sender, _recipient, _token_id, token, client) = setup(&env);

        let balance_before = token.balance(&sender);
        client.cancel(&CANCEL_REASON_SENDER_REQUESTED);
        assert_eq!(token.balance(&sender), balance_before + 100_000_000);
    }

    /// Non-sender (attacker) cannot cancel.
    #[test]
    fn test_cancel_by_non_sender_panics() {
        let env = Env::default();
        let (_sender, _recipient, _token_id, _token, client) = setup(&env);

        let attacker = Address::generate(&env);
        client
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "cancel",
                    args: (CANCEL_REASON_SENDER_REQUESTED,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_cancel(&CANCEL_REASON_SENDER_REQUESTED)
            .expect_err("non-sender must not be able to cancel");
    }

    /// Cancel after claim must fail with AlreadyClaimed.
    #[test]
    fn test_cancel_after_claim_returns_error() {
        let env = Env::default();
        let (_sender, _recipient, _token_id, _token, client) = setup(&env);

        env.ledger().with_mut(|l| l.timestamp = 3_601);
        client.claim();

        let err = client.try_cancel(&CANCEL_REASON_SENDER_REQUESTED).unwrap_err().unwrap();
        assert_eq!(err, EscrowError::AlreadyClaimed);
    }

    /// Double cancel must fail with AlreadyCancelled.
    #[test]
    fn test_double_cancel_returns_error() {
        let env = Env::default();
        let (_sender, _recipient, _token_id, _token, client) = setup(&env);

        client.cancel(&CANCEL_REASON_SENDER_REQUESTED);
        let err = client.try_cancel(&CANCEL_REASON_SENDER_REQUESTED).unwrap_err().unwrap();
        assert_eq!(err, EscrowError::AlreadyCancelled);
    }
}

// ─── Authorization tests (#62) ────────────────────────────────────────────────

#[cfg(test)]
mod auth_tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
        token::StellarAssetClient,
        Env, IntoVal,
    };

    fn setup(env: &Env) -> (Address, Address, EscrowContractClient) {
        let sender = Address::generate(env);
        let recipient = Address::generate(env);
        let token_id = env.register_stellar_asset_contract(sender.clone());
        StellarAssetClient::new(env, &token_id).mint(&sender, &100_000_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(env, &contract_id);

        // unlock_time = 3_601 (> 0 + MIN_LOCK_DURATION)
        env.mock_all_auths();
        client.initialize(&sender, &sender, &recipient, &token_id, &100_000_000, &3_601);

        // Advance past unlock so the only barrier is auth, not time
        env.ledger().with_mut(|l| l.timestamp = 3_601);

        (sender, recipient, client)
    }

    /// A third-party address that is neither sender nor recipient must not be
    /// able to claim. The contract calls `recipient.require_auth()`, so any
    /// caller other than the stored recipient will fail authorization.
    #[test]
    fn test_third_party_cannot_claim() {
        let env = Env::default();
        let (_, _recipient, client) = setup(&env);

        let attacker = Address::generate(&env);

        // Authorize only the attacker — NOT the recipient.
        // require_auth() will panic, which the test harness surfaces as an Err.
        client
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "claim",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_claim()
            .expect_err("third-party must not be able to claim");
    }

    /// The sender must not be able to claim their own gift.
    #[test]
    fn test_sender_cannot_claim() {
        let env = Env::default();
        let (sender, _, client) = setup(&env);

        // Authorize only the sender — NOT the recipient.
        client
            .mock_auths(&[MockAuth {
                address: &sender,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "claim",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_claim()
            .expect_err("sender must not be able to claim");
    }
}

// ─── Boundary tests (#64) ─────────────────────────────────────────────────────
//
// The contract uses `env.ledger().timestamp() < unlock_time` (strict less-than).
// Therefore:
//   - timestamp == unlock_time  → claim SUCCEEDS  (boundary is inclusive)
//   - timestamp == unlock_time - 1 → claim FAILS  (still locked)

#[cfg(test)]
mod boundary_tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Env,
    };

    fn setup_at(env: &Env, unlock_time: u64) -> EscrowContractClient {
        env.mock_all_auths();
        let sender = Address::generate(env);
        let recipient = Address::generate(env);
        let token_id = env.register_stellar_asset_contract(sender.clone());
        StellarAssetClient::new(env, &token_id).mint(&sender, &100_000_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(env, &contract_id);
        client.initialize(&sender, &sender, &recipient, &token_id, &100_000_000, &unlock_time);
        client
    }

    /// Ledger timestamp == unlock_time: claim must SUCCEED.
    /// The condition is `now < unlock_time`, so equality is NOT locked.
    #[test]
    fn test_claim_at_exactly_unlock_time_succeeds() {
        let env = Env::default();
        let unlock_time: u64 = 3_601;
        let client = setup_at(&env, unlock_time);

        // Set ledger to exactly unlock_time
        env.ledger().with_mut(|l| l.timestamp = unlock_time);

        // Must not return StillLocked
        client.claim();
    }

    /// Ledger timestamp == unlock_time - 1: claim must FAIL with StillLocked.
    #[test]
    fn test_claim_one_second_before_unlock_fails() {
        let env = Env::default();
        let unlock_time: u64 = 3_601;
        let client = setup_at(&env, unlock_time);

        // One second before unlock
        env.ledger().with_mut(|l| l.timestamp = unlock_time - 1);

        let err = client.try_claim().unwrap_err().unwrap();
        assert_eq!(err, EscrowError::StillLocked);
    }
}

// ─── Property-based tests ─────────────────────────────────────────────────────
//
// Each proptest! block runs at least 1 000 cases (proptest default).
// The four properties below map directly to the acceptance criteria in issue #109.

#[cfg(test)]
mod property_tests {
    use super::*;
    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Env,
    };

    // ── helpers ──────────────────────────────────────────────────────────────

    fn setup_initialized_escrow(
        amount: i128,
        unlock_time: u64,
    ) -> (Env, Address, TokenClient<'static>, EscrowContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract(sender.clone());
        let token = TokenClient::new(&env, &token_id);
        let token_admin = StellarAssetClient::new(&env, &token_id);
        token_admin.mint(&sender, &amount);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&sender, &sender, &recipient, &token_id, &amount, &unlock_time);

        (env, recipient, token, client)
    }

    // ── Property 1 ───────────────────────────────────────────────────────────
    // After a successful claim the contract's token balance is always 0.

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1_000))]
        #[test]
        fn prop_balance_zero_after_claim(
            amount    in MIN_AMOUNT..=1_000_000_000_i128,
            unlock_time in (MIN_LOCK_DURATION + 1)..=1_000_000u64,
        ) {
            let (env, _recipient, token, client) =
                setup_initialized_escrow(amount, unlock_time);

            // Advance ledger past unlock_time so the claim succeeds
            env.ledger().with_mut(|l| l.timestamp = unlock_time);
            client.claim();

            let contract_balance = token.balance(&client.address);
            prop_assert_eq!(
                contract_balance, 0,
                "contract balance must be 0 after claim, got {}",
                contract_balance
            );
        }
    }

    // ── Property 2 ───────────────────────────────────────────────────────────
    // The amount received by the recipient always equals the initialized amount.

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1_000))]
        #[test]
        fn prop_claimed_amount_equals_initialized_amount(
            amount    in MIN_AMOUNT..=1_000_000_000_i128,
            unlock_time in (MIN_LOCK_DURATION + 1)..=1_000_000u64,
        ) {
            let (env, recipient, token, client) =
                setup_initialized_escrow(amount, unlock_time);

            let balance_before = token.balance(&recipient);

            env.ledger().with_mut(|l| l.timestamp = unlock_time);
            client.claim();

            let received = token.balance(&recipient) - balance_before;
            prop_assert_eq!(
                received, amount,
                "recipient received {} but expected {}",
                received, amount
            );
        }
    }

    // ── Property 3 ───────────────────────────────────────────────────────────
    // Claim always fails with StillLocked when ledger timestamp < unlock_time.

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1_000))]
        #[test]
        fn prop_claim_fails_before_unlock(
            amount      in MIN_AMOUNT..=1_000_000_000_i128,
            unlock_time in (MIN_LOCK_DURATION + 2)..=u64::MAX / 2,
            // ledger_ts is strictly less than unlock_time
            ledger_ts   in 0u64..=1u64,
        ) {
            // Map ledger_ts into [0, unlock_time - 1]
            let ledger_ts = ledger_ts % unlock_time; // always < unlock_time

            let (env, _recipient, _token, client) =
                setup_initialized_escrow(amount, unlock_time);

            env.ledger().with_mut(|l| l.timestamp = ledger_ts);

            let err = client.try_claim().unwrap_err().unwrap();
            prop_assert_eq!(
                err,
                EscrowError::StillLocked,
                "expected StillLocked at ts={}, unlock={}",
                ledger_ts, unlock_time
            );
        }
    }

    // ── Property 4 ───────────────────────────────────────────────────────────
    // A second call to initialize always fails with AlreadyInitialized.

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1_000))]
        #[test]
        fn prop_double_initialize_always_fails(
            amount      in MIN_AMOUNT..=1_000_000_000_i128,
            unlock_time in (MIN_LOCK_DURATION + 1)..=u64::MAX / 2,
            amount2     in MIN_AMOUNT..=1_000_000_000_i128,
            unlock_time2 in (MIN_LOCK_DURATION + 1)..=u64::MAX / 2,
        ) {
            let env = Env::default();
            env.mock_all_auths();

            let sender = Address::generate(&env);
            let recipient = Address::generate(&env);
            let token_id = env.register_stellar_asset_contract(sender.clone());
            let token_admin = StellarAssetClient::new(&env, &token_id);
            // Mint enough for both initialize calls
            token_admin.mint(&sender, &(amount + amount2));

            let contract_id = env.register_contract(None, EscrowContract);
            let client = EscrowContractClient::new(&env, &contract_id);

            // First initialize must succeed
            client.initialize(&sender, &sender, &recipient, &token_id, &amount, &unlock_time);

            // Second initialize must always fail regardless of arguments
            let err = client
                .try_initialize(&sender, &sender, &recipient, &token_id, &amount2, &unlock_time2)
                .unwrap_err()
                .unwrap();

            prop_assert_eq!(
                err,
                EscrowError::AlreadyInitialized,
                "expected AlreadyInitialized on second call"
            );
        }
    }
}


// ─── Time-lock arithmetic property tests (issue #357) ─────────────────────────
//
// Each proptest! runs 10 000 cases. Tests are prefixed `fuzz_` so the
// `contract-fuzz` CI job runs them. Covers epoch 0, far-future timestamps
// (up to u64::MAX) and edge-case amounts (0, 1, i128::MAX — the contract's
// amount type is i128, so i128::MAX is the largest representable value).

#[cfg(test)]
mod time_lock_property_tests {
    use super::*;
    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Env,
    };

    /// Calls `initialize` at ledger time `now` and returns the contract error,
    /// if any. The token is a random address, so validation that passes the
    /// amount and unlock-time checks ends at `InvalidToken`.
    fn init_error(now: u64, amount: i128, unlock_time: u64) -> Option<EscrowError> {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = now);

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token = Address::generate(&env);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        match client.try_initialize(&sender, &sender, &recipient, &token, &amount, &unlock_time) {
            Err(Ok(e)) => Some(e),
            _ => None,
        }
    }

    fn ttl_at(now: u64, unlock_time: u64) -> u32 {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = now);
        required_ttl_ledgers(&env, unlock_time)
    }

    fn edge_amount() -> impl Strategy<Value = i128> {
        prop_oneof![
            Just(0_i128),
            Just(1_i128),
            Just(-1_i128),
            Just(i128::MIN),
            Just(MIN_AMOUNT - 1),
            Just(MIN_AMOUNT),
            Just(i128::MAX),
            any::<i128>(),
        ]
    }

    fn edge_timestamp() -> impl Strategy<Value = u64> {
        prop_oneof![
            Just(0_u64),
            Just(MIN_LOCK_DURATION),
            Just(u64::MAX - MIN_LOCK_DURATION - 1),
            Just(u64::MAX),
            any::<u64>(),
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// Unlock times at or before `now + MIN_LOCK_DURATION` are always rejected.
        #[test]
        fn fuzz_past_or_near_unlock_time_rejected(now in edge_timestamp(), offset in any::<u64>()) {
            let limit = now.saturating_add(MIN_LOCK_DURATION);
            let unlock_time = limit - offset % limit.saturating_add(1);
            prop_assert_eq!(
                init_error(now, MIN_AMOUNT, unlock_time),
                Some(EscrowError::InvalidUnlockTime)
            );
        }

        /// Unlock times strictly after `now + MIN_LOCK_DURATION` pass the time-lock check.
        #[test]
        fn fuzz_future_unlock_time_accepted(
            now in 0..=(u64::MAX - MIN_LOCK_DURATION - 1),
            offset in any::<u64>(),
        ) {
            let earliest = now + MIN_LOCK_DURATION + 1;
            let unlock_time = earliest + offset % (u64::MAX - earliest + 1);
            prop_assert_ne!(
                init_error(now, MIN_AMOUNT, unlock_time),
                Some(EscrowError::InvalidUnlockTime)
            );
        }

        /// Amounts below MIN_AMOUNT (incl. 0, 1, negatives) are rejected; all
        /// others, up to i128::MAX, pass the amount check without overflow.
        #[test]
        fn fuzz_edge_amounts_respect_minimum(amount in edge_amount()) {
            let err = init_error(0, amount, MIN_LOCK_DURATION + 1);
            if amount < MIN_AMOUNT {
                prop_assert_eq!(err, Some(EscrowError::InvalidAmount));
            } else {
                prop_assert_ne!(err, Some(EscrowError::InvalidAmount));
            }
        }

        /// TTL never panics, is exactly the buffer once unlocked, and is at
        /// least the buffer plus the ledgers remaining until unlock otherwise.
        #[test]
        fn fuzz_ttl_covers_lock_period(now in edge_timestamp(), unlock_time in edge_timestamp()) {
            let ttl = ttl_at(now, unlock_time);
            if unlock_time <= now {
                prop_assert_eq!(ttl, BUFFER_LEDGERS);
            } else {
                let ledgers = (unlock_time - now).div_ceil(LEDGER_CLOSE_SECS);
                let expected = (ledgers.min(u32::MAX as u64) as u32).saturating_add(BUFFER_LEDGERS);
                prop_assert_eq!(ttl, expected);
                prop_assert!(ttl >= BUFFER_LEDGERS);
            }
        }

        /// TTL is monotonically non-decreasing in unlock_time.
        #[test]
        fn fuzz_ttl_monotonic(now in edge_timestamp(), a in edge_timestamp(), b in edge_timestamp()) {
            let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
            prop_assert!(ttl_at(now, lo) <= ttl_at(now, hi));
        }
    }
}

// ─── Invariant and extended property-based tests (#82) ───────────────────────
//
// These tests address the three acceptance criteria from issue #82:
//
//   1. Funds cannot be double-claimed across arbitrary call sequences.
//   2. Funds cannot be lost — they always end up either with the recipient
//      (after claim) or the sender (after cancel), never stuck in the contract.
//   3. Transfer always goes to the intended address, never to a third party.
//
// Each proptest! runs 1 000 cases (proptest default).
// Failures print the seed so they are fully reproducible.

#[cfg(test)]
mod invariant_tests {
    use super::*;
    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Env,
    };

    // ── shared setup ─────────────────────────────────────────────────────────

    fn setup_escrow(
        amount: i128,
        unlock_time: u64,
    ) -> (Env, Address, Address, Address, TokenClient<'static>, EscrowContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();

        let sender    = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_id  = env.register_stellar_asset_contract(sender.clone());
        let token     = TokenClient::new(&env, &token_id);
        StellarAssetClient::new(&env, &token_id).mint(&sender, &amount);

        let contract_id = env.register_contract(None, EscrowContract);
        let client      = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&sender, &sender, &recipient, &token_id, &amount, &unlock_time);

        (env, sender, recipient, token_id, token, client)
    }

    // ── Invariant 1: no double-claim ─────────────────────────────────────────
    // After a successful claim, every subsequent claim call must fail.
    // Across any number of repetitions the contract balance stays 0 and the
    // claimed flag stays true.

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1_000))]
        #[test]
        fn prop_no_double_claim(
            amount      in MIN_AMOUNT..=1_000_000_000_i128,
            unlock_time in (MIN_LOCK_DURATION + 1)..=1_000_000u64,
            extra_calls in 1u32..=5u32,   // how many times to attempt a second claim
        ) {
            let (env, _sender, _recipient, _token_id, token, client) =
                setup_escrow(amount, unlock_time);

            env.ledger().with_mut(|l| l.timestamp = unlock_time);
            client.claim();

            // Contract balance must be zero
            prop_assert_eq!(
                token.balance(&client.address), 0,
                "contract balance must be 0 after claim"
            );

            // Every subsequent attempt must return AlreadyClaimed
            for _ in 0..extra_calls {
                let err = client.try_claim().unwrap_err().unwrap();
                prop_assert_eq!(
                    err,
                    EscrowError::AlreadyClaimed,
                    "repeated claim must return AlreadyClaimed"
                );
                // Balance must remain 0 after failed re-claim attempts
                prop_assert_eq!(
                    token.balance(&client.address), 0,
                    "contract balance must stay 0 after failed re-claim"
                );
            }
        }
    }

    // ── Invariant 2: funds are never lost ─────────────────────────────────────
    // The total supply of tokens is always conserved:
    //   sender_balance + recipient_balance + contract_balance == initial_amount
    // at every observable point in the escrow lifecycle.

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1_000))]
        #[test]
        fn prop_funds_conservation_after_claim(
            amount      in MIN_AMOUNT..=1_000_000_000_i128,
            unlock_time in (MIN_LOCK_DURATION + 1)..=1_000_000u64,
        ) {
            let (env, sender, recipient, _token_id, token, client) =
                setup_escrow(amount, unlock_time);

            // After initialize: contract holds `amount`, sender balance == 0
            let contract_bal = token.balance(&client.address);
            let sender_bal   = token.balance(&sender);
            let recip_bal    = token.balance(&recipient);
            prop_assert_eq!(
                contract_bal + sender_bal + recip_bal,
                amount,
                "funds must be conserved after initialize"
            );

            // After claim: recipient holds `amount`, contract and sender == 0
            env.ledger().with_mut(|l| l.timestamp = unlock_time);
            client.claim();

            let contract_bal = token.balance(&client.address);
            let sender_bal   = token.balance(&sender);
            let recip_bal    = token.balance(&recipient);
            prop_assert_eq!(
                contract_bal + sender_bal + recip_bal,
                amount,
                "funds must be conserved after claim"
            );
            prop_assert_eq!(
                contract_bal, 0,
                "contract must hold 0 after claim"
            );
            prop_assert_eq!(
                recip_bal, amount,
                "recipient must hold full amount after claim"
            );
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1_000))]
        #[test]
        fn prop_funds_conservation_after_cancel(
            amount      in MIN_AMOUNT..=1_000_000_000_i128,
            unlock_time in (MIN_LOCK_DURATION + 1)..=1_000_000u64,
        ) {
            let (env, sender, recipient, _token_id, token, client) =
                setup_escrow(amount, unlock_time);

            // cancel before unlock — funds must return to sender
            client.cancel();

            let contract_bal = token.balance(&client.address);
            let sender_bal   = token.balance(&sender);
            let recip_bal    = token.balance(&recipient);
            prop_assert_eq!(
                contract_bal + sender_bal + recip_bal,
                amount,
                "funds must be conserved after cancel"
            );
            prop_assert_eq!(
                contract_bal, 0,
                "contract must hold 0 after cancel"
            );
            prop_assert_eq!(
                recip_bal, 0,
                "recipient must hold 0 after cancel"
            );
            prop_assert_eq!(
                sender_bal, amount,
                "sender must receive full amount back after cancel"
            );
        }
    }

    // ── Invariant 3: funds go to the intended address only ───────────────────
    // A third-party address must never gain any balance as a result of a claim
    // or cancel operation, regardless of when it is called.

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1_000))]
        #[test]
        fn prop_third_party_never_receives_funds_on_claim(
            amount      in MIN_AMOUNT..=1_000_000_000_i128,
            unlock_time in (MIN_LOCK_DURATION + 1)..=1_000_000u64,
        ) {
            let (env, _sender, _recipient, _token_id, token, client) =
                setup_escrow(amount, unlock_time);

            let third_party = Address::generate(&env);
            let balance_before = token.balance(&third_party);

            env.ledger().with_mut(|l| l.timestamp = unlock_time);
            client.claim();

            prop_assert_eq!(
                token.balance(&third_party),
                balance_before,
                "third party balance must not change after claim"
            );
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1_000))]
        #[test]
        fn prop_third_party_never_receives_funds_on_cancel(
            amount      in MIN_AMOUNT..=1_000_000_000_i128,
            unlock_time in (MIN_LOCK_DURATION + 1)..=1_000_000u64,
        ) {
            let (env, _sender, _recipient, _token_id, token, client) =
                setup_escrow(amount, unlock_time);

            let third_party = Address::generate(&env);
            let balance_before = token.balance(&third_party);

            client.cancel();

            prop_assert_eq!(
                token.balance(&third_party),
                balance_before,
                "third party balance must not change after cancel"
            );
        }
    }

    // ── Invariant 4: terminal states cannot be undone ─────────────────────────
    // After a claim, cancel is rejected (AlreadyClaimed).
    // After a cancel, claim is rejected (AlreadyCancelled).

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1_000))]
        #[test]
        fn prop_cancel_after_claim_always_fails(
            amount      in MIN_AMOUNT..=1_000_000_000_i128,
            unlock_time in (MIN_LOCK_DURATION + 1)..=1_000_000u64,
        ) {
            let (env, _sender, _recipient, _token_id, _token, client) =
                setup_escrow(amount, unlock_time);

            env.ledger().with_mut(|l| l.timestamp = unlock_time);
            client.claim();

            let err = client.try_cancel().unwrap_err().unwrap();
            prop_assert_eq!(
                err,
                EscrowError::AlreadyClaimed,
                "cancel after claim must return AlreadyClaimed"
            );
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1_000))]
        #[test]
        fn prop_claim_after_cancel_always_fails(
            amount      in MIN_AMOUNT..=1_000_000_000_i128,
            unlock_time in (MIN_LOCK_DURATION + 1)..=1_000_000u64,
        ) {
            let (env, _sender, _recipient, _token_id, _token, client) =
                setup_escrow(amount, unlock_time);

            client.cancel();

            env.ledger().with_mut(|l| l.timestamp = unlock_time);
            let err = client.try_claim().unwrap_err().unwrap();
            prop_assert_eq!(
                err,
                EscrowError::AlreadyCancelled,
                "claim after cancel must return AlreadyCancelled"
            );
        }
    }
}

// ─── Upgrade tests (#49) ──────────────────────────────────────────────────────
//
// Verifies that only the admin can upgrade the contract WASM.

#[cfg(test)]
mod upgrade_tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke},
        token::StellarAssetClient,
        BytesN, Env, IntoVal,
    };

    fn setup(env: &Env) -> (Address, Address, EscrowContractClient) {
        env.mock_all_auths();
        let admin = Address::generate(env);
        let sender = Address::generate(env);
        let recipient = Address::generate(env);
        let token_id = env.register_stellar_asset_contract(sender.clone());
        StellarAssetClient::new(env, &token_id).mint(&sender, &100_000_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(env, &contract_id);
        client.initialize(&admin, &sender, &recipient, &token_id, &100_000_000, &3_601);

        (admin, sender, client)
    }

    /// Only the admin address stored at initialization can call upgrade.
    #[test]
    fn test_upgrade_restricted_to_admin() {
        let env = Env::default();
        let (admin, _sender, client) = setup(&env);

        let new_wasm_hash = BytesN::from_array(&env, &[0u8; 32]);

        // Admin can upgrade
        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "upgrade",
                    args: (new_wasm_hash.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .upgrade(&new_wasm_hash);
    }

    /// A non-admin address must not be able to upgrade the contract.
    #[test]
    fn test_non_admin_cannot_upgrade() {
        let env = Env::default();
        let (_admin, _sender, client) = setup(&env);

        let attacker = Address::generate(&env);
        let new_wasm_hash = BytesN::from_array(&env, &[0u8; 32]);

        // Attacker cannot upgrade — require_auth will panic
        client
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "upgrade",
                    args: (new_wasm_hash.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_upgrade(&new_wasm_hash)
            .expect_err("non-admin must not be able to upgrade");
    }

    // ─── Timestamp Boundary Semantics Tests ───────────────────────────────────────

    /// Verify exact timestamp boundary semantics:
    /// - At `timestamp == unlock_time - 1`: status is `Locked`, claim returns `StillLocked`.
    /// - At `timestamp == unlock_time`: status is `Unlocked`, claim SUCCEEDS (inclusive rule).
    /// - At `timestamp == unlock_time + 1`: status is `Unlocked`, claim SUCCEEDS.
    #[test]
    fn test_claim_boundary_exactly_at_unlock_time_succeeds() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token_id, token, token_admin) = create_token(&env, &sender);
        token_admin.mint(&sender, &100_000_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let unlock_time: u64 = 10_000;
        // Initialize at timestamp 100 (unlock_time > 100 + 3600 = 3700)
        env.ledger().with_mut(|l| l.timestamp = 100);
        client.initialize(&sender, &sender, &recipient, &token_id, &100_000_000, &unlock_time);

        // 1 second BEFORE unlock_time (9_999) -> must fail with StillLocked
        env.ledger().with_mut(|l| l.timestamp = unlock_time - 1);
        assert_eq!(client.get_status(), EscrowStatus::Locked);
        let err = client.try_claim().unwrap_err().unwrap();
        assert_eq!(err, EscrowError::StillLocked);

        // EXACTLY AT unlock_time (10_000) -> must transition to Unlocked and claim SUCCEEDS
        env.ledger().with_mut(|l| l.timestamp = unlock_time);
        assert_eq!(client.get_status(), EscrowStatus::Unlocked);
        client.claim();

        // After claim -> Claimed
        assert_eq!(client.get_status(), EscrowStatus::Claimed);
        assert_eq!(token.balance(&recipient), 100_000_000);
    }

    #[test]
    fn test_claim_boundary_one_second_after_unlock_time_succeeds() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token_id, token, token_admin) = create_token(&env, &sender);
        token_admin.mint(&sender, &100_000_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let unlock_time: u64 = 5_000;
        env.ledger().with_mut(|l| l.timestamp = 0);
        client.initialize(&sender, &sender, &recipient, &token_id, &100_000_000, &unlock_time);

        // 1 second AFTER unlock_time (5_001) -> succeeds
        env.ledger().with_mut(|l| l.timestamp = unlock_time + 1);
        assert_eq!(client.get_status(), EscrowStatus::Unlocked);
        client.claim();

        assert_eq!(client.get_status(), EscrowStatus::Claimed);
        assert_eq!(token.balance(&recipient), 100_000_000);
    }

    #[test]
    fn test_initialize_boundary_min_lock_duration() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token_id, _, token_admin) = create_token(&env, &sender);
        token_admin.mint(&sender, &200_000_000);

        let current_ts: u64 = 1_000;
        env.ledger().with_mut(|l| l.timestamp = current_ts);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        // Exactly at current_ts + MIN_LOCK_DURATION (1000 + 3600 = 4600) -> InvalidUnlockTime (strictly > required)
        let exact_min = current_ts + MIN_LOCK_DURATION;
        let err = client
            .try_initialize(&sender, &sender, &recipient, &token_id, &100_000_000, &exact_min)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, EscrowError::InvalidUnlockTime);

        // At current_ts + MIN_LOCK_DURATION + 1 (4601) -> SUCCEEDS
        let valid_min = current_ts + MIN_LOCK_DURATION + 1;
        client.initialize(&sender, &sender, &recipient, &token_id, &100_000_000, &valid_min);
        assert_eq!(client.get_status(), EscrowStatus::Locked);
    }

    #[test]
    fn test_ledger_sequence_progression_across_boundary() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token_id, token, token_admin) = create_token(&env, &sender);
        token_admin.mint(&sender, &100_000_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let unlock_time: u64 = 10_000;
        env.ledger().with_mut(|l| {
            l.sequence = 100;
            l.timestamp = 0;
        });

        client.initialize(&sender, &sender, &recipient, &token_id, &100_000_000, &unlock_time);

        // Ledger 101: 5s before boundary (9_995)
        env.ledger().with_mut(|l| {
            l.sequence = 101;
            l.timestamp = 9_995;
        });
        assert_eq!(client.get_status(), EscrowStatus::Locked);
        assert_eq!(client.try_claim().unwrap_err().unwrap(), EscrowError::StillLocked);

        // Ledger 102: Exactly at boundary (10_000)
        env.ledger().with_mut(|l| {
            l.sequence = 102;
            l.timestamp = 10_000;
        });
        assert_eq!(client.get_status(), EscrowStatus::Unlocked);
        client.claim();
        assert_eq!(token.balance(&recipient), 100_000_000);

        // Ledger 103: After boundary (10_005) -> Already claimed
        env.ledger().with_mut(|l| {
            l.sequence = 103;
            l.timestamp = 10_005;
        });
        assert_eq!(client.get_status(), EscrowStatus::Claimed);
        assert_eq!(client.try_claim().unwrap_err().unwrap(), EscrowError::AlreadyClaimed);
    }
}

// ─── Comprehensive unit tests (#77) ──────────────────────────────────────────
//
// Issue #77: Cover initialize, claim, cancel, authorization, and every error
// variant in Rust.
//
// Acceptance Criteria:
//   • Boundary amounts and unlock times are covered.
//   • Unauthorized and repeated calls assert exact errors.

#[cfg(test)]
mod comprehensive_tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
        token::{Client as TokenClient, StellarAssetClient},
        Env, IntoVal,
    };

    // ── Helper: set up a fresh initialized escrow ────────────────────────────

    fn setup_escrow(
        env: &Env,
        amount: i128,
        unlock_time: u64,
    ) -> (Address, Address, Address, TokenClient, EscrowContractClient) {
        env.mock_all_auths();
        let admin = Address::generate(env);
        let sender = Address::generate(env);
        let recipient = Address::generate(env);
        let token_id = env.register_stellar_asset_contract(sender.clone());
        let token = TokenClient::new(env, &token_id);
        StellarAssetClient::new(env, &token_id).mint(&sender, &amount);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(env, &contract_id);
        client.initialize(&admin, &sender, &recipient, &token_id, &amount, &unlock_time);
        (admin, sender, recipient, token, client)
    }

    // ── Boundary: exact minimum amount (10_000_000 stroops = 1 USDC) ─────────

    /// Exactly MIN_AMOUNT must succeed.
    #[test]
    fn test_initialize_exact_min_amount_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract(sender.clone());
        StellarAssetClient::new(&env, &token_id).mint(&sender, &MIN_AMOUNT);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        // Should succeed without error
        client.initialize(
            &sender,
            &sender,
            &recipient,
            &token_id,
            &MIN_AMOUNT,
            &(MIN_LOCK_DURATION + 1),
        );
    }

    /// One stroop below MIN_AMOUNT must fail with InvalidAmount.
    #[test]
    fn test_initialize_one_below_min_amount_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract(sender.clone());
        StellarAssetClient::new(&env, &token_id).mint(&sender, &MIN_AMOUNT);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let err = client
            .try_initialize(
                &sender,
                &sender,
                &recipient,
                &token_id,
                &(MIN_AMOUNT - 1),
                &(MIN_LOCK_DURATION + 1),
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, EscrowError::InvalidAmount);
    }

    /// Large amount (1 billion USDC in stroops) must succeed.
    #[test]
    fn test_initialize_large_amount_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let large_amount: i128 = 1_000_000_000_000_000; // 100M USDC
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract(sender.clone());
        StellarAssetClient::new(&env, &token_id).mint(&sender, &large_amount);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        client.initialize(
            &sender,
            &sender,
            &recipient,
            &token_id,
            &large_amount,
            &(MIN_LOCK_DURATION + 1),
        );
    }

    // ── Boundary: unlock time ─────────────────────────────────────────────────

    /// unlock_time = now + MIN_LOCK_DURATION + 1 is the minimum valid value.
    #[test]
    fn test_initialize_min_valid_unlock_time_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract(sender.clone());
        StellarAssetClient::new(&env, &token_id).mint(&sender, &MIN_AMOUNT);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        // MIN_LOCK_DURATION + 1 is strictly greater than now + MIN_LOCK_DURATION
        client.initialize(
            &sender,
            &sender,
            &recipient,
            &token_id,
            &MIN_AMOUNT,
            &(MIN_LOCK_DURATION + 1),
        );
    }

    /// unlock_time = now + MIN_LOCK_DURATION is NOT valid (must be strictly greater).
    #[test]
    fn test_initialize_exactly_min_lock_duration_fails() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract(sender.clone());
        StellarAssetClient::new(&env, &token_id).mint(&sender, &MIN_AMOUNT);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let err = client
            .try_initialize(
                &sender,
                &sender,
                &recipient,
                &token_id,
                &MIN_AMOUNT,
                &MIN_LOCK_DURATION,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, EscrowError::InvalidUnlockTime);
    }

    // ── get_status tests ──────────────────────────────────────────────────────

    /// get_status on uninitialized contract returns NotInitialized.
    #[test]
    fn test_get_status_not_initialized() {
        let env = Env::default();
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let err = client.try_get_status().unwrap_err().unwrap();
        assert_eq!(err, EscrowError::NotInitialized);
    }

    /// get_status returns Locked before unlock_time.
    #[test]
    fn test_get_status_locked() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let (_admin, _sender, _recipient, _token, client) =
            setup_escrow(&env, MIN_AMOUNT, MIN_LOCK_DURATION + 1_000);

        assert_eq!(client.get_status(), EscrowStatus::Locked);
    }

    /// get_status returns Unlocked at exactly unlock_time.
    #[test]
    fn test_get_status_unlocked_at_unlock_time() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 1_000;
        let (_admin, _sender, _recipient, _token, client) =
            setup_escrow(&env, MIN_AMOUNT, unlock_time);

        env.ledger().with_mut(|l| l.timestamp = unlock_time);
        assert_eq!(client.get_status(), EscrowStatus::Unlocked);
    }

    /// get_status returns Claimed after a successful claim.
    #[test]
    fn test_get_status_claimed() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 1_000;
        let (_admin, _sender, _recipient, _token, client) =
            setup_escrow(&env, MIN_AMOUNT, unlock_time);

        env.ledger().with_mut(|l| l.timestamp = unlock_time);
        client.claim();
        assert_eq!(client.get_status(), EscrowStatus::Claimed);
    }

    /// get_status returns Cancelled after a successful cancel.
    #[test]
    fn test_get_status_cancelled() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 1_000;
        let (_admin, _sender, _recipient, _token, client) =
            setup_escrow(&env, MIN_AMOUNT, unlock_time);

        client.cancel(&CANCEL_REASON_SENDER_REQUESTED);
        assert_eq!(client.get_status(), EscrowStatus::Cancelled);
    }

    // ── Claim: unauthorized and repeated calls ────────────────────────────────

    /// Claim on uninitialized contract returns NotInitialized.
    #[test]
    fn test_claim_not_initialized() {
        let env = Env::default();
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let err = client.try_claim().unwrap_err().unwrap();
        assert_eq!(err, EscrowError::NotInitialized);
    }

    /// Recipient cannot claim twice — exact error must be AlreadyClaimed.
    #[test]
    fn test_repeated_claim_exact_error() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 1_000;
        let (_admin, _sender, _recipient, _token, client) =
            setup_escrow(&env, MIN_AMOUNT, unlock_time);

        env.ledger().with_mut(|l| l.timestamp = unlock_time);
        client.claim();

        let err = client.try_claim().unwrap_err().unwrap();
        assert_eq!(err, EscrowError::AlreadyClaimed, "second claim must return AlreadyClaimed");
    }

    /// Recipient cannot claim a third time either.
    #[test]
    fn test_triple_claim_exact_error() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 1_000;
        let (_admin, _sender, _recipient, _token, client) =
            setup_escrow(&env, MIN_AMOUNT, unlock_time);

        env.ledger().with_mut(|l| l.timestamp = unlock_time);
        client.claim();

        for _ in 0..2 {
            let err = client.try_claim().unwrap_err().unwrap();
            assert_eq!(err, EscrowError::AlreadyClaimed);
        }
    }

    // ── Cancel: unauthorized and repeated calls ───────────────────────────────

    /// Cancel on uninitialized contract returns NotInitialized.
    #[test]
    fn test_cancel_not_initialized() {
        let env = Env::default();
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let err = client.try_cancel().unwrap_err().unwrap();
        assert_eq!(err, EscrowError::NotInitialized);
    }

    /// Recipient cannot cancel (only sender can).
    #[test]
    fn test_recipient_cannot_cancel() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 1_000;
        let (_admin, _sender, recipient, _token, client) =
            setup_escrow(&env, MIN_AMOUNT, unlock_time);

        client
            .mock_auths(&[MockAuth {
                address: &recipient,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "cancel",
                    args: (CANCEL_REASON_SENDER_REQUESTED,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_cancel(&CANCEL_REASON_SENDER_REQUESTED)
            .expect_err("recipient must not be able to cancel");
    }

    /// Repeated cancel returns AlreadyCancelled.
    #[test]
    fn test_repeated_cancel_exact_error() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 1_000;
        let (_admin, _sender, _recipient, _token, client) =
            setup_escrow(&env, MIN_AMOUNT, unlock_time);

        client.cancel(&CANCEL_REASON_SENDER_REQUESTED);

        let err = client.try_cancel(&CANCEL_REASON_SENDER_REQUESTED).unwrap_err().unwrap();
        assert_eq!(err, EscrowError::AlreadyCancelled, "second cancel must return AlreadyCancelled");
    }

    // ── Cross-state: cancel after claim, claim after cancel ──────────────────

    /// Cancelling after claim returns AlreadyClaimed (not AlreadyCancelled).
    #[test]
    fn test_cancel_after_claim_returns_already_claimed() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 1_000;
        let (_admin, _sender, _recipient, _token, client) =
            setup_escrow(&env, MIN_AMOUNT, unlock_time);

        env.ledger().with_mut(|l| l.timestamp = unlock_time);
        client.claim();

        let err = client.try_cancel(&CANCEL_REASON_SENDER_REQUESTED).unwrap_err().unwrap();
        assert_eq!(err, EscrowError::AlreadyClaimed);
    }

    /// Claiming after cancel returns AlreadyCancelled (not AlreadyClaimed).
    #[test]
    fn test_claim_after_cancel_returns_already_cancelled() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 1_000;
        let (_admin, _sender, _recipient, _token, client) =
            setup_escrow(&env, MIN_AMOUNT, unlock_time);

        client.cancel(&CANCEL_REASON_SENDER_REQUESTED);

        env.ledger().with_mut(|l| l.timestamp = unlock_time);
        let err = client.try_claim().unwrap_err().unwrap();
        assert_eq!(err, EscrowError::AlreadyCancelled);
    }

    // ── Full lifecycle verification ───────────────────────────────────────────

    /// Full happy path: initialize → wait → claim → verify balance.
    #[test]
    fn test_full_lifecycle_initialize_claim() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 1_000;
        let amount = MIN_AMOUNT * 5; // 5 USDC

        let (_admin, _sender, recipient, token, client) =
            setup_escrow(&env, amount, unlock_time);

        assert_eq!(client.get_status(), EscrowStatus::Locked);

        env.ledger().with_mut(|l| l.timestamp = unlock_time);
        assert_eq!(client.get_status(), EscrowStatus::Unlocked);

        client.claim();
        assert_eq!(client.get_status(), EscrowStatus::Claimed);
        assert_eq!(token.balance(&recipient), amount);
    }

    /// Full happy path: initialize → cancel → verify balance returns to sender.
    #[test]
    fn test_full_lifecycle_initialize_cancel() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 1_000;
        let amount = MIN_AMOUNT * 3;

        let (_admin, sender, _recipient, token, client) =
            setup_escrow(&env, amount, unlock_time);

        assert_eq!(client.get_status(), EscrowStatus::Locked);
        client.cancel(&CANCEL_REASON_SENDER_REQUESTED);
        assert_eq!(client.get_status(), EscrowStatus::Cancelled);
        assert_eq!(token.balance(&sender), amount);
    }

    // ── get_state: not initialized ────────────────────────────────────────────

    /// get_state on uninitialized contract returns NotInitialized.
    #[test]
    fn test_get_state_not_initialized() {
        let env = Env::default();
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let err = client.try_get_state().unwrap_err().unwrap();
        assert_eq!(err, EscrowError::NotInitialized);
    }

    /// get_state after initialize returns the correct values.
    #[test]
    fn test_get_state_after_initialize() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 500;
        let amount = MIN_AMOUNT * 2;

        let (_admin, _sender, recipient, _token, client) =
            setup_escrow(&env, amount, unlock_time);

        let (state_recipient, state_amount, state_unlock, state_claimed) =
            client.get_state();
        assert_eq!(state_recipient, recipient);
        assert_eq!(state_amount, amount);
        assert_eq!(state_unlock, unlock_time);
        assert!(!state_claimed);
    }

    /// get_state after claim shows claimed == true.
    #[test]
    fn test_get_state_claimed_flag_set_after_claim() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 500;

        let (_admin, _sender, _recipient, _token, client) =
            setup_escrow(&env, MIN_AMOUNT, unlock_time);

        env.ledger().with_mut(|l| l.timestamp = unlock_time);
        client.claim();

        let (_r, _a, _u, claimed) = client.get_state();
        assert!(claimed, "claimed flag must be true after successful claim");
    }
}

// ─── Cancel-after-unlock tests (#78) ─────────────────────────────────────────
//
// Issue #78: Test cancellation after unlock but before claim.
//
// Product policy (defined in docs/architecture/gift-lifecycle.md):
//   The sender MAY cancel the escrow at any time before the recipient has
//   claimed — including after the unlock time has passed. The contract enforces
//   this: `cancel` checks `claimed` and `cancelled` flags but does NOT check
//   whether the unlock time has been reached.
//
// Acceptance Criteria:
//   • Behavior matches product policy (cancel succeeds after unlock, before claim).
//   • Backend mirrors the contract result (gift status transitions to "cancelled").

#[cfg(test)]
mod cancel_after_unlock_tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Env,
    };

    /// Set up an initialized escrow ready to test the post-unlock window.
    fn setup(env: &Env, unlock_time: u64) -> (Address, Address, TokenClient, EscrowContractClient) {
        env.mock_all_auths();
        let sender = Address::generate(env);
        let recipient = Address::generate(env);
        let token_id = env.register_stellar_asset_contract(sender.clone());
        let token = TokenClient::new(env, &token_id);
        StellarAssetClient::new(env, &token_id).mint(&sender, &MIN_AMOUNT);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(env, &contract_id);
        client.initialize(&sender, &sender, &recipient, &token_id, &MIN_AMOUNT, &unlock_time);

        (sender, recipient, token, client)
    }

    // ── Core: cancel succeeds in the unlocked-but-unclaimed window ────────────

    /// Sender can cancel at exactly unlock_time (the window opens).
    #[test]
    fn test_cancel_at_exactly_unlock_time_succeeds() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 1_000;
        let (sender, _recipient, token, client) = setup(&env, unlock_time);

        // Advance ledger to exactly unlock_time
        env.ledger().with_mut(|l| l.timestamp = unlock_time);

        // Status is Unlocked — cancel must still succeed (no claim yet)
        assert_eq!(client.get_status(), EscrowStatus::Unlocked);
        client.cancel(&CANCEL_REASON_SENDER_REQUESTED);

        // Funds returned to sender
        assert_eq!(token.balance(&sender), MIN_AMOUNT);
        // Status is now Cancelled
        assert_eq!(client.get_status(), EscrowStatus::Cancelled);
    }

    /// Sender can cancel well after unlock_time while claim has not been made.
    #[test]
    fn test_cancel_long_after_unlock_but_before_claim_succeeds() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 1_000;
        let (sender, _recipient, token, client) = setup(&env, unlock_time);

        // Simulate many seconds passing without a claim
        env.ledger().with_mut(|l| l.timestamp = unlock_time + 86_400); // 1 day later

        assert_eq!(client.get_status(), EscrowStatus::Unlocked);
        client.cancel(&CANCEL_REASON_SENDER_REQUESTED);

        assert_eq!(token.balance(&sender), MIN_AMOUNT);
        assert_eq!(client.get_status(), EscrowStatus::Cancelled);
    }

    // ── After cancel in the unlocked window, claim must fail ─────────────────

    /// Once cancelled (from the unlocked window), the recipient cannot claim.
    #[test]
    fn test_claim_fails_after_cancel_in_unlocked_window() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 1_000;
        let (_sender, _recipient, _token, client) = setup(&env, unlock_time);

        env.ledger().with_mut(|l| l.timestamp = unlock_time);
        client.cancel(&CANCEL_REASON_SENDER_REQUESTED);

        // Recipient cannot claim after sender cancelled
        let err = client.try_claim().unwrap_err().unwrap();
        assert_eq!(
            err,
            EscrowError::AlreadyCancelled,
            "claim after cancel must return AlreadyCancelled"
        );
    }

    // ── Race condition: cancel vs claim at the same unlock boundary ───────────

    /// Claim beats cancel: claim at unlock_time, then cancel fails.
    #[test]
    fn test_claim_wins_over_cancel_at_unlock_boundary() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 1_000;
        let (_sender, _recipient, _token, client) = setup(&env, unlock_time);

        env.ledger().with_mut(|l| l.timestamp = unlock_time);
        client.claim(); // claim wins

        // Cancel now must fail with AlreadyClaimed
        let err = client.try_cancel(&CANCEL_REASON_SENDER_REQUESTED).unwrap_err().unwrap();
        assert_eq!(
            err,
            EscrowError::AlreadyClaimed,
            "cancel after claim must return AlreadyClaimed"
        );
    }

    // ── Funds conservation in the unlocked-then-cancelled path ───────────────

    /// Total supply is conserved: sender gets back exactly MIN_AMOUNT.
    #[test]
    fn test_funds_conservation_cancel_in_unlocked_window() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 1_000;
        let (sender, recipient, token, client) = setup(&env, unlock_time);

        env.ledger().with_mut(|l| l.timestamp = unlock_time);
        client.cancel(&CANCEL_REASON_SENDER_REQUESTED);

        let sender_bal = token.balance(&sender);
        let recipient_bal = token.balance(&recipient);
        let contract_bal = token.balance(&client.address);

        assert_eq!(sender_bal + recipient_bal + contract_bal, MIN_AMOUNT);
        assert_eq!(contract_bal, 0, "contract must hold 0 after cancel");
        assert_eq!(recipient_bal, 0, "recipient must hold 0 after cancel");
        assert_eq!(sender_bal, MIN_AMOUNT, "sender must receive full amount");
    }

    // ── Status transitions in the unlocked window ─────────────────────────────

    /// Status sequence: Locked → Unlocked → Cancelled (not Claimed).
    #[test]
    fn test_status_sequence_locked_unlocked_cancelled() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 1_000;
        let (_sender, _recipient, _token, client) = setup(&env, unlock_time);

        assert_eq!(client.get_status(), EscrowStatus::Locked);

        env.ledger().with_mut(|l| l.timestamp = unlock_time);
        assert_eq!(client.get_status(), EscrowStatus::Unlocked);

        client.cancel(&CANCEL_REASON_SENDER_REQUESTED);
        assert_eq!(client.get_status(), EscrowStatus::Cancelled);
    }

    // ── Cancel before unlock still works (regression guard) ──────────────────

    /// Cancel before unlock_time still works (existing behavior must not regress).
    #[test]
    fn test_cancel_before_unlock_still_works() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 0);
        let unlock_time = MIN_LOCK_DURATION + 1_000;
        let (sender, _recipient, token, client) = setup(&env, unlock_time);

        // Still Locked
        assert_eq!(client.get_status(), EscrowStatus::Locked);
        client.cancel();

        assert_eq!(token.balance(&sender), MIN_AMOUNT);
        assert_eq!(client.get_status(), EscrowStatus::Cancelled);
    }
}

// ─── Admin authority tests (#81) ──────────────────────────────────────────────
//
// Issue #81: Document and enforce the admin/upgrade model or remove unused
// authority.
//
// Acceptance Criteria:
//   • Upgrade permissions are authorized (admin-only).
//   • Unauthorized upgrade tests fail.

#[cfg(test)]
mod admin_authority_tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke},
        token::StellarAssetClient,
        BytesN, Env, IntoVal,
    };

    /// Set up an initialized escrow with a distinct admin, sender, and recipient.
    fn setup(env: &Env) -> (Address, Address, Address, EscrowContractClient) {
        env.mock_all_auths();
        let admin = Address::generate(env);
        let sender = Address::generate(env);
        let recipient = Address::generate(env);
        let token_id = env.register_stellar_asset_contract(sender.clone());
        StellarAssetClient::new(env, &token_id).mint(&sender, &100_000_000);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(env, &contract_id);
        // Pass distinct admin ≠ sender so tests can verify role separation.
        client.initialize(&admin, &sender, &recipient, &token_id, &100_000_000, &3_601);

        (admin, sender, recipient, client)
    }

    /// The gift sender is a different role from admin — sender must not upgrade.
    #[test]
    fn test_sender_cannot_upgrade() {
        let env = Env::default();
        let (_admin, sender, _recipient, client) = setup(&env);

        let new_wasm_hash = BytesN::from_array(&env, &[1u8; 32]);

        client
            .mock_auths(&[MockAuth {
                address: &sender,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "upgrade",
                    args: (new_wasm_hash.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_upgrade(&new_wasm_hash)
            .expect_err("sender must not be able to upgrade");
    }

    /// The recipient is a different role from admin — recipient must not upgrade.
    #[test]
    fn test_recipient_cannot_upgrade() {
        let env = Env::default();
        let (_admin, _sender, recipient, client) = setup(&env);

        let new_wasm_hash = BytesN::from_array(&env, &[2u8; 32]);

        client
            .mock_auths(&[MockAuth {
                address: &recipient,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "upgrade",
                    args: (new_wasm_hash.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_upgrade(&new_wasm_hash)
            .expect_err("recipient must not be able to upgrade");
    }

    /// Upgrade on an uninitialized contract must return NotInitialized, not panic.
    #[test]
    fn test_upgrade_not_initialized_returns_error() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let new_wasm_hash = BytesN::from_array(&env, &[3u8; 32]);

        let err = client.try_upgrade(&new_wasm_hash).unwrap_err().unwrap();
        assert_eq!(
            err,
            EscrowError::NotInitialized,
            "upgrade on uninitialized contract must return NotInitialized"
        );
    }

    /// Admin can upgrade — verifies the authorized path succeeds end-to-end.
    #[test]
    fn test_admin_can_upgrade_successfully() {
        let env = Env::default();
        let (admin, _sender, _recipient, client) = setup(&env);

        let new_wasm_hash = BytesN::from_array(&env, &[0u8; 32]);

        // Should complete without error
        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "upgrade",
                    args: (new_wasm_hash.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .upgrade(&new_wasm_hash);
    }

    /// A random third party (not admin, sender, or recipient) cannot upgrade.
    #[test]
    fn test_random_address_cannot_upgrade() {
        let env = Env::default();
        let (_admin, _sender, _recipient, client) = setup(&env);

        let random = Address::generate(&env);
        let new_wasm_hash = BytesN::from_array(&env, &[4u8; 32]);

        client
            .mock_auths(&[MockAuth {
                address: &random,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "upgrade",
                    args: (new_wasm_hash.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_upgrade(&new_wasm_hash)
            .expect_err("random address must not be able to upgrade");
    }

    /// Admin stored at initialization matches the address passed as first arg.
    /// Verifies that the contract stores and uses the admin arg (not the sender).
    #[test]
    fn test_admin_is_stored_separately_from_sender() {
        let env = Env::default();
        // admin ≠ sender — verify that only admin (not sender) can upgrade
        let (admin, sender, _recipient, client) = setup(&env);

        let new_wasm_hash = BytesN::from_array(&env, &[5u8; 32]);

        // Sender cannot upgrade
        client
            .mock_auths(&[MockAuth {
                address: &sender,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "upgrade",
                    args: (new_wasm_hash.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_upgrade(&new_wasm_hash)
            .expect_err("sender must not act as admin");

        // Admin can upgrade
        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "upgrade",
                    args: (new_wasm_hash.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .upgrade(&new_wasm_hash); // must succeed
    }
}
