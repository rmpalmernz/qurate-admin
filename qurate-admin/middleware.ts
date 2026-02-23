import { NextRequest, NextResponse } from 'next/server'

export function middleware(request: NextRequest) {
  const isConnected = request.cookies.get('ms_auth_connected')?.value === '1'

  if (!isConnected) {
    return NextResponse.redirect(new URL('/', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/dashboard/:path*'],
}
