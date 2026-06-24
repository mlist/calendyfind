'use client';
import { createAuthClient } from 'better-auth/react';
import { adminClient } from 'better-auth/client/plugins';

// Derive baseURL at runtime: browser origin + basePath that Next.js embeds in __NEXT_DATA__.
// This avoids a NEXT_PUBLIC_* build-time env var while still working at any subpath.
const baseURL =
  typeof window !== 'undefined'
    ? `${window.location.origin}${(window as any).__NEXT_DATA__?.basePath ?? ''}`
    : undefined;

export const authClient = createAuthClient({
  baseURL,
  plugins: [adminClient()],
});
