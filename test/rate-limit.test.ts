import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('rate-limit', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it('allows requests up to the limit', async () => {
    const { checkSlotListLimit } = await import('@/lib/rate-limit');
    const ip = '1.2.3.4';
    for (let i = 0; i < 60; i++) {
      expect(checkSlotListLimit(ip).allowed).toBe(true);
    }
  });

  it('blocks after limit is reached', async () => {
    const { checkSlotListLimit } = await import('@/lib/rate-limit');
    const ip = '10.0.0.1';
    for (let i = 0; i < 60; i++) checkSlotListLimit(ip);
    const result = checkSlotListLimit(ip);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('checkHoldLimit: blocks at concurrent-holds limit (3) for same ip+page', async () => {
    const { checkHoldLimit } = await import('@/lib/rate-limit');
    const ip = '2.3.4.5';
    const token = 'page-abc';
    // Each call checks both per-IP and concurrent; concurrent limit=3 is hit first
    for (let i = 0; i < 3; i++) {
      expect(checkHoldLimit(ip, token, `user${i}@example.com`).allowed).toBe(true);
    }
    // 4th attempt is blocked by concurrent limit
    const result = checkHoldLimit(ip, token, 'other@example.com');
    expect(result.allowed).toBe(false);
  });

  it('checkHoldLimit: blocks same email after 5 holds per hour across different pages', async () => {
    const { checkHoldLimit } = await import('@/lib/rate-limit');
    const ip = '3.4.5.6';
    const email = 'repeat@example.com';
    // Use 5 different tokens to avoid the concurrent (3/window) cap
    for (let i = 0; i < 5; i++) {
      expect(checkHoldLimit(ip, `token-${i}`, email).allowed).toBe(true);
    }
    // 6th attempt with yet another token — blocked by per-email limit
    const result = checkHoldLimit(ip, 'token-5', email);
    expect(result.allowed).toBe(false);
  });

  it('checkLoginLimit: blocks after 10 attempts', async () => {
    const { checkLoginLimit } = await import('@/lib/rate-limit');
    const ip = '5.6.7.8';
    for (let i = 0; i < 10; i++) checkLoginLimit(ip);
    expect(checkLoginLimit(ip).allowed).toBe(false);
  });

  it('different IPs have independent counters', async () => {
    const { checkLoginLimit } = await import('@/lib/rate-limit');
    const ip1 = '11.0.0.1';
    const ip2 = '11.0.0.2';
    for (let i = 0; i < 10; i++) checkLoginLimit(ip1);
    expect(checkLoginLimit(ip1).allowed).toBe(false);
    expect(checkLoginLimit(ip2).allowed).toBe(true);
  });

  it('legacy checkRateLimit shim works', async () => {
    const { checkRateLimit } = await import('@/lib/rate-limit');
    const key = 'legacy:test:key';
    for (let i = 0; i < 5; i++) expect(checkRateLimit(key, 5, 60_000)).toBe(true);
    expect(checkRateLimit(key, 5, 60_000)).toBe(false);
  });
});
