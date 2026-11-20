//! Benchmark tests for the Lumigift escrow contract.
//!
//! Measures Soroban CPU instructions and memory for every state-changing
//! entry point: `initialize` (the deposit into escrow), `claim` and `cancel`.
//!
//! Run with:
//!   cargo bench --manifest-path contracts/escrow/Cargo.toml
//!
//! Before the Criterion timing run, each entry point is measured once with the
//! deterministic Soroban budget tracker and compared to the baseline table in
//! `BENCHMARKS.md`. The run fails if any metric regresses by more than
//! `REGRESSION_TOLERANCE_PCT` (issue #356). A Markdown report is written to
//! `target/escrow-bench-report.md` for CI to post on the PR.

use criterion::{criterion_group, Criterion};
use lumigift_escrow::{EscrowContract, EscrowContractClient, USDC_TESTNET};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    Address, Env,
};

const REGRESSION_TOLERANCE_PCT: u64 = 10;
const BASELINE_MD: &str = include_str!("../BENCHMARKS.md");
const AMOUNT: i128 = 100_000_000;
const UNLOCK_TIME: u64 = 3_601;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Minimal balance-tracking token registered at the allow-listed USDC testnet
/// address (the escrow rejects any other token).
#[contract]
struct MockUsdc;

#[contractimpl]
impl MockUsdc {
    pub fn mint(env: Env, to: Address, amount: i128) {
        let balance: i128 = env.storage().persistent().get(&to).unwrap_or(0);
        env.storage().persistent().set(&to, &(balance + amount));
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let from_balance: i128 = env.storage().persistent().get(&from).unwrap_or(0);
        assert!(from_balance >= amount, "insufficient balance");
        env.storage()
            .persistent()
            .set(&from, &(from_balance - amount));
        Self::mint(env, to, amount);
    }
}

struct Fixture {
    env: Env,
    admin: Address,
    sender: Address,
    recipient: Address,
    token_id: Address,
    contract_id: Address,
}

impl Fixture {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_id = Address::from_str(&env, USDC_TESTNET);
        env.register_at(&token_id, MockUsdc, ());
        MockUsdcClient::new(&env, &token_id).mint(&sender, &AMOUNT);
        let contract_id = env.register(EscrowContract, ());
        Fixture {
            env,
            admin,
            sender,
            recipient,
            token_id,
            contract_id,
        }
    }

    fn client(&self) -> EscrowContractClient<'_> {
        EscrowContractClient::new(&self.env, &self.contract_id)
    }

    fn initialize(&self) {
        self.client().initialize(
            &self.admin,
            &self.sender,
            &self.recipient,
            &self.token_id,
            &AMOUNT,
            &UNLOCK_TIME,
            &None,
        );
    }

    fn initialized() -> Self {
        let f = Self::new();
        f.initialize();
        f
    }

    /// Resets the budget tracker, runs `op`, and returns (cpu, memory).
    fn measure(&self, op: impl FnOnce(&Self)) -> (u64, u64) {
        self.env.cost_estimate().budget().reset_tracker();
        op(self);
        let budget = self.env.cost_estimate().budget();
        (budget.cpu_instruction_cost(), budget.memory_bytes_cost())
    }
}

fn op_initialize(f: &Fixture) {
    f.initialize();
}

fn op_claim(f: &Fixture) {
    f.env.ledger().with_mut(|l| l.timestamp = UNLOCK_TIME);
    f.client().claim();
}

fn op_cancel(f: &Fixture) {
    f.client().cancel();
}

fn op_extend_ttl(f: &Fixture) {
    f.client().extend_ttl();
}

/// (name, needs prior initialize, operation)
const OPERATIONS: [(&str, bool, fn(&Fixture)); 4] = [
    ("initialize", false, op_initialize),
    ("claim", true, op_claim),
    ("cancel", true, op_cancel),
    ("extend_ttl", true, op_extend_ttl),
];

fn fixture_for(needs_init: bool) -> Fixture {
    if needs_init {
        Fixture::initialized()
    } else {
        Fixture::new()
    }
}

// ─── Baseline regression check ────────────────────────────────────────────────

/// Parses `| \`op\` | cpu | mem |` rows between the baseline markers in BENCHMARKS.md.
fn baseline(op: &str) -> Option<(u64, u64)> {
    let section = BASELINE_MD
        .split("<!-- baseline:start -->")
        .nth(1)?
        .split("<!-- baseline:end -->")
        .next()?;
    section.lines().find_map(|line| {
        let cells: Vec<&str> = line.split('|').map(str::trim).collect();
        if cells.len() < 4 || cells[1] != format!("`{op}`") {
            return None;
        }
        let num = |s: &str| s.replace([' ', '_', ','], "").parse::<u64>().ok();
        Some((num(cells[2])?, num(cells[3])?))
    })
}

fn delta_pct(current: u64, base: u64) -> f64 {
    (current as f64 - base as f64) * 100.0 / base as f64
}

fn regression_check() {
    let mut report = String::from(
        "### Escrow contract benchmarks\n\n\
         | Operation | CPU instructions | Δ CPU | Memory bytes | Δ Memory | Status |\n\
         | --------- | ---------------- | ----- | ------------ | -------- | ------ |\n",
    );
    let mut failures = Vec::new();

    for (name, needs_init, op) in OPERATIONS {
        let (cpu, mem) = fixture_for(needs_init).measure(op);
        let (status, d_cpu, d_mem) = match baseline(name) {
            Some((base_cpu, base_mem)) => {
                let limit = |base: u64| base + base * REGRESSION_TOLERANCE_PCT / 100;
                let ok = cpu <= limit(base_cpu) && mem <= limit(base_mem);
                if !ok {
                    failures.push(format!(
                        "{name}: cpu {cpu} (baseline {base_cpu}), memory {mem} (baseline {base_mem})"
                    ));
                }
                (
                    if ok { "✅" } else { "❌ regressed" },
                    format!("{:+.1}%", delta_pct(cpu, base_cpu)),
                    format!("{:+.1}%", delta_pct(mem, base_mem)),
                )
            }
            None => ("⚠️ no baseline", "n/a".into(), "n/a".into()),
        };
        println!("{name}: cpu={cpu} memory={mem} {status}");
        report.push_str(&format!(
            "| `{name}` | {cpu} | {d_cpu} | {mem} | {d_mem} | {status} |\n"
        ));
    }

    report.push_str(&format!(
        "\nFails when any metric exceeds the `BENCHMARKS.md` baseline by more than {REGRESSION_TOLERANCE_PCT}%.\n"
    ));
    let out = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../target/escrow-bench-report.md"
    );
    std::fs::write(out, &report).expect("write bench report");

    assert!(
        failures.is_empty(),
        "benchmark regression > {REGRESSION_TOLERANCE_PCT}%:\n{}",
        failures.join("\n")
    );
}

// ─── Criterion timing ─────────────────────────────────────────────────────────

fn bench_operations(c: &mut Criterion) {
    for (name, needs_init, op) in OPERATIONS {
        c.bench_function(name, |b| {
            b.iter_batched(
                || fixture_for(needs_init),
                |f| op(&f),
                criterion::BatchSize::SmallInput,
            );
        });
    }
}

criterion_group!(benches, bench_operations);

fn main() {
    regression_check();
    benches();
    Criterion::default().configure_from_args().final_summary();
}
