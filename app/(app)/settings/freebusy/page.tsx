import { redirect } from 'next/navigation';
import Link from 'next/link';
import { headers } from 'next/headers';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { freebusyFeed } from '@/lib/db/schema';
import { createFeedAction, rotateFeedAction, revokeFeedAction, reactivateFeedAction } from './_actions';

export default async function FreeBusyFeedPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const sp   = await searchParams;
  const feed = db.select().from(freebusyFeed).where(eq(freebusyFeed.userId, session.user.id)).get();

  const appUrl  = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
  const feedUrl = feed?.active ? `${appUrl}/fb/${feed.secretToken}.ics` : null;

  return (
    <main style={{ maxWidth: 700, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <Link href="/settings">← Settings</Link>
      <h1>Free/busy feed</h1>

      {sp.error   && <p style={{ color: 'crimson',      background: '#fff0f0', padding: '0.5rem', borderRadius: 4 }}>{decodeURIComponent(sp.error)}</p>}
      {sp.success && <p style={{ color: 'darkgreen',    background: '#f0fff0', padding: '0.5rem', borderRadius: 4 }}>{decodeURIComponent(sp.success)}</p>}

      <div style={{ background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1.5rem' }}>
        <strong>Privacy reminder</strong>
        <p style={{ margin: '0.25rem 0 0', fontSize: 14 }}>
          This URL reveals <em>when</em> you are busy to anyone who subscribes to it.
          It never reveals event titles, attendees, or any details — only opaque busy blocks.
          Treat it like a password: share only with people and tools you trust,
          and rotate or revoke it if it gets out.
        </p>
      </div>

      {!feed ? (
        <>
          <p>No feed yet. Generate one to get a subscribable URL.</p>
          <form action={createFeedAction}>
            <button type="submit" style={{ padding: '0.6rem 1.5rem', fontSize: '1rem', cursor: 'pointer' }}>
              Generate free/busy feed URL
            </button>
          </form>
        </>
      ) : (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '1.5rem' }}>
            <tbody>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 12px 6px 0', width: 120 }}>Status</th>
                <td style={{ padding: '6px 0' }}>
                  {feed.active ? (
                    <span style={{ color: 'green', fontWeight: 600 }}>Active</span>
                  ) : (
                    <span style={{ color: 'crimson', fontWeight: 600 }}>Revoked</span>
                  )}
                </td>
              </tr>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 12px 6px 0' }}>Created</th>
                <td style={{ padding: '6px 0', fontSize: 13 }}>
                  {feed.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC
                </td>
              </tr>
              {feed.lastRotatedAt && (
                <tr>
                  <th style={{ textAlign: 'left', padding: '6px 12px 6px 0' }}>Last rotated</th>
                  <td style={{ padding: '6px 0', fontSize: 13 }}>
                    {feed.lastRotatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {feedUrl ? (
            <div style={{ marginBottom: '1.5rem' }}>
              <p style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Subscribe URL</p>
              <code style={{
                display: 'block', padding: '0.6rem 0.8rem', background: '#f3f4f6',
                borderRadius: 4, wordBreak: 'break-all', fontSize: 13,
              }}>
                {feedUrl}
              </code>
              <p style={{ fontSize: 12, color: '#6b7280', marginTop: '0.25rem' }}>
                Add this URL as a subscribed calendar in Google Calendar, Outlook, or any CalDAV client.
                Callers receive opaque "Busy" blocks — no event details are exposed.
              </p>
            </div>
          ) : (
            <p style={{ color: 'crimson' }}>Feed is revoked — URL is no longer active.</p>
          )}

          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            {feed.active ? (
              <>
                <details style={{ display: 'contents' }}>
                  <summary style={{ cursor: 'pointer', color: '#d97706', fontSize: 14, display: 'block', marginBottom: '0.25rem' }}>
                    Rotate URL…
                  </summary>
                  <div style={{ marginTop: '0.25rem', padding: '0.75rem', background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: 4, maxWidth: 380 }}>
                    <p style={{ margin: '0 0 0.5rem', fontWeight: 600 }}>⚠ The current URL will stop working immediately.</p>
                    <p style={{ margin: '0 0 0.75rem', fontSize: 13, color: '#6b7280' }}>
                      Any calendar app subscribed to the old URL will stop receiving updates.
                      You must re-subscribe with the new URL.
                    </p>
                    <form action={rotateFeedAction}>
                      <input type="hidden" name="id" value={feed.id} />
                      <button type="submit" style={{ padding: '6px 14px', background: '#d97706', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
                        Yes, rotate the URL
                      </button>
                    </form>
                  </div>
                </details>

                <details style={{ display: 'contents' }}>
                  <summary style={{ cursor: 'pointer', color: '#dc2626', fontSize: 14, display: 'block', marginBottom: '0.25rem' }}>
                    Revoke feed…
                  </summary>
                  <div style={{ marginTop: '0.25rem', padding: '0.75rem', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 4, maxWidth: 380 }}>
                    <p style={{ margin: '0 0 0.5rem', fontWeight: 600, color: '#dc2626' }}>⚠ The feed will stop responding immediately.</p>
                    <p style={{ margin: '0 0 0.75rem', fontSize: 13, color: '#6b7280' }}>
                      Subscribers will receive 404. You can reactivate later (with a new URL).
                    </p>
                    <form action={revokeFeedAction}>
                      <input type="hidden" name="id" value={feed.id} />
                      <button type="submit" style={{ padding: '6px 14px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
                        Yes, revoke the feed
                      </button>
                    </form>
                  </div>
                </details>
              </>
            ) : (
              <form action={reactivateFeedAction}>
                <input type="hidden" name="id" value={feed.id} />
                <button type="submit" style={{ padding: '6px 14px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                  Reactivate feed (new URL)
                </button>
              </form>
            )}
          </div>
        </>
      )}
    </main>
  );
}
