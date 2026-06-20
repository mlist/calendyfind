/**
 * In-memory fixed-window rate limiter.
 * Single-container only — a horizontal scale-out deployment would need
 * this replaced with a Redis-backed limiter (e.g. ioredis + sliding window).
 *
 * Limits are env-configurable with safe defaults:
 *   RATE_LIMIT_SLOT_LIST_PER_MIN   — slot-list requests per IP per minute     (default 60)
 *   RATE_LIMIT_HOLD_IP_PER_MIN     — hold requests per IP per minute           (default 10)
 *   RATE_LIMIT_HOLD_EMAIL_PER_HOUR — hold requests per IP+email per hour       (default 5)
 *   RATE_LIMIT_HOLD_CONCURRENT     — live holds per IP+page at any one time    (default 3)
 *   RATE_LIMIT_CONFIRM_PER_MIN     — confirm requests per IP per minute        (default 20)
 *   RATE_LIMIT_CANCEL_PER_MIN      — cancel requests per IP per minute         (default 10)
 *   RATE_LIMIT_LOGIN_PER_MIN       — login attempts per IP per minute          (default 10)
 */

const env = (key: string, fallback: number) => {
  const v = parseInt(process.env[key] ?? '', 10);
  return isNaN(v) ? fallback : v;
};

const SLOT_LIST_MAX   = env('RATE_LIMIT_SLOT_LIST_PER_MIN',   60);
const HOLD_IP_MAX     = env('RATE_LIMIT_HOLD_IP_PER_MIN',     10);
const HOLD_EMAIL_MAX  = env('RATE_LIMIT_HOLD_EMAIL_PER_HOUR',  5);
const HOLD_CONC_MAX   = env('RATE_LIMIT_HOLD_CONCURRENT',      3);
const CONFIRM_MAX     = env('RATE_LIMIT_CONFIRM_PER_MIN',     20);
const CANCEL_MAX      = env('RATE_LIMIT_CANCEL_PER_MIN',      10);
const LOGIN_MAX       = env('RATE_LIMIT_LOGIN_PER_MIN',       10);

interface Window {
  count: number;
  resetAt: number;
}

const store = new Map<string, Window>();

// Clear stale entries every 5 min to prevent unbounded growth.
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, win] of store.entries()) {
      if (now >= win.resetAt) store.delete(key);
    }
  }, 5 * 60_000).unref?.();
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

function check(key: string, max: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const existing = store.get(key);

  if (!existing || now >= existing.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }

  if (existing.count >= max) {
    return { allowed: false, retryAfterMs: existing.resetAt - now };
  }

  existing.count++;
  return { allowed: true, retryAfterMs: 0 };
}

// Slot-list: generous, prevents enumeration
export function checkSlotListLimit(ip: string): RateLimitResult {
  return check(`slot-list:${ip}`, SLOT_LIST_MAX, 60_000);
}

// Hold creation: tight per-IP+page (HOLD-SPAM mitigation)
export function checkHoldLimit(ip: string, token: string, email: string): RateLimitResult {
  // 1. Per-IP per-minute burst guard
  const ipResult = check(`hold-ip:${ip}`, HOLD_IP_MAX, 60_000);
  if (!ipResult.allowed) return ipResult;

  // 2. Per-IP+email per-hour (prevents re-hold spam with the same email)
  const emailResult = check(`hold-email:${ip}:${email.toLowerCase()}`, HOLD_EMAIL_MAX, 3_600_000);
  if (!emailResult.allowed) return emailResult;

  // 3. Concurrent live holds per IP+page — checked against a sliding key
  const concResult = check(`hold-conc:${ip}:${token}`, HOLD_CONC_MAX, 10 * 60_000);
  if (!concResult.allowed) return concResult;

  return { allowed: true, retryAfterMs: 0 };
}

// Confirm: moderate
export function checkConfirmLimit(ip: string): RateLimitResult {
  return check(`confirm:${ip}`, CONFIRM_MAX, 60_000);
}

// Cancel: moderate
export function checkCancelLimit(ip: string): RateLimitResult {
  return check(`cancel:${ip}`, CANCEL_MAX, 60_000);
}

// Login: tight
export function checkLoginLimit(ip: string): RateLimitResult {
  return check(`login:${ip}`, LOGIN_MAX, 60_000);
}

// Free/busy feed: generous, prevents enumeration / DoS
const FREEBUSY_MAX = env('RATE_LIMIT_FREEBUSY_PER_MIN', 60);
export function checkFreeBusyLimit(ip: string): RateLimitResult {
  return check(`freebusy:${ip}`, FREEBUSY_MAX, 60_000);
}

// Legacy shim — kept for any callers that haven't been updated yet.
export function checkRateLimit(key: string, maxRequests = 20, windowMs = 60_000): boolean {
  return check(key, maxRequests, windowMs).allowed;
}
