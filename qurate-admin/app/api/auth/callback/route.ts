import { NextRequest, NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code')
  const error = searchParams.get('error')

  if (error) {
    return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(error)}`, req.url))
  }

  if (!code) {
    return NextResponse.redirect(new URL('/?error=no_code', req.url))
  }

  try {
    const redirectUri = `${req.nextUrl.origin}/api/auth/callback`

    const res = await fetch(`${SUPABASE_URL}/functions/v1/ms-auth?action=callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ code, redirect_uri: redirectUri })
    })

    const data = await res.json()

    if (!res.ok || data.error) {
      console.error('Token exchange failed:', data)
      return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(data.error || 'token_exchange_failed')}`, req.url))
    }

    // Success - redirect to dashboard
    return NextResponse.redirect(new URL('/dashboard', req.url))
  } catch (e) {
    console.error('Callback error:', e)
    return NextResponse.redirect(new URL('/?error=callback_failed', req.url))
  }
}
