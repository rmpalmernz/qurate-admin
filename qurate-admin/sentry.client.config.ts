import * as Sentry from '@sentry/nextjs'

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN

Sentry.init({
  dsn: DSN,
  enabled: Boolean(DSN),
  environment: process.env.NODE_ENV,
  tracesSampleRate: 1.0,
  // No session replay (privacy + bandwidth) — errors + perf traces only.
})
