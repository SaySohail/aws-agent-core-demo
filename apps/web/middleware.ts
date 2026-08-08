import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'agent_launchpad_id_token';

export function middleware(request: NextRequest) {
  if (!request.cookies.has(SESSION_COOKIE)) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('returnTo', request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/dashboard/:path*'] };
