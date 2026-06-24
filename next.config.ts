import type { NextConfig } from 'next';

const securityHeaders = [
  // Prevent MIME type sniffing
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Block framing (clickjacking protection)
  { key: 'X-Frame-Options', value: 'DENY' },
  // Referrer: no cross-origin leakage
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // HSTS — 1 year; includeSubDomains; preload when ready
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  // CSP — restrict sources; inline styles/scripts are needed for Next.js App Router
  // 'unsafe-inline' on scripts is necessary until Next.js supports nonces fully.
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
  // Disable FLoC / Topics API
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  basePath: process.env.BASE_PATH ?? '',
  serverExternalPackages: ['better-sqlite3'],
  async headers() {
    return [
      {
        // Apply to all routes
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
