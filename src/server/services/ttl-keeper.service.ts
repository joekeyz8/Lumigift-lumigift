import { serviceLogger } from '../lib/logger';
import { recordTtlAlert } from '../lib/metrics';
import { db } from '../db';
import { EscrowClient } from '../lib/escrow-client';

const log = serviceLogger('ttl-keeper');

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_SECONDS = 24 * 60 * 60;

// Thresholds (in seconds) used to decide when to extend / alert.
const EXTEND_THRESHOLD_SECONDS = 30 * DAY_SECONDS;
const ALERT_THRESHOLD_SECONDS = 7 * DAY_SECONDS;
const EXTEND_BUFFER_SECONDS = 30 * DAY_SECONDS;

// Stellar base fee / stroops conversion.
const STROOPS_PER_XLM = 10_000_000n;

interface GiftRow {
  id: string;
  contract_id: string;
  unlock_time: string | Date;
}

export interface TtlKeeperResult {
  extended: number;
  failed: number;
  alerts: number;
  totalFeeXlm: string;
}

/**
 * Convert a stroops amount (bigint or string) to an XLM decimal string.
 */
function stroopsToXlm(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_XLM;
  const fraction = abs % STROOPS_PER_XLM;
  const fractionStr = fraction.toString().padStart(7, '0').replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return fractionStr.length > 0 ? `${sign}${whole}.${fractionStr}` : `${sign}${whole}`;
}

/**
 * Add two XLM decimal strings and return the sum as a decimal string.
 */
function addXlm(a: string, b: string): string {
  const toStroops = (v: string): bigint => {
    const [whole, frac = ''] = v.split('.');
    const fracPadded = (frac + '0000000').slice(0, 7);
    return BigInt(whole || '0') * STROOPS_PER_XLM + BigInt(fracPadded || '0');
  };
  return stroopsToXlm(toStroops(a) + toStroops(b));
}

/**
 * Parse the minResourceFee returned from a simulation into stroops.
 */
function parseMinResourceFee(fee: unknown): bigint {
  if (fee === null || fee === undefined) return 0n;
  if (typeof fee === 'bigint') return fee;
  if (typeof fee === 'number') return BigInt(Math.trunc(fee));
  if (typeof fee === 'string') {
    try {
      return BigInt(fee);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

/**
 * Run the TTL keeper.
 *
 * Queries long-lived escrow gifts, reads the current TTL of each contract
 * instance, and extends it when it falls below the threshold. Emits alerts
 * when a contract TTL is dangerously low and tracks the total XLM fee spent.
 */
export async function runTtlKeeper(): Promise<TtlKeeperResult> {
  const result: TtlKeeperResult = {
    extended: 0,
    failed: 0,
    alerts: 0,
    totalFeeXlm: '0',
  };

  let gifts: GiftRow[];
  try {
    const query = `
      SELECT id, contract_id, unlock_time
      FROM gifts
      WHERE unlock_time > NOW() + INTERVAL '20 days'
        AND status IN ('locked', 'unlocked')
        AND contract_id IS NOT NULL
    `;
    const res = await db.query<GiftRow>(query);
    gifts = res.rows;
  } catch (err) {
    log.error('Failed to query gifts for TTL keeper', { error: err });
    result.failed += 1;
    return result;
  }

  log.info('TTL keeper run started', { giftCount: gifts.length });

  const now = Date.now();

  for (const gift of gifts) {
    try {
      const client = new EscrowClient(gift.contract_id);

      const currentTtl = await client.getContractInstanceTtl();

      // Alert if TTL is below the 7-day buffer.
      if (currentTtl < ALERT_THRESHOLD_SECONDS) {
        result.alerts += 1;
        recordTtlAlert({
          contractId: gift.contract_id,
          giftId: gift.id,
          currentTtlSeconds: currentTtl,
          thresholdSeconds: ALERT_THRESHOLD_SECONDS,
        });
        log.warn('Contract TTL below alert threshold', {
          giftId: gift.id,
          contractId: gift.contract_id,
          currentTtlSeconds: currentTtl,
          thresholdSeconds: ALERT_THRESHOLD_SECONDS,
        });
      }

      // Only extend when below the extend threshold.
      if (currentTtl >= EXTEND_THRESHOLD_SECONDS) {
        log.debug('Contract TTL healthy, no extension needed', {
          giftId: gift.id,
          contractId: gift.contract_id,
          currentTtlSeconds: currentTtl,
        });
        continue;
      }

      // Compute the new TTL: cover the remaining lock period + buffer.
      const unlockMs = new Date(gift.unlock_time).getTime();
      const remainingMs = Math.max(0, unlockMs - now);
      const remainingSeconds = Math.ceil(remainingMs / 1000);
      const newTtlSeconds = remainingSeconds + EXTEND_BUFFER_SECONDS;

      const extendResult = await client.extendTtl(newTtlSeconds);

      const feeStroops = parseMinResourceFee(extendResult?.minResourceFee);
      const feeXlm = stroopsToXlm(feeStroops);
      result.totalFeeXlm = addXlm(result.totalFeeXlm, feeXlm);

      result.extended += 1;
      log.info('Extended contract TTL', {
        giftId: gift.id,
        contractId: gift.contract_id,
        previousTtlSeconds: currentTtl,
        newTtlSeconds,
        feeXlm,
      });
    } catch (err) {
      result.failed += 1;
      log.error('Failed to extend contract TTL', {
        giftId: gift.id,
        contractId: gift.contract_id,
        error: err,
      });
    }
  }

  log.info('TTL keeper run completed', {
    extended: result.extended,
    failed: result.failed,
    alerts: result.alerts,
    totalFeeXlm: result.totalFeeXlm,
  });

  return result;
}