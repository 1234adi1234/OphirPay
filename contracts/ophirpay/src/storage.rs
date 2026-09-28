#![allow(unused_imports)]
#![allow(dead_code)]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, String,
    Symbol, Vec,
};
const PAYMENT_COUNT: Symbol = symbol_short!("PAY_CNT");
const ESCROW_COUNT: Symbol = symbol_short!("ESC_CNT");
const STREAM_COUNT: Symbol = symbol_short!("STR_CNT");
const BATCH_COUNT: Symbol = symbol_short!("BAT_CNT");
const OWNER: Symbol = symbol_short!("OWNER");
const PAUSED: Symbol = symbol_short!("PAUSED");
const VERSION: Symbol = symbol_short!("VERSION");
const UPGRADE_HASH: Symbol = symbol_short!("UPG_HASH");
const UPGRADE_TIMELOCK: Symbol = symbol_short!("UPG_LOCK");
const MULTISIG_CONFIG: Symbol = symbol_short!("MULTI_CF");
const APPROVAL_COUNT: Symbol = symbol_short!("APPR_CNT");
const SPEND_LIMIT_KEY: Symbol = symbol_short!("SPNDLIM");
const ESCALATION_KEY: Symbol = symbol_short!("ESCLATN");
const ROLE_KEY: Symbol = symbol_short!("ROLE");
const AUDIT_CNT: Symbol = symbol_short!("AUDIT");

// ── Persistent record key namespaces ─────────────────────────────
// Each record type is stored under a (PREFIX, id) tuple key so that
// sequence numbers never collide across types (e.g. payment #1 vs
// audit #1 both writing plain u64 key 1, which silently overwrote
// each other).
const AUDIT_LOG_KEY: Symbol = symbol_short!("A_LOG");
const PAYMENT_KEY: Symbol = symbol_short!("P_REC");
const ESCROW_KEY: Symbol = symbol_short!("E_REC");
const STREAM_KEY: Symbol = symbol_short!("S_REC");
const RECURRING_KEY: Symbol = symbol_short!("R_REC");
const REFUND_KEY: Symbol = symbol_short!("RF_REC");
const TIMELOCK_KEY: Symbol = symbol_short!("T_REC");
const PROPOSAL_KEY: Symbol = symbol_short!("G_REC");
const APPROVAL_KEY: Symbol = symbol_short!("A_REQ");
const HOOK_KEY: Symbol = symbol_short!("H_REC");
const PENDING_REVOC_KEY: Symbol = symbol_short!("PR_REV");
const VOTE_KEY: Symbol = symbol_short!("V_REC");
const BATCH_KEY: Symbol = symbol_short!("B_REC");
const RECUR_CNT: Symbol = symbol_short!("REC_CNT");
const REFUND_CNT: Symbol = symbol_short!("REF_CNT");
const FEE_KEY: Symbol = symbol_short!("FEE_CONF");
const FEE_COLL: Symbol = symbol_short!("FEE_COLL");
const TMLOCK_CNT: Symbol = symbol_short!("TMLOCK");
const TMLOCK_DELAY: u64 = 86400; // 24 hours
const GOV_CNT: Symbol = symbol_short!("GOV_CNT");
const GOV_CONF: Symbol = symbol_short!("GOV_CONF");
const EMITTER_ADDR: Symbol = symbol_short!("EMITTER");
const HOOK_CNT: Symbol = symbol_short!("HOOK_CNT");
const FEE_VER_CNT: Symbol = symbol_short!("FE_VER");
const MSIG_VER_CNT: Symbol = symbol_short!("MS_VER");
const PENDING_OWNER: Symbol = symbol_short!("PND_OWN");
const OWNER_PROPOSED_AT: Symbol = symbol_short!("OWN_PAT");

// ── Per-counter storage keys (replaces ContractStats monolith) ─
// Gas-optimized: each counter is a single u64/i128 instance key.
// Reading one counter costs ~150 bytes; reading all 11 in a monolith cost ~2000+ bytes.
const STAT_PAYMENTS: Symbol = symbol_short!("S_PAY");
const STAT_ESC_CREATED: Symbol = symbol_short!("S_EC");
const STAT_ESC_RELEASED: Symbol = symbol_short!("S_ER");
const STAT_ESC_CLAIMED: Symbol = symbol_short!("S_ECL");
const STAT_STR_CREATED: Symbol = symbol_short!("S_SC");
const STAT_STR_CLAIMED: Symbol = symbol_short!("S_SCL");
const STAT_STR_CANCELLED: Symbol = symbol_short!("S_SX");
const STAT_BATCHES: Symbol = symbol_short!("S_BAT");
const STAT_AMT_ESCROWED: Symbol = symbol_short!("S_AE");
const STAT_AMT_STREAMED: Symbol = symbol_short!("S_AS");
const STAT_AMT_BATCHED: Symbol = symbol_short!("S_AB");

/// Running total of funds locked in active escrows + streams + proposal deposits.
/// Incremented on create_escrow / create_stream / create_proposal (deposit).
/// Decremented on release_escrow / claim_escrow / claim_stream / cancel_stream
/// / execute_proposal (deposit refund).
/// emergency_withdraw enforces: withdraw_amount <= contract_balance - LOCKED_BALANCE.
/// Prevents the owner from draining user-deposited funds (critical invariant).
const LOCKED_BALANCE: Symbol = symbol_short!("LOCKED");
const REENTRANCY_LOCK: Symbol = symbol_short!("RE_LOCK");
