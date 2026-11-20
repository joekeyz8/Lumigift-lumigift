# Escrow Contract Fuzz Testing Report

## Overview

This document describes the fuzz testing setup for the escrow contract, the coverage it provides, the CI schedule, and the panics discovered during fuzzing along with the fixes and regression tests added for each.

## Fuzz Target

The fuzz target lives in `contracts/escrow/fuzz/` and is built with [`cargo-fuzz`](https://github.com/rust-fuzz/cargo-fuzz).

- **Target name:** `escrow_state_transitions`
- **Entry point:** `contracts/escrow/fuzz/fuzz_targets/escrow_state_transitions.rs`
- **Corpus:** `contracts/escrow/fuzz/corpus/escrow_state_transitions/`
- **Artifacts (crashes):** `contracts/escrow/fuzz/artifacts/escrow_state_transitions/`

### What the fuzzer does

The fuzzer drives the escrow contract through arbitrary sequences of state transitions. Each fuzz input is interpreted as a sequence of operations, where each operation is one of:

- `initialize` (with arbitrary buyer, seller, arbiter addresses and amount)
- `fund` (with arbitrary amount)
- `release` (with arbitrary caller)
- `refund` (with arbitrary caller)
- `dispute` (with arbitrary caller)
- `resolve` (with arbitrary caller and resolution)

Arbitrary `u64`/`i128` values are used for amounts and timestamps, and arbitrary 32-byte arrays are used for addresses. The fuzzer asserts that the contract never panics unexpectedly — i.e., any panic must be a deliberate, documented contract error (e.g., `EscrowError::AlreadyInitialized`), not an unwrap/overflow/index-out-of-bounds panic.

### Running locally

```bash
cd contracts/escrow
cargo +nightly fuzz run escrow_state_transitions -- -max_total_time=3600
```

## Coverage

The fuzzer exercises:

- **Amounts:** zero, negative (where signed), `i128::MAX`, `i128::MIN`, and arbitrary values, including amounts that would overflow on accumulation.
- **Timestamps:** zero, `u64::MAX`, and arbitrary values, including deadlines in the past and future.
- **Addresses:** arbitrary 32-byte arrays, including the zero address and duplicate addresses (buyer == seller, etc.).
- **Transition ordering:** out-of-order transitions (e.g., `release` before `fund`), repeated transitions (double `fund`, double `release`), and transitions from terminal states.
- **Authorization:** callers that are not the expected party for each transition.

## CI Schedule

Fuzzing runs on a **weekly schedule** in CI via the workflow at `.github/workflows/escrow-fuzz.yml`.

- **Schedule:** `cron: '0 2 * * 0'` (every Sunday at 02:00 UTC)
- **Duration:** minimum **24 hours** per run (`-max_total_time=86400`)
- **Artifacts:** any crash artifacts are uploaded and the job fails if a crash is found.

## Panics Discovered and Fixes

The following panics were discovered during fuzzing. Each has been fixed and a regression test added.

### 1. Integer overflow on amount accumulation

- **Input:** repeated `fund` calls with amounts near `i128::MAX`.
- **Panic:** `attempt to add with overflow` when summing funded amounts.
- **Fix:** use checked arithmetic (`checked_add`) and return `EscrowError::AmountOverflow` on overflow.
- **Regression test:** `test_fund_overflow_returns_error` in `contracts/escrow/src/test.rs`.

### 2. Subtraction underflow on refund after partial release

- **Input:** `release` followed by `refund` with a remaining balance computed via unchecked subtraction.
- **Panic:** `attempt to subtract with overflow`.
- **Fix:** use `checked_sub` and guard against refunding more than the remaining balance, returning `EscrowError::InsufficientFunds`.
- **Regression test:** `test_refund_after_release_no_underflow` in `contracts/escrow/src/test.rs`.

### 3. Panic on uninitialized state access

- **Input:** `release`/`refund`/`dispute` before `initialize`.
- **Panic:** `unwrap()` on `None` when reading contract state.
- **Fix:** replace `unwrap()` with explicit `ok_or(EscrowError::NotInitialized)` handling.
- **Regression test:** `test_transition_before_initialize_returns_error` in `contracts/escrow/src/test.rs`.

### 4. Panic on duplicate initialization

- **Input:** two consecutive `initialize` calls.
- **Panic:** `unwrap()` on already-set storage.
- **Fix:** check for existing state and return `EscrowError::AlreadyInitialized`.
- **Regression test:** `test_double_initialize_returns_error` in `contracts/escrow/src/test.rs`.

### 5. Panic on timestamp comparison with `u64::MAX`

- **Input:** deadline set to `u64::MAX` and a refund attempted at the boundary.
- **Panic:** overflow in `deadline + grace_period`.
- **Fix:** use `saturating_add` for deadline arithmetic.
- **Regression test:** `test_deadline_max_no_overflow` in `contracts/escrow/src/test.rs`.

### 6. Panic on unauthorized caller in `resolve`

- **Input:** `resolve` called by a non-arbiter address.
- **Panic:** `assert!` on caller identity.
- **Fix:** return `EscrowError::Unauthorized` instead of panicking.
- **Regression test:** `test_resolve_unauthorized_returns_error` in `contracts/escrow/src/test.rs`.

## Summary

| # | Panic | Fix | Regression test |
|---|-------|-----|-----------------|
| 1 | Add overflow on fund | `checked_add` → `AmountOverflow` | `test_fund_overflow_returns_error` |
| 2 | Sub underflow on refund | `checked_sub` → `InsufficientFunds` | `test_refund_after_release_no_underflow` |
| 3 | Unwrap on uninitialized | `ok_or(NotInitialized)` | `test_transition_before_initialize_returns_error` |
| 4 | Unwrap on double init | `AlreadyInitialized` | `test_double_initialize_returns_error` |
| 5 | Deadline add overflow | `saturating_add` | `test_deadline_max_no_overflow` |
| 6 | Assert on unauthorized resolve | `Unauthorized` error | `test_resolve_unauthorized_returns_error` |

All discovered panics have been resolved. The fuzzer now runs clean for the full 24-hour CI window without finding new panics.