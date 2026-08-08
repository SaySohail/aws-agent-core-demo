import { NextRequest, NextResponse } from 'next/server';
import { currentIdToken } from '../../../../lib/auth';

async function forward(request: NextRequest, segments: string[]) {
  const token = await currentIdToken();
  const baseUrl = process.env.CONTROL_API_BASE_URL;
  if (!token || !baseUrl)
    return NextResponse.json(
      {
        error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.', requestId: 'web' }
      },
      { status: 401 }
    );
  const url = new URL(segments.map(encodeURIComponent).join('/'), `${baseUrl.replace(/\/$/, '')}/`);
  url.search = request.nextUrl.search;
  const response = await fetch(url, {
    method: request.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(request.headers.get('content-type') ? { 'content-type': 'application/json' } : {})
    },
    ...(request.method === 'GET' ? {} : { body: await request.text() }),
    cache: 'no-store'
  });
  return new NextResponse(response.body, {
    status: response.status,
    headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return forward(request, (await params).path);
}
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return forward(request, (await params).path);
}
