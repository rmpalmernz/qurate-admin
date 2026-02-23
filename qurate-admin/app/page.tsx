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
      background: '#0f1117',
      fontFamily: "'DM Sans', sans-serif"
    }}>
      <div style={{
        background: '#1a1d27',
        border: '1px solid #2a2f45',
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
              background: 'linear-gradient(135deg, #3AAFA9, #C9A96E)',
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 18,
              fontWeight: 700,
              color: '#fff'
            }}>Q</div>
            <span style={{ fontSize: 20, fontWeight: 600, color: '#e8eaf0', letterSpacing: '-0.3px' }}>
              Qurate
            </span>
          </div>
          <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>Admin Agent</p>
        </div>

        <h1 style={{ fontSize: 24, fontWeight: 600, color: '#e8eaf0', margin: '0 0 8px', letterSpacing: '-0.5px' }}>
          Good morning, Richard
        </h1>
        <p style={{ color: '#6b7280', fontSize: 14, margin: '0 0 36px', lineHeight: 1.6 }}>
          Connect your Microsoft account to access your emails, calendar, and AI briefings.
        </p>

        <button
          onClick={handleLogin}
          disabled={loading}
          style={{
            width: '100%',
            padding: '14px 24px',
            background: loading ? '#2a2f45' : 'linear-gradient(135deg, #3AAFA9, #2E9E98)',
            color: '#fff',
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
            fontFamily: "'DM Sans', sans-serif"
          }}
        >
          {loading ? (
            <>
              <span style={{ display: 'inline-block', width: 16, height: 16, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
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

        <p style={{ color: '#3d4258', fontSize: 12, marginTop: 24 }}>
          Access is restricted to your Microsoft 365 account
        </p>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
