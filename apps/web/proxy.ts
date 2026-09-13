import { NextResponse, type NextRequest } from 'next/server';

// Cheap first gate: no session cookie → sign in. The signature is verified in the app layout and in every API route.
export function proxy(req: NextRequest) {
  if (req.cookies.has('tmos_session')) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!login|api/|healthz|_next/|favicon|login\\.jpg).*)'],
};
