import { NextRequest, NextResponse } from 'next/server';
import { completeLogin, finishLogin } from '../../../lib/auth';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  let session = null;
  let returnTo = '/dashboard';
  try {
    session = params.has('error')
      ? null
      : await completeLogin(params.get('code'), params.get('state'));
    returnTo = await finishLogin();
  } catch {
    return NextResponse.redirect(new URL('/login?error=configuration', request.url));
  }
  if (!session) {
    return NextResponse.redirect(new URL('/login?error=callback', request.url));
  }
  return NextResponse.redirect(new URL(returnTo, request.url));
}
