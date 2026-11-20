# Escrow Contract Benchmarks

Soroban charges fees based on **CPU instructions** and **storage bytes**.
This document records measured costs and the regression thresholds enforced by CI.

## How to run

```bash
cargo bench --manifest-path contracts/escrow/Cargo.toml
```

---

## Methodology: Soroban CPU instruction units

Soroban meters execution in **CPU instructions** — a deterministic count of
host and Wasm operations charged by the Soroban host, independent of wall-clock
time or machine speed. Each benchmarked entry point is invoked once through the
Soroban test environment (`soroban_sdk::Env` with `testutils`), and the
`Env`'s budget tracker is **reset immediately before the call** so the reported
numbers cover only that single operation (no setup, no fixture construction).
The tracker is then queried for `cpu_instruction_count()` and
`memory_byte_count()`. Because the counts are deterministic, they can be
compared exactly across runs and used as a regression gate.

## Baseline (Soroban testutils budget tracker)

Deterministic CPU-instruction and memory counts for each state-changing entry
point, measured in isolation (budget tracker reset before the call).
`initialize` is the deposit — it transfers the gift amount into escrow.
`extend_ttl` bumps the escrow's persistent-entry TTL.

<!-- baseline:start -->

| Operation    | CPU instructions | Memory bytes |
| ------------ | ---------------- | ------------ |
| `initialize` | 156075           | 64103        |
| `claim`      | 177399           | 70918        |
| `cancel`     | 160986           | 66156        |
| `extend_ttl` | 41250            | 18432        |

<!-- baseline:end -->

> Values come from the Soroban test environment with a minimal mock USDC
> token. On-chain costs differ slightly (real SAC token, host overhead).
>
> The contract has no `set_paused` entry point, so there is nothing to
> benchmark for it; add a row here and an entry in `OPERATIONS` in
> `benches/escrow_bench.rs` if one is introduced.

---

## CI regression gate

The `Contract Resource Budget` job in `.github/workflows/ci.yml` runs
`cargo bench`. Before the Criterion timing run, the bench binary measures each
operation and compares it with the baseline table above (parsed between the
`baseline:start`/`baseline:end` markers):

- Any CPU or memory value more than **10%** above baseline fails the job
  (`measured > baseline * 1.10`).
- A Markdown report (`contracts/target/escrow-bench-report.md`) is posted to
  the PR as a single, updated-in-place comment.

When a change intentionally increases cost, update the baseline table in the
same PR so reviewers see the new numbers. A baseline bump without a
corresponding code change, or a code change that raises cost without a baseline
bump, is a review blocker.

---

## Estimated XLM fees (typical gift amounts)

Soroban fee approximation (Protocol 21):

```
fee_stroops ≈ cpu_instructions / 10_000
1 XLM = 10_000_000 stroops
```

| Operation    | CPU instructions | Fee (stroops) | Fee (XLM) | Fee (USD @ $0.12/XLM) |
| ------------ | ---------------- | ------------- | --------- | --------------------- |
| `initialize` | 156 075          | 16            | 0.0000016 | ~$0.00000019          |
| `claim`      | 177 399          | 18            | 0.0000018 | ~$0.00000022          |
| `cancel`     | 160 986          | 16            | 0.0000016 | ~$0.00000019          |
| `extend_ttl` | 41 250           | 4             | 0.0000004 | ~$0.00000005          |

For a typical gift of **10 USDC** (10 000 000 stroops), the on-chain fee of
any single operation is less than **0.001% of the gift value** — negligible for the end user.

> Note: The fee formula above covers compute only. Storage rent and base
> transaction fees add a small fixed overhead (~100 stroops per transaction).

---

## Boundary: `unlock_time` semantics

The contract uses strict less-than (`now < unlock_time`), so:

- `timestamp == unlock_time` → **claim succeeds** (boundary is inclusive for the recipient)
- `timestamp == unlock_time - 1` → **claim fails** with `StillLocked`

This is verified by the boundary tests in `src/lib.rs` (`boundary_tests` module).

---

## Property tests: time-lock arithmetic (issue #357)

The `time_lock_property_tests` module in `src/lib.rs` runs each property for
**10 000 cases** with `proptest`. The tests are prefixed `fuzz_`, so the
`contract-fuzz` CI job (`cargo test --locked fuzz_`) runs them on every PR.

| Property                                 | Inputs                                                       | Invariant                                                   |
| ---------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| `fuzz_past_or_near_unlock_time_rejected` | `now` ∈ {0, 3600, near-max, `u64::MAX`, random}              | `unlock_time ≤ now + 3600` → `InvalidUnlockTime`            |
| `fuzz_future_unlock_time_accepted`       | any `now`, `unlock_time` up to `u64::MAX`                    | `unlock_time > now + 3600` passes the time-lock check       |
| `fuzz_edge_amounts_respect_minimum`      | 0, 1, -1, `i128::MIN`, `MIN_AMOUNT ± 1`, `i128::MAX`, random | `amount < MIN_AMOUNT` → `InvalidAmount`; otherwise accepted |
| `fuzz_ttl_covers_lock_period`            | epoch 0 to `u64::MAX`                                        | TTL = buffer once unlocked, else ⌈Δ/5⌉ + buffer, no panic   |
| `fuzz_ttl_monotonic`                     | epoch 0 to `u64::MAX`                                        | TTL is non-decreasing in `unlock_time`                      |

The contract stores amounts as `i128`, so `i128::MAX` is the upper bound tested.
Ledger timestamps are UTC seconds, so DST transitions cannot affect the
comparison; the epoch-0 and `u64::MAX` cases cover the arithmetic boundaries.

**Finding:** `required_ttl_ledgers` rounded up with
`(secs + LEDGER_CLOSE_SECS - 1) / LEDGER_CLOSE_SECS`, which overflows (and
aborts, since `overflow-checks = true`) when `unlock_time - now > u64::MAX - 4`.
It now uses `u64::div_ceil`. No other regressions were found.
