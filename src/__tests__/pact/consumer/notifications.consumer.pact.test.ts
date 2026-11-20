import path from 'path';
import { PactV3, MatchersV3 } from '@pact-foundation/pact';

const { like, eachLike, string, integer, boolean, datetime, regex } = MatchersV3;

const PACT_DIR = path.resolve(__dirname, '../../../../pacts');

const provider = new PactV3({
  consumer: 'GiftAppFrontend',
  provider: 'GiftAppAPI',
  dir: PACT_DIR,
  logLevel: 'warn',
});

describe('Notifications API consumer contract', () => {
  describe('GET /api/notifications', () => {
    it('returns a list of notifications for the current user', async () => {
      provider
        .given('user has notifications')
        .uponReceiving('a request to list notifications')
        .withRequest({
          method: 'GET',
          path: '/api/notifications',
          headers: { Accept: 'application/json' },
        })
        .willRespondWith({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: eachLike({
            id: string('notif-1'),
            userId: string('user-1'),
            type: regex('gift_reminder', 'gift_reminder|wishlist_update|occasion_reminder|system'),
            title: string('Gift reminder'),
            message: string('Your gift exchange starts soon'),
            read: boolean(false),
            createdAt: datetime("yyyy-MM-dd'T'HH:mm:ss.SSSX", '2024-01-01T00:00:00.000Z'),
          }),
        });

      await provider.executeTest(async (mockServer) => {
        const response = await fetch(`${mockServer.url}/api/notifications`, {
          headers: { Accept: 'application/json' },
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(Array.isArray(body)).toBe(true);
        expect(body[0]).toHaveProperty('id');
        expect(body[0]).toHaveProperty('read');
      });
    });
  });

  describe('GET /api/notifications/unread-count', () => {
    it('returns the unread notification count', async () => {
      provider
        .given('user has unread notifications')
        .uponReceiving('a request for the unread notification count')
        .withRequest({
          method: 'GET',
          path: '/api/notifications/unread-count',
          headers: { Accept: 'application/json' },
        })
        .willRespondWith({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: {
            count: integer(3),
          },
        });

      await provider.executeTest(async (mockServer) => {
        const response = await fetch(`${mockServer.url}/api/notifications/unread-count`, {
          headers: { Accept: 'application/json' },
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toHaveProperty('count');
      });
    });
  });

  describe('PATCH /api/notifications/:id/read', () => {
    it('marks a notification as read', async () => {
      provider
        .given('a notification exists')
        .uponReceiving('a request to mark a notification as read')
        .withRequest({
          method: 'PATCH',
          path: '/api/notifications/notif-1/read',
          headers: { Accept: 'application/json' },
        })
        .willRespondWith({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: {
            id: string('notif-1'),
            userId: string('user-1'),
            type: string('gift_reminder'),
            title: string('Gift reminder'),
            message: string('Your gift exchange starts soon'),
            read: boolean(true),
            createdAt: datetime("yyyy-MM-dd'T'HH:mm:ss.SSSX", '2024-01-01T00:00:00.000Z'),
          },
        });

      await provider.executeTest(async (mockServer) => {
        const response = await fetch(`${mockServer.url}/api/notifications/notif-1/read`, {
          method: 'PATCH',
          headers: { Accept: 'application/json' },
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.read).toBe(true);
      });
    });
  });

  describe('PATCH /api/notifications/read-all', () => {
    it('marks all notifications as read', async () => {
      provider
        .given('user has unread notifications')
        .uponReceiving('a request to mark all notifications as read')
        .withRequest({
          method: 'PATCH',
          path: '/api/notifications/read-all',
          headers: { Accept: 'application/json' },
        })
        .willRespondWith({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: {
            updated: integer(3),
          },
        });

      await provider.executeTest(async (mockServer) => {
        const response = await fetch(`${mockServer.url}/api/notifications/read-all`, {
          method: 'PATCH',
          headers: { Accept: 'application/json' },
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toHaveProperty('updated');
      });
    });
  });
});