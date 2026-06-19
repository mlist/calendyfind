import { describe, it, expect } from 'vitest';
import { fetchIcsText } from '../../lib/availability/fetcher';

describe('fetchIcsText SSRF guard', () => {
  it('rejects localhost', async () => {
    await expect(fetchIcsText('http://localhost/calendar.ics')).rejects.toThrow();
  });

  it('rejects 127.0.0.1', async () => {
    await expect(fetchIcsText('http://127.0.0.1/calendar.ics')).rejects.toThrow();
  });

  it('rejects 10.x private range', async () => {
    await expect(fetchIcsText('http://10.0.0.1/calendar.ics')).rejects.toThrow();
  });

  it('rejects 192.168.x private range', async () => {
    await expect(fetchIcsText('http://192.168.1.1/calendar.ics')).rejects.toThrow();
  });

  it('rejects unsupported protocol (ftp)', async () => {
    await expect(fetchIcsText('ftp://example.com/calendar.ics')).rejects.toThrow(/protocol/i);
  });

  it('rejects an invalid URL', async () => {
    await expect(fetchIcsText('not-a-url')).rejects.toThrow(/Invalid URL/i);
  });

  it('normalises webcal:// to https:// for protocol check', async () => {
    // Will still fail because external network is likely unavailable in tests,
    // but should NOT throw "unsupported protocol" — should throw a network error
    const result = fetchIcsText('webcal://calendar.example.com/cal.ics');
    await expect(result).rejects.not.toThrow(/unsupported protocol/i);
  });
});
