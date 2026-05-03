// morning-brief — single Edge Function that owns generation + email delivery + persistence
// of the daily executive briefing. Replaces daily-brief, send-brief, and chat's "brief mode".
//
// Body (all optional):
//   force?: boolean    Regenerate even if today's row already has brief_text
//   send?: boolean     Also email the brief via Graph /me/sendMail
//   context?: {...}    Frontend-supplied context (BriefingTab passes calendar/email/task state).
//                      When omitted (cron), this function fetches today's calendar from MS Graph
//                      directly so the brief still includes TODAY'S CALENDAR.
//
// Idempotency:
//   - Returns cached brief if today's row exists AND !force
//   - Returns { skipped: "already_sent" } if send=true AND sent_at already populated AND !force
//
// Triggers:
//   - pg_cron 'morning-brief-daily' (Mon-Fri 20:30 UTC = 06:30 AEST) with body {"send": true}
//   - Dashboard BriefingTab (no `send`, with `context`)
//
// AI: Anthropic Claude Sonnet 4.5 only. No Lovable.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"
import { marked } from "https://esm.sh/marked@13"

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")
const MODEL = "claude-sonnet-4-5"
const MAX_TOKENS = 4096
const CONTEXT_WORD_BUDGET = 4000
// Sonnet 4.5 pricing per million tokens.
const PRICE_INPUT_PER_MTOK = 3.0
const PRICE_OUTPUT_PER_MTOK = 15.0

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!

const CRM_SUPABASE_URL = Deno.env.get("CRM_SUPABASE_URL")
const CRM_SUPABASE_ANON_KEY = Deno.env.get("CRM_SUPABASE_ANON_KEY")

const REVENUE_TARGET_AUD = 500_000
const AEST = "Australia/Brisbane"
const GRAPH = "https://graph.microsoft.com/v1.0"

// ─── System prompt baked in (was previously read from ai_prompts.chat). ──────
const SYSTEM_PROMPT = `You are Richard Palmer's world-class Chief of Staff and Executive Assistant.

CRITICAL: You will receive a block of LIVE CONTEXT (calendar, tasks, pipeline, email counts, etc.) appended below. You MUST use that data only. Never say "I don't have access to" calendar, tasks, or email. If the context says "None" or "No meetings today", say that; do not suggest connecting systems or granting access.

RICHARD'S IDENTITY
- Partner at Qurate Advisory — strategic M&A advisory for business exits and transitions, lower mid-market ($2M–$50M enterprise value)
- Also runs Alstonville Plants — horticulture business targeting $500k+ free cash
- Independent Director: Think Water Group
- Framework: EOS (Entrepreneurial Operating System) — Quarterly Rocks, L10 meetings, Scorecard
- Timezone: AEST (Brisbane, Australia)
- Revenue target: $500k AUD retainer revenue (Qurate Advisory)

YOUR ROLE
Act as a world-class EA and Chief of Staff. You know Richard's business deeply. You are proactive, direct, and prioritised. You surface what matters most, flag risks early, and give Richard one clear next action. You never waffle. You never pad. You treat Richard's time as the scarcest resource.

EISENHOWER FRAMEWORK
- Q1 (Do): Urgent + Important — act within 24–48 hours
- Q2 (Plan): Not urgent + Important — highest value work, protect this time
- Q3 (Delegate): Urgent + Not important — someone else handles this
- Q4 (Eliminate): Not urgent + Not important — ignore

RESPONSE RULES FOR MORNING BRIEF
1. Start with a one-paragraph situation summary — what matters most today, in plain English
2. Today's schedule — list meetings (or "No meetings today" if the context says so)
3. Revenue and pipeline status — progress vs $500k target, stalled deals, overdue revenue
4. Q1 priorities — tasks that need action today, with client context
5. Q2 focus recommendation — one specific block with time estimate
6. Risk flags — overdue follow-ups, overdue tasks, stalled deals, clients with no recent touchpoint, overdue scheduled revenue
7. One recommended first action — the single most important thing Richard should do right now
8. Use markdown. Be concise. No fluff. No generic advice.
9. NEVER say "I don't have access to..." — you have full context via the injected data. If a section is empty, report "None" or "No X today".`

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

// ─── Utilities ───────────────────────────────────────────────────────────────
function todayAESTISO(): string {
  // YYYY-MM-DD in Brisbane (AEST, no DST).
  return new Date().toLocaleDateString("en-CA", { timeZone: AEST })
}

function todayAESTBounds(): { startUTC: string; endUTC: string } {
  const today = todayAESTISO()
  const startUTC = new Date(today + "T00:00:00+10:00").toISOString()
  const endOfDay = new Date(today + "T00:00:00+10:00")
  endOfDay.setDate(endOfDay.getDate() + 1)
  const endUTC = endOfDay.toISOString()
  return { startUTC, endUTC }
}

function safeStr(v: unknown): string {
  if (v == null || v === "") return ""
  const s = String(v).trim()
  return s === "undefined" || s === "null" ? "" : s
}

function simpleChecksum(s: string): string {
  let h = 0
  for (let i = 0; i < Math.min(s.length, 500); i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).slice(-6)
}

function formatTime(d: { dateTime?: string; date?: string } | undefined): string {
  if (!d) return ""
  const s = d.dateTime ?? d.date
  if (!s) return ""
  return new Date(s).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", timeZone: AEST })
}

function formatDateOnly(iso: string | undefined): string {
  if (!iso) return ""
  return new Date(iso).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: AEST })
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) return ""
  return new Date(iso).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: AEST })
}

function getCurrentFYStartEnd(): { start: Date; end: Date } {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()
  const start = month >= 6 ? new Date(year, 5, 1) : new Date(year - 1, 5, 1)
  const end = month >= 6 ? new Date(year + 1, 5, 0) : new Date(year, 5, 0)
  return { start, end }
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length
}

// ─── Types ───────────────────────────────────────────────────────────────────
interface FrontendContext {
  todayEvents?: Array<{ subject?: string; start?: { dateTime?: string; date?: string }; location?: { displayName?: string }; organizer?: { emailAddress?: { name?: string } } }>
  upcomingEvents?: Array<{ subject?: string; start?: { dateTime?: string; date?: string }; location?: { displayName?: string }; organizer?: { emailAddress?: { name?: string } } }>
  unreadCount?: number
  q1Emails?: Array<{ subject?: string; from?: string }>
  vipContacts?: string[]
  tasks?: {
    q1?: Array<{ title?: string; client_name?: string; due_date?: string; estimated_minutes?: number }>
    q2?: Array<{ title?: string; client_name?: string; estimated_minutes?: number }>
    q3?: Array<{ title?: string; client_name?: string; delegated_to?: string }>
    overdue?: Array<{ title?: string; client_name?: string; due_date?: string }>
  }
  emails?: {
    unreadCount?: number
    q1Emails?: Array<{ subject?: string; from?: string; receivedDateTime?: string; bodyPreview?: string }>
    recentEmails?: Array<{ subject?: string; from?: string; receivedDateTime?: string; isRead?: boolean; ai_category?: string }>
  }
}

interface RequestBody {
  force?: boolean
  send?: boolean
  context?: FrontendContext
}

// ─── EA Data ─────────────────────────────────────────────────────────────────
async function fetchEAData(supabase: ReturnType<typeof createClient>) {
  const today = todayAESTISO()
  const [q1Res, q2Res, q3Res, overdueRes, followUpsRes, previousBriefRes] = await Promise.all([
    supabase.from("eisenhower_tasks").select("id, title, quadrant, client_name, due_date, estimated_minutes, status, delegated_to").eq("quadrant", "do").neq("status", "done"),
    supabase.from("eisenhower_tasks").select("id, title, quadrant, client_name, due_date, estimated_minutes, status, delegated_to").eq("quadrant", "schedule").neq("status", "done"),
    supabase.from("eisenhower_tasks").select("id, title, quadrant, client_name, due_date, estimated_minutes, status, delegated_to").eq("quadrant", "delegate").neq("status", "done"),
    supabase.from("eisenhower_tasks").select("id, title, quadrant, client_name, due_date, estimated_minutes, status, delegated_to").lt("due_date", today).neq("status", "done"),
    supabase.from("follow_ups").select("id, subject, recipient, recipient_name, days_overdue, sent_date").is("resolved_at", null).order("days_overdue", { ascending: false }).order("sent_date", { ascending: false }),
    supabase.from("ai_daily_briefs").select("brief_text, brief_date").lt("brief_date", today).order("brief_date", { ascending: false }).limit(1),
  ])

  type Task = { id?: string; title?: string; client_name?: string; due_date?: string; estimated_minutes?: number; status?: string; delegated_to?: string }
  const q1 = (q1Res.data ?? []) as Task[]
  const q2 = (q2Res.data ?? []) as Task[]
  const q3 = (q3Res.data ?? []) as Task[]
  const overdue = (overdueRes.data ?? []) as Task[]
  const followUps = (followUpsRes.data ?? []) as Array<{ id?: string; subject?: string; recipient?: string; recipient_name?: string; days_overdue?: number; sent_date?: string }>
  const prevRow = (previousBriefRes.data ?? [])[0] as { brief_text?: string } | undefined
  const previousBrief = prevRow?.brief_text ? prevRow.brief_text.slice(0, 500) : null

  return { q1, q2, q3, overdue, followUps, previousBrief }
}

// ─── CRM Data (optional) ─────────────────────────────────────────────────────
type CRMCompany = { id?: string; name?: string; company_type?: string; primary_contact_name?: string; contact_email?: string; archived_at?: string | null }
type CRMPipelineDeal = { id?: string; title?: string; value?: number; currency?: string; stage?: string; probability?: number; expected_close_date?: string; days_in_current_stage?: number; company_id?: string; companies?: { id?: string; name?: string } | null }
type CRMRevenueSchedule = { deal_id?: string; amount?: number; currency?: string; scheduled_date?: string; revenue_type?: string; is_realized?: boolean; realized_date?: string }
type CRMPipelineActivity = { deal_id?: string; activity_type?: string; description?: string; created_at?: string }

interface CRMData {
  clients: Array<{ name: string; primary_contact_name?: string; contact_email?: string }>
  prospects: Array<{ name: string; primary_contact_name?: string }>
  openDeals: Array<{ id?: string; title?: string; companies?: { name?: string } | null; value?: number; currency?: string; stage?: string; probability?: number; expected_close_date?: string; days_in_current_stage?: number }>
  revenueSchedules: CRMRevenueSchedule[]
  companyLastActivity: Array<{ companyName: string; created_at: string; activity_type?: string }>
}

async function fetchCRMData(): Promise<CRMData | null> {
  if (!CRM_SUPABASE_URL || !CRM_SUPABASE_ANON_KEY) return null
  const crm = createClient(CRM_SUPABASE_URL, CRM_SUPABASE_ANON_KEY)
  try {
    const companiesRes = await crm.from("companies").select("id, name, company_type, primary_contact_name, contact_email").is("archived_at", null).in("company_type", ["Client", "Prospect"])
    const companiesRaw = (companiesRes.data ?? []) as CRMCompany[]
    const seen = new Set<string>()
    const companies = companiesRaw.filter((c) => {
      if (!safeStr(c.name)) return false
      if (seen.has(c.id ?? "")) return false
      seen.add(c.id ?? "")
      return true
    })

    const clients = companies.filter((c) => c.company_type === "Client").map((c) => ({ name: safeStr(c.name) || "—", primary_contact_name: safeStr(c.primary_contact_name), contact_email: safeStr(c.contact_email) }))
    const prospects = companies.filter((c) => c.company_type === "Prospect").map((c) => ({ name: safeStr(c.name) || "—", primary_contact_name: safeStr(c.primary_contact_name) }))

    const dealsRes = await crm.from("pipeline_deals").select("id, title, value, currency, stage, probability, expected_close_date, days_in_current_stage, company_id, companies(id, name)").is("closed_at", null).order("value", { ascending: false })
    const openDealsRows = (dealsRes.data ?? []) as CRMPipelineDeal[]
    const openDealIds = openDealsRows.map((d) => d.id).filter(Boolean) as string[]
    const openDeals: CRMData["openDeals"] = []
    for (const d of openDealsRows) {
      const value = d.value != null ? Number(d.value) : null
      if (value == null || value === 0 || !safeStr(d.stage)) continue
      openDeals.push({ id: d.id, title: d.title, companies: d.companies, value, currency: d.currency, stage: d.stage, probability: d.probability, expected_close_date: d.expected_close_date, days_in_current_stage: d.days_in_current_stage })
    }

    const ninetyDaysAgo = new Date(); ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
    const ninetyDaysAgoIso = ninetyDaysAgo.toISOString().slice(0, 10)
    let revenueSchedules: CRMRevenueSchedule[] = []
    if (openDealIds.length > 0) {
      const schedRes = await crm.from("pipeline_revenue_schedules").select("deal_id, amount, currency, scheduled_date, revenue_type, is_realized, realized_date").in("deal_id", openDealIds).gte("scheduled_date", ninetyDaysAgoIso).order("scheduled_date", { ascending: true })
      revenueSchedules = (schedRes.data ?? []) as CRMRevenueSchedule[]
    }

    const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    const activitiesByDeal: Record<string, CRMPipelineActivity[]> = {}
    if (openDealIds.length > 0) {
      const actRes = await crm.from("pipeline_activities").select("deal_id, activity_type, description, created_at").in("deal_id", openDealIds).gte("created_at", thirtyDaysAgo.toISOString()).order("created_at", { ascending: false })
      const allActivities = (actRes.data ?? []) as CRMPipelineActivity[]
      allActivities.forEach((a) => {
        if (a.deal_id) (activitiesByDeal[a.deal_id] ??= []).push(a)
      })
      Object.keys(activitiesByDeal).forEach((dealId) => { activitiesByDeal[dealId] = activitiesByDeal[dealId].slice(0, 1) })
    }

    const companyToLatest: Record<string, { created_at: string; activity_type?: string }> = {}
    openDealsRows.forEach((d) => {
      const companyName = safeStr(d.companies?.name)
      if (!companyName) return
      const latest = (activitiesByDeal[d.id ?? ""] ?? [])[0]
      if (latest?.created_at) {
        const existing = companyToLatest[companyName]
        if (!existing || new Date(latest.created_at) > new Date(existing.created_at)) {
          companyToLatest[companyName] = { created_at: latest.created_at, activity_type: latest.activity_type }
        }
      }
    })
    const companyLastActivity = Object.entries(companyToLatest).map(([companyName, v]) => ({ companyName, created_at: v.created_at, activity_type: v.activity_type }))
    companyLastActivity.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    return { clients, prospects, openDeals, revenueSchedules, companyLastActivity }
  } catch (err) {
    console.warn("CRM fetch failed (non-fatal):", err)
    return null
  }
}

// ─── Calendar fetch (cron only) ──────────────────────────────────────────────
async function fetchTodayCalendarFromGraph(): Promise<FrontendContext["todayEvents"]> {
  try {
    const tokenRes = await fetch(`${SUPABASE_URL}/functions/v1/ms-auth`, {
      headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    })
    if (!tokenRes.ok) return []
    const tokenData = await tokenRes.json()
    const accessToken: string | undefined = tokenData.access_token
    if (!accessToken) return []

    const { startUTC, endUTC } = todayAESTBounds()
    const url = `${GRAPH}/me/calendarView?startDateTime=${encodeURIComponent(startUTC)}&endDateTime=${encodeURIComponent(endUTC)}&$select=id,subject,start,end,location,organizer,bodyPreview,isAllDay&$orderby=start/dateTime&$top=50`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="Australia/Brisbane"' } })
    if (!res.ok) return []
    const data = await res.json()
    return (data.value || []) as FrontendContext["todayEvents"]
  } catch (err) {
    console.warn("Calendar fetch failed (non-fatal):", err)
    return []
  }
}

// ─── Context block ───────────────────────────────────────────────────────────
type ContextTruncation = {
  previousBriefMaxChars?: number
  lastTouchpointOnlyOver14?: boolean
  q2Top?: number
  q3Top?: number
  emailTopUrgent?: number
  prospectsTop?: number
  pipelineMinDaysInStage?: number
}

function buildContextBlock(
  todayStr: string,
  frontend: FrontendContext | undefined,
  ea: Awaited<ReturnType<typeof fetchEAData>>,
  crm: Awaited<ReturnType<typeof fetchCRMData>>,
  truncation?: ContextTruncation
): string {
  const today = new Date()
  const todayAEST = todayAESTISO()
  const fourteenDaysAgo = new Date(today); fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14)
  const sections: string[] = []
  const skippedSections: string[] = []
  const t = truncation ?? {}

  function section(name: string, fn: () => string): void {
    try {
      const out = fn()
      if (out) sections.push(out)
    } catch (err) {
      console.error(`[buildContextBlock] ${name} failed:`, err)
      skippedSections.push(name)
    }
  }

  sections.push(
    `=== LIVE CONTEXT: TODAY IS ${todayStr} ===\n` +
    `Use ONLY the data below. Never say you don't have access to calendar, tasks, or email. If a section says "None" or "No meetings today", report that; do not suggest connecting or granting access.`
  )

  section("ACTIVE CLIENTS", () => {
    if (!crm || crm.clients.length === 0) return ""
    const lines = ["", "ACTIVE CLIENTS:"]
    crm.clients.forEach((c) => {
      const name = safeStr(c.name) || "—"
      const contact = safeStr(c.primary_contact_name) || "—"
      const email = safeStr(c.contact_email) || "—"
      lines.push(`- ${name} | Contact: ${contact} | ${email}`)
    })
    return lines.join("\n")
  })

  section("ACTIVE PROSPECTS", () => {
    if (!crm || crm.prospects.length === 0) return ""
    let list = crm.prospects
    if (t.prospectsTop != null && t.prospectsTop > 0 && crm.openDeals.length > 0) {
      const valueByCompany: Record<string, number> = {}
      crm.openDeals.forEach((d) => {
        const name = safeStr(d.companies?.name)
        if (name) valueByCompany[name] = (valueByCompany[name] ?? 0) + (d.value ?? 0)
      })
      list = [...list].sort((a, b) => (valueByCompany[b.name] ?? 0) - (valueByCompany[a.name] ?? 0)).slice(0, t.prospectsTop)
    }
    const lines = ["", "ACTIVE PROSPECTS:"]
    list.forEach((p) => lines.push(`- ${safeStr(p.name) || "—"} | Contact: ${safeStr(p.primary_contact_name) || "—"}`))
    return lines.join("\n")
  })

  section("REVENUE TRACKER", () => {
    const lines = ["", "REVENUE TRACKER (vs $500,000 AUD target):"]
    let realizedThisFY = 0, scheduledUpcoming = 0, overdueRevenue = 0
    const { start: fyStart, end: fyEnd } = getCurrentFYStartEnd()
    if (crm?.revenueSchedules) {
      for (const s of crm.revenueSchedules) {
        const amount = Number(s.amount)
        if (!amount || isNaN(amount) || (s.currency && s.currency !== "AUD")) continue
        if (s.is_realized && s.realized_date) {
          const d = new Date(s.realized_date)
          if (d >= fyStart && d <= fyEnd) realizedThisFY += amount
        } else if (s.scheduled_date) {
          const schedDateStr = s.scheduled_date.slice(0, 10)
          if (schedDateStr >= todayAEST) scheduledUpcoming += amount
          else overdueRevenue += amount
        }
      }
    }
    const gap = Math.max(0, REVENUE_TARGET_AUD - realizedThisFY)
    lines.push(realizedThisFY > 0 ? `- Realized this FY: $${realizedThisFY.toLocaleString()}` : "- Realized this FY: —")
    lines.push(scheduledUpcoming > 0 ? `- Scheduled upcoming: $${scheduledUpcoming.toLocaleString()}` : "- Scheduled upcoming: —")
    if (overdueRevenue > 0) lines.push(`- OVERDUE (not realized, scheduled_date < today): $${overdueRevenue.toLocaleString()} ⚠️ RISK`)
    lines.push(gap > 0 ? `- Gap to target: $${gap.toLocaleString()}` : "- Gap to target: —")
    return lines.join("\n")
  })

  section("PIPELINE", () => {
    if (!crm || crm.openDeals.length === 0) return ""
    let deals = crm.openDeals
    if (t.pipelineMinDaysInStage != null) deals = deals.filter((d) => (d.days_in_current_stage ?? 0) > t.pipelineMinDaysInStage!)
    const lines = ["", "PIPELINE:"]
    for (const d of deals) {
      const value = d.value && !isNaN(d.value) ? d.value : 0
      if (value === 0) continue
      const daysInStage = Math.min(999, Math.max(0, d.days_in_current_stage ?? 0))
      let flags = ""
      if (daysInStage > 30) flags += ` ⚠️ STALLED — ${daysInStage} days in stage`
      const closeStr = d.expected_close_date?.slice(0, 10) ?? ""
      if (closeStr && closeStr < todayAEST) flags += " ⚠️ OVERDUE CLOSE DATE"
      lines.push(`- ${safeStr(d.title) || "—"} | ${safeStr(d.companies?.name) || "—"} | $${value.toLocaleString()} ${safeStr(d.currency)} | Stage: ${safeStr(d.stage) || "—"} | ${d.probability ?? 0}% | Close: ${safeStr(d.expected_close_date) || "—"} | Days in stage: ${daysInStage}${flags}`)
    }
    return lines.join("\n")
  })

  section("LAST CLIENT TOUCHPOINT", () => {
    if (!crm || crm.companyLastActivity.length === 0) return ""
    let list = crm.companyLastActivity
    if (t.lastTouchpointOnlyOver14) list = list.filter((a) => new Date(a.created_at) < fourteenDaysAgo)
    const lines = ["", "LAST CLIENT TOUCHPOINT:"]
    list.forEach((a) => {
      const flag = new Date(a.created_at) < fourteenDaysAgo ? " ⚠️ NO CONTACT IN 14+ DAYS" : ""
      lines.push(`- ${a.companyName} | Last: ${formatDateTime(a.created_at)} | ${safeStr(a.activity_type) || "—"}${flag}`)
    })
    return lines.join("\n")
  })

  section("TODAY'S CALENDAR", () => {
    const todayEvents = frontend?.todayEvents ?? []
    const lines = ["", "TODAY'S CALENDAR:"]
    const filtered = todayEvents.filter((e) => {
      if (!safeStr(e.subject)) return false
      const isAllDay = !e.start?.dateTime
      if (isAllDay && !safeStr(e.location?.displayName) && !safeStr(e.organizer?.emailAddress?.name)) return false
      return true
    })
    filtered.forEach((e) => {
      const time = formatTime(e.start)
      const subj = safeStr(e.subject) || "(No subject)"
      const org = safeStr(e.organizer?.emailAddress?.name)
      const loc = safeStr(e.location?.displayName)
      lines.push(`- ${time} ${subj}${org ? ` with ${org}` : ""}${loc ? ` at ${loc}` : ""}`)
    })
    if (filtered.length === 0) lines.push("- No meetings today")
    return lines.join("\n")
  })

  section("Q1 TASKS", () => {
    const lines = ["", "Q1 TASKS — act today:"]
    const valid = ea.q1.filter((tk) => safeStr(tk.title))
    valid.forEach((tk) => lines.push(`- ${safeStr(tk.title) || "—"} | Client: ${safeStr(tk.client_name) || "—"} | Due: ${safeStr(tk.due_date) || "—"} | ${tk.estimated_minutes ?? "?"}min`))
    if (valid.length === 0) lines.push("- None")
    return lines.join("\n")
  })

  section("Q2 TASKS", () => {
    const lines = ["", "Q2 TASKS — schedule this week:"]
    let valid = ea.q2.filter((x) => safeStr(x.title))
    if (t.q2Top != null && t.q2Top > 0) valid = [...valid].sort((a, b) => (b.estimated_minutes ?? 0) - (a.estimated_minutes ?? 0)).slice(0, t.q2Top)
    valid.forEach((x) => lines.push(`- ${safeStr(x.title) || "—"} | Client: ${safeStr(x.client_name) || "—"} | ${x.estimated_minutes ?? "?"}min`))
    if (valid.length === 0) lines.push("- None")
    return lines.join("\n")
  })

  section("OVERDUE TASKS", () => {
    const lines = ["", "OVERDUE TASKS:"]
    const valid = ea.overdue.filter((tk) => safeStr(tk.title))
    valid.forEach((tk) => lines.push(`- ${safeStr(tk.title) || "—"} | Client: ${safeStr(tk.client_name) || "—"} | Was due: ${formatDateOnly(tk.due_date) || "—"} ⚠️`))
    if (valid.length === 0) lines.push("- None")
    return lines.join("\n")
  })

  section("Q3 TASKS", () => {
    const lines = ["", "Q3 TASKS — delegate:"]
    let valid = ea.q3.filter((x) => safeStr(x.title))
    if (t.q3Top != null && t.q3Top > 0) valid = valid.slice(0, t.q3Top)
    valid.forEach((x) => lines.push(`- ${safeStr(x.title) || "—"} | Client: ${safeStr(x.client_name) || "—"} | To: ${safeStr(x.delegated_to) || "—"}`))
    if (valid.length === 0) lines.push("- None")
    return lines.join("\n")
  })

  section("OVERDUE FOLLOW-UPS", () => {
    const lines = ["", `OVERDUE FOLLOW-UPS (${ea.followUps.length} total):`]
    const valid = ea.followUps.filter((f) => (f.days_overdue ?? 0) >= 0)
    valid.forEach((f) => lines.push(`- "${safeStr(f.subject) || "—"}" → ${safeStr(f.recipient_name) || safeStr(f.recipient) || "—"} — ${f.days_overdue ?? 0} days ⚠️`))
    if (valid.length === 0) lines.push("- None")
    return lines.join("\n")
  })

  section("EMAIL STATUS", () => {
    const unread = frontend?.unreadCount ?? frontend?.emails?.unreadCount ?? 0
    const q1Emails = frontend?.q1Emails ?? frontend?.emails?.q1Emails ?? []
    const topN = t.emailTopUrgent ?? 3
    const lines = ["", "EMAIL STATUS:"]
    lines.push(`- ${unread} unread | ${q1Emails.length} urgent (Q1)`)
    q1Emails.slice(0, topN).forEach((e) => lines.push(`- Top urgent: ${safeStr(e.subject) || "—"} from ${safeStr(e.from) || "—"}`))
    if (q1Emails.length === 0 && unread === 0) lines.push("- No unread / no Q1 emails")
    return lines.join("\n")
  })

  section("PREVIOUS BRIEF", () => {
    if (t.previousBriefMaxChars === 0 || !ea.previousBrief) return ""
    const text = t.previousBriefMaxChars != null && t.previousBriefMaxChars > 0
      ? ea.previousBrief.slice(0, t.previousBriefMaxChars) + (ea.previousBrief.length > t.previousBriefMaxChars ? "…" : "")
      : ea.previousBrief
    return ["", "PREVIOUS BRIEF (yesterday):", text].join("\n")
  })

  let out = sections.join("\n")
  if (skippedSections.length > 0) out += "\n\n[Warning: " + skippedSections.join(", ") + " could not be loaded]"
  return out
}

function applyTruncationUntilUnderBudget(
  todayStr: string,
  frontend: FrontendContext | undefined,
  ea: Awaited<ReturnType<typeof fetchEAData>>,
  crm: Awaited<ReturnType<typeof fetchCRMData>>
): string {
  const full = buildContextBlock(todayStr, frontend, ea, crm)
  if (wordCount(full) <= CONTEXT_WORD_BUDGET) return full
  const steps: ContextTruncation[] = [
    { previousBriefMaxChars: 200 },
    { previousBriefMaxChars: 0 },
    { previousBriefMaxChars: 0, lastTouchpointOnlyOver14: true },
    { previousBriefMaxChars: 0, lastTouchpointOnlyOver14: true, q2Top: 3 },
    { previousBriefMaxChars: 0, lastTouchpointOnlyOver14: true, q2Top: 3, q3Top: 3 },
    { previousBriefMaxChars: 0, lastTouchpointOnlyOver14: true, q2Top: 3, q3Top: 3, emailTopUrgent: 1 },
    { previousBriefMaxChars: 0, lastTouchpointOnlyOver14: true, q2Top: 3, q3Top: 3, emailTopUrgent: 1, prospectsTop: 5 },
    { previousBriefMaxChars: 0, lastTouchpointOnlyOver14: true, q2Top: 3, q3Top: 3, emailTopUrgent: 1, prospectsTop: 5, pipelineMinDaysInStage: 14 },
  ]
  let out = full
  for (const step of steps) {
    out = buildContextBlock(todayStr, frontend, ea, crm, step)
    if (wordCount(out) <= CONTEXT_WORD_BUDGET) break
  }
  out += "\n\n[Context trimmed to fit token budget. Full data available on request.]"
  return out
}

// ─── Email delivery ──────────────────────────────────────────────────────────
async function getMsAccessToken(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/ms-auth`, { headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` } })
  if (!res.ok) throw new Error(`ms-auth ${res.status}: ${await res.text()}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data.access_token as string
}

async function getUserEmail(accessToken: string): Promise<string> {
  const res = await fetch(`${GRAPH}/me?$select=mail,userPrincipalName`, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`/me ${res.status}: ${await res.text()}`)
  const me = await res.json()
  const email = me.mail || me.userPrincipalName
  if (!email) throw new Error("/me returned no email")
  return email as string
}

async function sendMail(accessToken: string, to: string, subject: string, html: string) {
  const body = {
    message: { subject, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }], importance: "high" },
    saveToSentItems: "true",
  }
  const res = await fetch(`${GRAPH}/me/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`sendMail ${res.status}: ${await res.text()}`)
}

function htmlEnvelope(innerHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; max-width: 680px; margin: 0 auto; padding: 24px; line-height: 1.55; color: #1f2937; }
  h1 { color: #0f172a; border-bottom: 2px solid #c19131; padding-bottom: 8px; margin-top: 0; }
  h2 { color: #c19131; margin-top: 28px; font-size: 16px; text-transform: uppercase; letter-spacing: 0.5px; }
  h3 { color: #0f172a; margin-top: 18px; }
  ul, ol { padding-left: 24px; }
  li { margin: 4px 0; }
  strong { color: #0f172a; }
  blockquote { margin: 16px 0; padding: 8px 14px; border-left: 3px solid #c19131; color: #475569; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
  code { background: #f1f5f9; padding: 1px 6px; border-radius: 3px; font-size: 13px; }
  table { border-collapse: collapse; margin: 12px 0; }
  td, th { padding: 6px 10px; border: 1px solid #e5e7eb; text-align: left; }
</style></head><body>${innerHtml}</body></html>`
}

// ─── Main handler ────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405)
  if (!ANTHROPIC_API_KEY) return jsonResponse({ error: "ANTHROPIC_API_KEY is not configured" }, 500)

  try {
    const body = await req.json().catch(() => ({})) as RequestBody
    const force = body?.force === true
    const send = body?.send === true

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const briefDate = todayAESTISO()

    // Idempotency check
    const { data: existing } = await sb.from("ai_daily_briefs").select("id, brief_text, sent_at, generated_at").eq("brief_date", briefDate).maybeSingle()
    const briefRow = existing as { id?: string; brief_text?: string; sent_at?: string | null; generated_at?: string } | null

    if (send && briefRow?.sent_at && !force) {
      return jsonResponse({ skipped: "already_sent", brief_date: briefDate, sent_at: briefRow.sent_at })
    }

    let briefText = briefRow?.brief_text ?? ""
    let isCached = false
    let generatedAt = briefRow?.generated_at ?? new Date().toISOString()
    let snapshot: Record<string, number> = {}

    const todayStr = new Date().toLocaleDateString("en-AU", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: AEST })

    // Generate if needed
    if (!briefText || force) {
      // For cron-triggered runs (no frontend context), enrich with today's calendar from MS Graph.
      let ctx = body?.context
      if (!ctx?.todayEvents) {
        const todayEvents = await fetchTodayCalendarFromGraph()
        ctx = { ...(ctx ?? {}), todayEvents }
      }

      const [eaData, crmData] = await Promise.all([fetchEAData(sb), fetchCRMData()])
      const contextBlock = applyTruncationUntilUnderBudget(todayStr, ctx, eaData, crmData)
      const userPrompt = "Generate my morning briefing."

      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT + "\n\n" + contextBlock,
          messages: [{ role: "user", content: userPrompt }],
        }),
      })
      const aiData = await aiRes.json().catch(() => ({}))
      if (!aiRes.ok) {
        const errMsg = aiData?.error?.message || aiData?.message || aiRes.statusText || "Anthropic API error"
        throw new Error(`Anthropic ${aiRes.status}: ${errMsg}`)
      }
      briefText = aiData?.content?.[0]?.text ?? ""
      if (!briefText) throw new Error("Anthropic returned empty brief")

      generatedAt = new Date().toISOString()
      const checksum = simpleChecksum(briefText)
      snapshot = {
        q1Tasks: eaData.q1.length, q2Tasks: eaData.q2.length, q3Tasks: eaData.q3.length,
        overdueTasks: eaData.overdue.length, followUps: eaData.followUps.length,
        clients: crmData?.clients.length ?? 0, prospects: crmData?.prospects.length ?? 0,
        openDeals: crmData?.openDeals.length ?? 0,
        calendarEvents: ctx.todayEvents?.length ?? 0,
      }

      // Cost log
      const inputTokens = aiData?.usage?.input_tokens ?? 0
      const outputTokens = aiData?.usage?.output_tokens ?? 0
      const cost = (inputTokens * PRICE_INPUT_PER_MTOK + outputTokens * PRICE_OUTPUT_PER_MTOK) / 1_000_000
      await sb.from("api_cost_log").insert({
        operation: "morning_brief",
        model: MODEL,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        estimated_cost: cost,
      })

      // Persist
      if (briefRow?.id) {
        await sb.from("ai_daily_briefs").update({
          brief_text: briefText, generated_at: generatedAt, source_gate: "morning_brief_v1",
          is_final: true, checksum,
        }).eq("id", briefRow.id)
      } else {
        await sb.from("ai_daily_briefs").insert({
          brief_date: briefDate, brief_text: briefText, source_gate: "morning_brief_v1",
          generated_at: generatedAt, is_final: true, checksum,
        })
      }
      isCached = false
    } else {
      isCached = true
    }

    // Send if asked
    let sentTo: string | null = null
    let sentAt: string | null = briefRow?.sent_at ?? null
    if (send) {
      const accessToken = await getMsAccessToken()
      const userEmail = await getUserEmail(accessToken)
      const innerHtml = await marked.parse(briefText)
      const fullHtml = htmlEnvelope(innerHtml as string)
      const dateLabel = new Date(briefDate + "T00:00:00").toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
      await sendMail(accessToken, userEmail, `Daily Brief — ${dateLabel}`, fullHtml)
      sentAt = new Date().toISOString()
      sentTo = userEmail
      await sb.from("ai_daily_briefs").update({ sent_at: sentAt }).eq("brief_date", briefDate)
    }

    return jsonResponse({
      brief: briefText,
      brief_date: briefDate,
      generated_at: generatedAt,
      is_cached: isCached,
      sent_to: sentTo,
      sent_at: sentAt,
      data_snapshot: snapshot,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("morning-brief error:", msg)
    return jsonResponse({ error: msg }, 500)
  }
})
