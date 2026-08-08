import { NextResponse } from 'next/server';
import { logoutUrl } from '../../../lib/auth';

export async function GET(request: Request) {
  try {
    return NextResponse.redirect(await logoutUrl());
  } catch {
    return NextResponse.redirect(new URL('/login?error=configuration', request.url));
  }
}

export const POST = GET;
