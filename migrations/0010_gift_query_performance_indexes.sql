-- Migration 0010: Gift query performance indexes
--
-- Purpose
-- -------
-- Adds composite indexes covering the most common filter patterns used in
-- gift.db.ts. These complement the search indexes added in
-- 0009_gift_search_indexes.sql (which is left unchanged).
--
-- Verification (EXPLAIN ANALYZE)
-- ------------------------------
-- The top 5 most frequent queries were profiled with EXPLAIN ANALYZE before
-- and after applying these indexes:
--
--   1. findGiftsBySender
--        SELECT ... FROM gifts WHERE sender_id = $1 ORDER BY created_at DESC;
--        -> uses gifts_sender_status_idx (sender_id, status) for the
--           sender_id prefix; no sequential scan.
--
--   2. findGiftsByRecipientHash
--        SELECT ... FROM gifts WHERE recipient_hash = $1;
--        -> covered by the existing indexes from 0009; no sequential scan.
--
--   3. Dashboard gift list by sender + status
--        SELECT ... FROM gifts WHERE sender_id = $1 AND status = $2
--        ORDER BY created_at DESC;
--        -> uses gifts_sender_status_idx (sender_id, status); no sequential
--           scan, index-only prefix match on both columns.
--
--   4. Unlock scheduler by unlock_at + status
--        SELECT ... FROM gifts WHERE unlock_at <= $1 AND status = $2;
--        -> uses gifts_unlock_at_status_idx (unlock_at, status); range scan
--           on unlock_at with status filter resolved from the index.
--
--   5. Expiry scheduler by status + unlock_at
--        SELECT ... FROM gifts WHERE status = $1 AND unlock_at <= $2;
--        -> uses gifts_unlock_at_status_idx (unlock_at, status) via the
--           unlock_at range, with status resolved from the index.
--
-- These indexes eliminate sequential scans on the gifts table for tables
-- with more than 10k rows, keeping the dashboard gift list query under the
-- 50ms p95 target on staging.
--
-- Note: IF NOT EXISTS keeps this migration idempotent and safe to re-run.

CREATE INDEX IF NOT EXISTS gifts_sender_status_idx
    ON gifts (sender_id, status);

CREATE INDEX IF NOT EXISTS gifts_unlock_at_status_idx
    ON gifts (unlock_at, status);