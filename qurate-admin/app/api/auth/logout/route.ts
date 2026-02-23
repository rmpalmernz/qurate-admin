import { NextRequest, NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export async function GET(req: NextRequest) {
  // Revoke the MS token stored in Supabase
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/ms-auth?action=disconnect`, {
      headers: { apikey: SUPABASE_ANON_KEY },
    })
  } catch {
    // Continue even if disconnect call fails
  }

  // Clear the session cookie and redirect to login
  const response = NextResponse.redirect(new URL('/', req.url))
  response.cookies.set('ms_auth_connected', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
  return response
}
