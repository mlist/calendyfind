import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';

const ALG = 'aes-256-gcm';

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Generate one with: openssl rand -hex 32',
    );
  }
  if (hex.length !== 64) {
    throw new Error(
      `ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes), got ${hex.length}`,
    );
  }
  return Buffer.from(hex, 'hex');
}

export function validateEncryptionKey(): void {
  getKey();
}

// Returns base64: iv (12B) | authTag (16B) | ciphertext
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export function decrypt(ciphertext: string): string {
  const key = getKey();
  const data = Buffer.from(ciphertext, 'base64');
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    'utf8',
  );
}

// ─── OAuth CSRF state token (HMAC-signed, 10-min TTL) ────────────────────────
// Used to bind the Google OAuth callback to the initiating user session.
// Format: base64url(JSON) + "." + HMAC-SHA256(base64url(JSON), ENCRYPTION_KEY)

export function createOAuthState(
  userId: string,
  extra: Record<string, string> = {},
): string {
  const payload = Buffer.from(
    JSON.stringify({ userId, ts: Date.now(), ...extra }),
  ).toString('base64url');
  const sig = createHmac('sha256', getKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyOAuthState(
  state: string,
): { userId: string; [key: string]: string } | null {
  const dot = state.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = state.slice(0, dot);
  const sig     = state.slice(dot + 1);
  const expected = createHmac('sha256', getKey()).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { userId: string; ts: number } & Record<string, string>;
    if (Date.now() - data.ts > 10 * 60_000) return null; // expired
    const { ts: _ts, ...rest } = data;
    void _ts;
    return rest as { userId: string } & Record<string, string>;
  } catch {
    return null;
  }
}
