import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

const AEST = 'Australia/Brisbane'

function todayAESTISO(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: AEST })
}

// Hits Supabase REST with a 5s timeout. Returns the parsed JSON body or throws.
async function supabaseGet(path: string, params: string): Promise<unknown> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 5000)
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}?${params}`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

type CheckResult = { ok: boolean; detail?: string }

export async function GET() {
  const today = todayAESTISO()
  const checks: Record<string, CheckResult> = {}

  // 1. Supabase reachable + RLS allows the count
  try {
    await supabaseGet('eisenhower_tasks', 'select=id&limit=1')
    checks.supabase = { ok: true }
  } catch (err) {
    checks.supabase = { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }

  // 2. Today's morning brief is on the table
  let briefSentAt: string | null = null
  try {
    const rows = await supabaseGet('ai_daily_briefs', `select=brief_date,generated_at,sent_at&brief_date=eq.${today}&limit=1`) as Array<{ brief_date: string; generated_at?: string; sent_at?: string | null }>
    if (rows.length === 0) {
      checks.todays_brief = { ok: false, detail: 'no row for today' }
    } else {
      briefSentAt = rows[0].sent_at ?? null
      checks.todays_brief = { ok: true, detail: rows[0].generated_at ?? '' }
    }
  } catch (err) {
    checks.todays_brief = { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }

  // 3. Today's brief was emailed (only flagged degraded after 07:00 AEST)
  const aestHourStr = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', hour12: false, timeZone: AEST })
  const aestHour = parseInt(aestHourStr, 10)
  const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(
    new Date().toLocaleDateString('en-AU', { weekday: 'short', timeZone: AEST })
  )
  if (isWeekday && aestHour >= 7) {
    checks.brief_sent = briefSentAt ? { ok: true, detail: briefSentAt } : { ok: false, detail: 'expected by 07:00 AEST on weekdays' }
  } else {
    checks.brief_sent = { ok: true, detail: 'outside expected delivery window' }
  }

  // 4. Outlook → task sync is alive. pg_cron `sync-outlook-matrix` runs every 15 min, but
  //    net.http_post reports "succeeded" the moment the request is queued — so a function
  //    returning 500 on every run looked healthy for weeks. The only honest signal is
  //    whether rows are actually landing.
  try {
    const rows = await supabaseGet(
      'eisenhower_tasks',
      'select=created_at&source_type=eq.email&order=created_at.desc&limit=1'
    ) as Array<{ created_at: string }>
    if (rows.length === 0) {
      checks.outlook_task_sync = { ok: false, detail: 'no email-sourced tasks at all' }
    } else {
      const ageHours = (Date.now() - new Date(rows[0].created_at).getTime()) / 3_600_000
      checks.outlook_task_sync = ageHours <= 48
        ? { ok: true, detail: rows[0].created_at }
        : { ok: false, detail: `newest email task is ${Math.floor(ageHours / 24)}d old (${rows[0].created_at})` }
    }
  } catch (err) {
    checks.outlook_task_sync = { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }

  // 5. Calendar cache is fresh. `sync-calendar-30min` upserts `calendar_events` every 30 min;
  //    the dashboard falls back to a live Graph pull past 2h, so 3h is the failure threshold.
  try {
    const rows = await supabaseGet(
      'calendar_events',
      'select=synced_at&order=synced_at.desc&limit=1'
    ) as Array<{ synced_at: string | null }>
    const syncedAt = rows[0]?.synced_at
    if (!syncedAt) {
      // An empty 200 here means the anon role can't see the table (RLS is enabled with no
      // SELECT policy), not that the cron stopped — the rows are there under service role.
      // Either way the dashboard's cache path is dead and every load hits Graph live.
      checks.calendar_sync = {
        ok: false,
        detail: 'calendar_events returned no rows to the anon key — add a SELECT policy or the dashboard cache stays dead',
      }
    } else {
      const ageMin = (Date.now() - new Date(syncedAt).getTime()) / 60_000
      checks.calendar_sync = ageMin <= 180
        ? { ok: true, detail: syncedAt }
        : { ok: false, detail: `calendar cache is ${Math.floor(ageMin / 60)}h stale (${syncedAt})` }
    }
  } catch (err) {
    checks.calendar_sync = { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }

  const allOk = Object.values(checks).every(c => c.ok)
  const status = allOk ? 'ok' : 'degraded'
  const httpStatus = allOk ? 200 : 503

  return NextResponse.json({
    status,
    timestamp: new Date().toISOString(),
    today_aest: today,
    checks,
  }, { status: httpStatus })
}
