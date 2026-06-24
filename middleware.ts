import { type NextRequest, NextResponse } from 'next/server';

// Cookie-presence check only — no DB hit. Full session validation happens in
// each layout via auth.api.getSession(). The default better-auth session
// cookie name is 'better-auth.session_token'.
const SESSION_COOKIE = 'better-auth.session_token';

export function middleware(req: NextRequest) {
  const hasCookie = req.cookies.has(SESSION_COOKIE);
  const { pathname } = req.nextUrl;

  const isProtected =
    pathname.startsWith('/dashboard') || pathname.startsWith('/admin');

  if (isProtected && !hasCookie) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/admin/:path*'],
};
