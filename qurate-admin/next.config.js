const { withSentryConfig } = require('@sentry/nextjs')

/** @type {import('next').NextConfig} */
const nextConfig = {}

module.exports = withSentryConfig(nextConfig, {
  silent: true,
  // Tunnel route to bypass ad-blockers that strip Sentry requests.
  tunnelRoute: '/monitoring',
  // No source-map upload in CI without an auth token; Sentry will still ingest events.
  hideSourceMaps: true,
  disableLogger: true,
})
