'use client'

import { useState } from 'react'
import { SUPABASE_FUNCTIONS_URL } from '@/lib/supabase'

export default function LoginPage() {
  const [loading, setLoading] = useState(false)

  async function handleLogin() {
    setLoading(true)
    try {
      const redirectUri = `${window.location.origin}/api/auth/callback`
      const res = await fetch(
        `${SUPABASE_FUNCTIONS_URL}/ms-auth?action=login&redirect_uri=${encodeURIComponent(redirectUri)}`,
        { headers: { 'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! } }
      )
      const data = await res.json()
      if (data.auth_url) {
        window.location.href = data.auth_url
      } else {
        alert('Failed to get login URL: ' + JSON.stringify(data))
        setLoading(false)
      }
    } catch (e) {
      alert('Error: ' + e)
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#2E3D49',
      fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif",
    }}>
      <div style={{
        background: '#374857',
        border: '1px solid rgba(217,210,190,0.15)',
        borderRadius: 16,
        padding: '48px 56px',
        maxWidth: 440,
        width: '100%',
        textAlign: 'center'
      }}>
        {/* Logo */}
        <div style={{ marginBottom: 32 }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 8
          }}>
            <div style={{
              width: 36,
              height: 36,
              background: '#C19131',
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 18,
              fontWeight: 700,
              color: '#2E3D49',
              fontFamily: "'Gujarati Sangam MN', 'DM Sans', serif",
            }}>Q</div>
            <span style={{ fontSize: 20, fontWeight: 700, color: '#FFFFFF', letterSpacing: '-0.3px', fontFamily: "'Gujarati Sangam MN', 'DM Sans', serif" }}>
              Qurate
            </span>
          </div>
          <p style={{ color: '#D9D2BE', fontSize: 13, margin: 0, fontWeight: 300 }}>Advisory</p>
        </div>

        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#FFFFFF', margin: '0 0 8px', letterSpacing: '-0.5px', fontFamily: "'Gujarati Sangam MN', 'DM Sans', serif" }}>
          Welcome back
        </h1>
        <p style={{ color: '#D9D2BE', fontSize: 14, margin: '0 0 36px', lineHeight: 1.6, fontWeight: 300 }}>
          Connect your Microsoft account to access your emails, calendar, and AI briefings.
        </p>

        <button
          onClick={handleLogin}
          disabled={loading}
          style={{
            width: '100%',
            padding: '14px 24px',
            background: loading ? '#374857' : '#C19131',
            color: loading ? '#D9D2BE' : '#2E3D49',
            border: 'none',
            borderRadius: 10,
            fontSize: 15,
            fontWeight: 500,
            cursor: loading ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            transition: 'all 0.2s',
            fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif",
            minHeight: 48,
          }}
        >
          {loading ? (
            <>
              <span style={{ display: 'inline-block', width: 16, height: 16, border: '2px solid rgba(217,210,190,0.3)', borderTopColor: '#D9D2BE', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              Connecting...
            </>
          ) : (
            <>
              <svg width="18" height="18" viewBox="0 0 21 21" fill="none">
                <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
                <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
                <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
                <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
              </svg>
              Sign in with Microsoft
            </>
          )}
        </button>

        <p style={{ color: 'rgba(217,210,190,0.4)', fontSize: 12, marginTop: 24, fontWeight: 300 }}>
          Access is restricted to your Microsoft 365 account
        </p>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
