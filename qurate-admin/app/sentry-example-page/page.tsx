'use client'

// One-page Sentry verification. Click the button to throw, then check the Sentry
// Issues feed for `qurate-pty-ltd/qurate-chiefofstaff`. Safe to leave in place;
// the route is unlinked from any nav and only the user (signed in or not) can
// reach it via /sentry-example-page.

const NAVY = '#2E3D49'
const NAVY_LIGHT = '#374857'
const GOLD = '#C19131'
const WHITE = '#FFFFFF'
const BEIGE = '#D9D2BE'

export default function SentryExamplePage() {
  return (
    <main style={{
      minHeight: '100vh',
      background: NAVY,
      color: WHITE,
      fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif",
      padding: 32,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 16,
    }}>
      <h1 style={{ fontFamily: "'Gujarati Sangam MN', 'DM Sans', serif", fontWeight: 700, margin: 0 }}>
        Sentry verification
      </h1>
      <p style={{ color: BEIGE, fontWeight: 300, margin: 0, maxWidth: 480, textAlign: 'center' }}>
        Click the button below to throw a sample error. If Sentry is wired correctly, the
        error will land in the Sentry Issues feed for <code>qurate-pty-ltd/qurate-chiefofstaff</code>.
      </p>
      <button
        type="button"
        onClick={() => {
          throw new Error('Sentry test exception — thrown from /sentry-example-page')
        }}
        style={{
          marginTop: 16,
          background: GOLD,
          color: NAVY,
          border: 'none',
          borderRadius: 8,
          padding: '12px 24px',
          fontSize: 14,
          fontWeight: 500,
          cursor: 'pointer',
          minHeight: 44,
        }}
      >
        Throw sample error
      </button>
      <p style={{ color: BEIGE, fontWeight: 300, margin: '24px 0 0', fontSize: 13, opacity: 0.7 }}>
        Server-side capture is also wired. To test, hit <code>/api/sentry-example-api</code>.
      </p>
      <a
        href="/api/sentry-example-api"
        style={{
          color: GOLD,
          textDecoration: 'underline',
          fontSize: 13,
          fontWeight: 300,
        }}
      >
        Trigger server error →
      </a>
    </main>
  )
}
