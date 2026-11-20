/**
 * @jest-environment node
 */

import { Pool } from 'pg';
import { NextRequest } from 'next/server';

// Route handlers under test
import { GET as unlockGET } from '../unlock/route';
import { GET as expireGET } from '../expire/route';
import { GET as reconcileGET } from '../reconcile/route';
import { GET as occasionRemindersGET } from '../occasion-reminders/route';
import { GET as indexEventsGET } from '../index-events/route';

// Seed helper
import { seedTestDb } from '../../../../../../scripts/seed-test-db';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const CRON_SECRET = 'test-cron-secret-value';

// Guard: these tests must run against a real test PostgreSQL instance.
if (!TEST_DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL must be set to run cron integration tests. ' +
      'These tests require a real test PostgreSQL instance.',
  );
}

let pool: Pool;

function authHeaders(secret: string = CRON_SECRET): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

function makeRequest(
  path: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'GET',
    headers,
  });
}

beforeAll(async () => {
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  pool = new Pool({ connectionString: TEST_DATABASE_URL });

  // Verify connectivity early so failures are clear.
  await pool.query('SELECT 1');
});

afterAll(async () => {
  if (pool) {
    await pool.end();
  }
});

beforeEach(async () => {
  // Reset and seed a known DB state before each test.
  await seedTestDb(pool);
});

describe('cron routes: authorization', () => {
  const routes: Array<[string, (req: NextRequest) => Promise<Response>]> = [
    ['/api/v1/cron/unlock', unlockGET],
    ['/api/v1/cron/expire', expireGET],
    ['/api/v1/cron/reconcile', reconcileGET],
    ['/api/v1/cron/occasion-reminders', occasionRemindersGET],
    ['/api/v1/cron/index-events', indexEventsGET],
  ];

  it.each(routes)(
    'rejects requests without an authorization header for %s',
    async (path, handler) => {
      const res = await handler(makeRequest(path));
      expect(res.status).toBe(401);
    },
  );

  it.each(routes)(
    'rejects requests with an invalid secret for %s',
    async (path, handler) => {
      const res = await handler(
        makeRequest(path, authHeaders('wrong-secret')),
      );
      expect(res.status).toBe(401);
    },
  );
});

describe('cron route: unlock', () => {
  it('unlocks funds that are past their unlock time', async () => {
    // Seed a locked position whose unlock time has passed.
    const { rows: before } = await pool.query(
      `INSERT INTO positions (user_id, amount, status, unlock_at)
       VALUES ($1, $2, 'locked', NOW() - INTERVAL '1 hour')
       RETURNING id, status`,
      ['user-unlock-1', '100.00000000'],
    );
    const positionId = before[0].id;
    expect(before[0].status).toBe('locked');

    const res = await unlockGET(
      makeRequest('/api/v1/cron/unlock', authHeaders()),
    );
    expect(res.status).toBe(200);

    const { rows: after } = await pool.query(
      `SELECT status FROM positions WHERE id = $1`,
      [positionId],
    );
    expect(after[0].status).toBe('unlocked');
  });

  it('does not unlock funds whose unlock time is in the future', async () => {
    const { rows: before } = await pool.query(
      `INSERT INTO positions (user_id, amount, status, unlock_at)
       VALUES ($1, $2, 'locked', NOW() + INTERVAL '1 hour')
       RETURNING id, status`,
      ['user-unlock-2', '50.00000000'],
    );
    const positionId = before[0].id;

    const res = await unlockGET(
      makeRequest('/api/v1/cron/unlock', authHeaders()),
    );
    expect(res.status).toBe(200);

    const { rows: after } = await pool.query(
      `SELECT status FROM positions WHERE id = $1`,
      [positionId],
    );
    expect(after[0].status).toBe('locked');
  });
});

describe('cron route: expire', () => {
  it('expires pending records past their expiry time', async () => {
    const { rows: before } = await pool.query(
      `INSERT INTO positions (user_id, amount, status, expires_at)
       VALUES ($1, $2, 'pending', NOW() - INTERVAL '1 hour')
       RETURNING id, status`,
      ['user-expire-1', '25.00000000'],
    );
    const positionId = before[0].id;
    expect(before[0].status).toBe('pending');

    const res = await expireGET(
      makeRequest('/api/v1/cron/expire', authHeaders()),
    );
    expect(res.status).toBe(200);

    const { rows: after } = await pool.query(
      `SELECT status FROM positions WHERE id = $1`,
      [positionId],
    );
    expect(after[0].status).toBe('expired');
  });

  it('leaves non-expired pending records untouched', async () => {
    const { rows: before } = await pool.query(
      `INSERT INTO positions (user_id, amount, status, expires_at)
       VALUES ($1, $2, 'pending', NOW() + INTERVAL '1 hour')
       RETURNING id, status`,
      ['user-expire-2', '75.00000000'],
    );
    const positionId = before[0].id;

    const res = await expireGET(
      makeRequest('/api/v1/cron/expire', authHeaders()),
    );
    expect(res.status).toBe(200);

    const { rows: after } = await pool.query(
      `SELECT status FROM positions WHERE id = $1`,
      [positionId],
    );
    expect(after[0].status).toBe('pending');
  });
});

describe('cron route: reconcile', () => {
  it('reconciles balances to match on-chain state', async () => {
    // Seed a balance that is out of sync with the recorded on-chain value.
    const { rows: before } = await pool.query(
      `INSERT INTO balances (user_id, asset, balance, on_chain_balance, reconciled)
       VALUES ($1, $2, $3, $4, false)
       RETURNING id, balance, on_chain_balance, reconciled`,
      ['user-reconcile-1', 'XLM', '100.00000000', '120.00000000'],
    );
    const balanceId = before[0].id;
    expect(before[0].reconciled).toBe(false);

    const res = await reconcileGET(
      makeRequest('/api/v1/cron/reconcile', authHeaders()),
    );
    expect(res.status).toBe(200);

    const { rows: after } = await pool.query(
      `SELECT balance, on_chain_balance, reconciled FROM balances WHERE id = $1`,
      [balanceId],
    );
    expect(after[0].reconciled).toBe(true);
    expect(after[0].balance).toBe(after[0].on_chain_balance);
  });
});

describe('cron route: occasion-reminders', () => {
  it('marks reminders as sent for occasions occurring today', async () => {
    const { rows: before } = await pool.query(
      `INSERT INTO occasions (user_id, name, occasion_date, reminder_sent)
       VALUES ($1, $2, CURRENT_DATE, false)
       RETURNING id, reminder_sent`,
      ['user-occasion-1', 'Birthday'],
    );
    const occasionId = before[0].id;
    expect(before[0].reminder_sent).toBe(false);

    const res = await occasionRemindersGET(
      makeRequest('/api/v1/cron/occasion-reminders', authHeaders()),
    );
    expect(res.status).toBe(200);

    const { rows: after } = await pool.query(
      `SELECT reminder_sent FROM occasions WHERE id = $1`,
      [occasionId],
    );
    expect(after[0].reminder_sent).toBe(true);
  });

  it('does not send reminders for future occasions', async () => {
    const { rows: before } = await pool.query(
      `INSERT INTO occasions (user_id, name, occasion_date, reminder_sent)
       VALUES ($1, $2, CURRENT_DATE + INTERVAL '30 days', false)
       RETURNING id, reminder_sent`,
      ['user-occasion-2', 'Anniversary'],
    );
    const occasionId = before[0].id;

    const res = await occasionRemindersGET(
      makeRequest('/api/v1/cron/occasion-reminders', authHeaders()),
    );
    expect(res.status).toBe(200);

    const { rows: after } = await pool.query(
      `SELECT reminder_sent FROM occasions WHERE id = $1`,
      [occasionId],
    );
    expect(after[0].reminder_sent).toBe(false);
  });
});

describe('cron route: index-events', () => {
  it('indexes new on-chain events and advances the cursor', async () => {
    // Seed an unindexed event and a cursor at the previous ledger.
    const { rows: eventRows } = await pool.query(
      `INSERT INTO chain_events (ledger, event_type, payload, indexed)
       VALUES ($1, $2, $3, false)
       RETURNING id, indexed`,
      [1001, 'transfer', JSON.stringify({ amount: '10.00000000' })],
    );
    const eventId = eventRows[0].id;
    expect(eventRows[0].indexed).toBe(false);

    await pool.query(
      `INSERT INTO indexer_cursor (id, last_ledger)
       VALUES (1, 1000)
       ON CONFLICT (id) DO UPDATE SET last_ledger = 1000`,
    );

    const res = await indexEventsGET(
      makeRequest('/api/v1/cron/index-events', authHeaders()),
    );
    expect(res.status).toBe(200);

    const { rows: afterEvent } = await pool.query(
      `SELECT indexed FROM chain_events WHERE id = $1`,
      [eventId],
    );
    expect(afterEvent[0].indexed).toBe(true);

    const { rows: cursorRows } = await pool.query(
      `SELECT last_ledger FROM indexer_cursor WHERE id = 1`,
    );
    expect(Number(cursorRows[0].last_ledger)).toBeGreaterThanOrEqual(1001);
  });
});