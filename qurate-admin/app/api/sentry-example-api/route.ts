// Server-side Sentry verification. Visit /api/sentry-example-api and the
// thrown error gets captured by the Sentry server SDK.

export const dynamic = 'force-dynamic'

export async function GET() {
  throw new Error('Sentry test exception — thrown from /api/sentry-example-api (server)')
}
