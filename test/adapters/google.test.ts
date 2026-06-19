import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { encrypt } from '@/lib/crypto';
import { googleAdapter, assertGoogleHost } from '@/lib/adapters/google';
import type { NewEvent } from '@/lib/adapters/interface';

// The adapter decrypts credentials; it needs ENCRYPTION_KEY and Google OAuth env vars.
const TEST_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes
beforeAll(() => {
  process.env.ENCRYPTION_KEY     = TEST_KEY;
  process.env.GOOGLE_CLIENT_ID     = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeTarget(refreshToken = 'test-refresh-token') {
  const encryptedCredentials = encrypt(JSON.stringify({ refreshToken }));
  return {
    id:                   'wt-1',
    userId:               'user-1',
    label:                'Test Calendar',
    provider:             'google' as const,
    encryptedCredentials,
    calendarRef:          'primary',
    isDefault:            true,
    createdAt:            new Date('2024-01-01'),
  };
}

const SAMPLE_EVENT: NewEvent = {
  uid:            'event-uid@calendyfind.local',
  sequence:       0,
  startUtc:       new Date('2024-06-15T10:00:00Z'),
  endUtc:         new Date('2024-06-15T10:30:00Z'),
  summary:        'Test Meeting',
  organizerName:  'Alice',
  organizerEmail: 'alice@example.com',
  attendeeName:   'Bob',
  attendeeEmail:  'bob@example.com',
  createdAt:      new Date('2024-06-01T09:00:00Z'),
};

function mockFetch(responses: Array<{ ok: boolean; status?: number; body: unknown }>) {
  let callIdx = 0;
  const spy = vi.fn(async (_url: string, _init?: RequestInit) => {
    const r = responses[callIdx++] ?? responses.at(-1)!;
    return {
      ok:     r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      text:   async () => JSON.stringify(r.body),
      json:   async () => r.body,
    };
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

// ─── SSRF guard ───────────────────────────────────────────────────────────────

describe('assertGoogleHost (SSRF guard)', () => {
  it('allows www.googleapis.com', () => {
    expect(() => assertGoogleHost('https://www.googleapis.com/calendar/v3/foo')).not.toThrow();
  });

  it('allows oauth2.googleapis.com', () => {
    expect(() => assertGoogleHost('https://oauth2.googleapis.com/token')).not.toThrow();
  });

  it('rejects arbitrary host', () => {
    expect(() => assertGoogleHost('https://evil.com/steal-tokens')).toThrow('SSRF guard');
  });

  it('rejects subdomain that is NOT in allowed set', () => {
    expect(() => assertGoogleHost('https://api.googleapis.com/foo')).toThrow('SSRF guard');
  });
});

// ─── createEvent ─────────────────────────────────────────────────────────────

describe('googleAdapter.createEvent', () => {
  it('happy path: returns externalRef from Google event id', async () => {
    mockFetch([
      { ok: true, body: { access_token: 'test-access-token' } }, // token endpoint
      { ok: true, body: { id: 'google-event-id-123' } },          // create event endpoint
    ]);

    const target = makeTarget();
    const result = await googleAdapter.createEvent(target, SAMPLE_EVENT);

    expect(result.externalRef).toBe('google-event-id-123');
  });

  it('throws when token refresh fails', async () => {
    mockFetch([
      { ok: false, status: 401, body: { error: 'invalid_grant' } },
    ]);

    const target = makeTarget();
    await expect(googleAdapter.createEvent(target, SAMPLE_EVENT)).rejects.toThrow('token refresh failed');
  });

  it('throws when calendar create fails', async () => {
    mockFetch([
      { ok: true, body: { access_token: 'tok' } },
      { ok: false, status: 403, body: { error: 'forbidden' } },
    ]);

    const target = makeTarget();
    await expect(googleAdapter.createEvent(target, SAMPLE_EVENT)).rejects.toThrow('createEvent failed');
  });

  it('sends sendUpdates=none query param (no Google-generated invites)', async () => {
    const fetchSpy = mockFetch([
      { ok: true, body: { access_token: 'tok' } },
      { ok: true, body: { id: 'evt-abc' } },
    ]);

    await googleAdapter.createEvent(makeTarget(), SAMPLE_EVENT);

    const calCall = fetchSpy.mock.calls[1]!;
    expect(calCall[0]).toContain('sendUpdates=none');
  });
});

// ─── cancelEvent ─────────────────────────────────────────────────────────────

describe('googleAdapter.cancelEvent', () => {
  it('happy path: resolves without throwing', async () => {
    mockFetch([
      { ok: true, body: { access_token: 'tok' } },
      { ok: true, status: 204, body: null },
    ]);

    await expect(
      googleAdapter.cancelEvent(makeTarget(), 'google-event-id-123', 'uid@local', 1),
    ).resolves.toBeUndefined();
  });

  it('treats 404 as success (event already deleted)', async () => {
    mockFetch([
      { ok: true, body: { access_token: 'tok' } },
      { ok: false, status: 404, body: { error: 'notFound' } },
    ]);

    await expect(
      googleAdapter.cancelEvent(makeTarget(), 'ghost-event', 'uid@local', 1),
    ).resolves.toBeUndefined();
  });

  it('treats 410 as success (event gone)', async () => {
    mockFetch([
      { ok: true, body: { access_token: 'tok' } },
      { ok: false, status: 410, body: { error: 'gone' } },
    ]);

    await expect(
      googleAdapter.cancelEvent(makeTarget(), 'deleted-event', 'uid@local', 1),
    ).resolves.toBeUndefined();
  });

  it('throws on other HTTP errors', async () => {
    mockFetch([
      { ok: true, body: { access_token: 'tok' } },
      { ok: false, status: 500, body: { error: 'internal' } },
    ]);

    await expect(
      googleAdapter.cancelEvent(makeTarget(), 'evt-id', 'uid@local', 1),
    ).rejects.toThrow('cancelEvent failed');
  });

  it('no-op when externalRef is empty string', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await googleAdapter.cancelEvent(makeTarget(), '', 'uid@local', 1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
