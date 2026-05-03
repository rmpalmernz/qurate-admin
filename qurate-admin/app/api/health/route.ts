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
