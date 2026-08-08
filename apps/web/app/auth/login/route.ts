import { NextRequest, NextResponse } from 'next/server';
import { startLogin } from '../../../lib/auth';

export async function GET(request: NextRequest) {
  try {
    return NextResponse.redirect(await startLogin(request.nextUrl.searchParams.get('returnTo')));
  } catch {
    return NextResponse.redirect(new URL('/login?error=configuration', request.url));
  }
}
