const { withSentryConfig } = require('@sentry/nextjs')

/** @type {import('next').NextConfig} */
const nextConfig = {}

module.exports = withSentryConfig(nextConfig, {
  // Sentry org + project. Source-map upload happens during build when
  // SENTRY_AUTH_TOKEN is set in the Vercel env (otherwise no-op).
  org: 'qurate-pty-ltd',
  project: 'qurate-chiefofstaff',
  silent: !process.env.CI,
  // Widen the file glob so client bundles in non-default locations get sourcemaps too.
  widenClientFileUpload: true,
  // Tunnel route to bypass ad-blockers that strip Sentry requests.
  tunnelRoute: '/monitoring',
  // Don't ship source maps to the public bundle — keep them server-side only.
  hideSourceMaps: true,
  // Tree-shake Sentry's debug logger from production bundles.
  disableLogger: true,
  // Auto-instrument any Vercel cron jobs (we have none — Supabase cron — but harmless).
  automaticVercelMonitors: true,
})
