import dns from 'node:dns/promises';

const TIMEOUT_MS    = 10_000;
const MAX_BYTES     = 5 * 1024 * 1024; // 5 MB

function isPrivateIp(ip: string): boolean {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '0.0.0.0' ||
    /^127\./.test(ip) ||
    /^10\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    /^fc[0-9a-f]{2}:/i.test(ip) ||
    /^fd[0-9a-f]{2}:/i.test(ip) ||
    /^fe80:/i.test(ip)
  );
}

async function isBlockedHost(hostname: string): Promise<boolean> {
  if (isPrivateIp(hostname)) return true;
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    return addrs.some(a => isPrivateIp(a.address));
  } catch {
    return true; // unresolvable → block
  }
}

export async function fetchIcsText(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    // Normalise webcal:// → https://
    url = new URL(rawUrl.replace(/^webcal:/i, 'https:'));
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }

  if (await isBlockedHost(url.hostname)) {
    throw new Error(`Blocked: private or unresolvable host ${url.hostname}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Accept: 'text/calendar, */*' },
    });
  } catch (e) {
    throw new Error(`Fetch failed for ${rawUrl}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new Error(`HTTP ${response.status} from ${rawUrl}`);

  const reader = response.body?.getReader();
  if (!reader) throw new Error(`No response body from ${rawUrl}`);

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) throw new Error(`Response too large (>${MAX_BYTES} bytes) from ${rawUrl}`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf-8');
}
