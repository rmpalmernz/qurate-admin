// chat — conversational EA/CoS assistant. Anthropic Claude Sonnet 4.5.
//
// Brief generation has moved out of this function into morning-brief. This is now a
// pure Q&A assistant that answers general questions with EA + CRM context injected.
//
// Reads the active 'chat' system prompt from public.ai_prompts and prepends a LIVE
// CONTEXT block built from EA tasks/follow-ups and (optionally) CRM data.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")
const MODEL = "claude-sonnet-4-5"
const MAX_TOKENS = 4096
const CONTEXT_WORD_BUDGET = 4000

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const CRM_SUPABASE_URL = Deno.env.get("CRM_SUPABASE_URL")
const CRM_SUPABASE_ANON_KEY = Deno.env.get("CRM_SUPABASE_ANON_KEY")

const REVENUE_TARGET_AUD = 500_000
const AEST = "Australia/Brisbane"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } })
}

interface IncomingMessage { role?: "user" | "assistant"; content?: string }

interface FrontendContext {
  todayEvents?: Array<{ subject?: string; start?: { dateTime?: string; date?: string }; location?: { displayName?: string }; organizer?: { emailAddress?: { name?: string } } }>
  unreadCount?: number
  q1Emails?: Array<{ subject?: string; from?: string }>
  vipContacts?: string[]
  tasks?: { q1?: Array<{ title?: string; client_name?: string; due_date?: string; estimated_minutes?: number }>; q2?: Array<{ title?: string; client_name?: string; estimated_minutes?: number }>; q3?: Array<{ title?: string; client_name?: string; delegated_to?: string }>; overdue?: Array<{ title?: string; client_name?: string; due_date?: string }> }
  emails?: { unreadCount?: number; q1Emails?: Array<{ subject?: string; from?: string; receivedDateTime?: string; bodyPreview?: string }>; recentEmails?: Array<{ subject?: string; from?: string; receivedDateTime?: string; isRead?: boolean; ai_category?: string }> }
}

interface RequestBody { message?: string; messages?: IncomingMessage[]; context?: FrontendContext }

function todayAESTISO(): string { return new Date().toLocaleDateString("en-CA", { timeZone: AEST }) }

function safeStr(v: unknown): string {
  if (v == null || v === "") return ""
  const s = String(v).trim()
  return s === "undefined" || s === "null" ? "" : s
}

function formatTime(d: { dateTime?: string; date?: string } | undefined): string {
  if (!d) return ""; const s = d.dateTime ?? d.date; if (!s) return ""
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
  const now = new Date(); const year = now.getFullYear(); const month = now.getMonth()
  const start = month >= 6 ? new Date(year, 5, 1) : new Date(year - 1, 5, 1)
  const end = month >= 6 ? new Date(year + 1, 5, 0) : new Date(year, 5, 0)
  return { start, end }
}
function wordCount(s: string): number { return s.split(/\s+/).filter(Boolean).length }

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
  return {
    q1: (q1Res.data ?? []) as Task[],
    q2: (q2Res.data ?? []) as Task[],
    q3: (q3Res.data ?? []) as Task[],
    overdue: (overdueRes.data ?? []) as Task[],
    followUps: (followUpsRes.data ?? []) as Array<{ id?: string; subject?: string; recipient?: string; recipient_name?: string; days_overdue?: number; sent_date?: string }>,
    previousBrief: ((previousBriefRes.data ?? [])[0] as { brief_text?: string } | undefined)?.brief_text?.slice(0, 500) ?? null,
  }
}

async function fetchChatPrompt(supabase: ReturnType<typeof createClient>): Promise<string | null> {
  const { data } = await supabase.from("ai_prompts").select("system_prompt").eq("prompt_name", "chat").eq("is_active", true).order("updated_at", { ascending: false }).limit(1)
  return ((data ?? [])[0] as { system_prompt?: string } | undefined)?.system_prompt ?? null
}

type CRMCompany = { id?: string; name?: string; company_type?: string; primary_contact_name?: string; contact_email?: string }
type CRMPipelineDeal = { id?: string; title?: string; value?: number; currency?: string; stage?: string; probability?: number; expected_close_date?: string; days_in_current_stage?: number; companies?: { id?: string; name?: string } | null }
type CRMRevenueSchedule = { deal_id?: string; amount?: number; currency?: string; scheduled_date?: string; is_realized?: boolean; realized_date?: string }
type CRMPipelineActivity = { deal_id?: string; activity_type?: string; created_at?: string }

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
    const companies = companiesRaw.filter((c) => { if (!safeStr(c.name)) return false; if (seen.has(c.id ?? "")) return false; seen.add(c.id ?? ""); return true })
    const clients = companies.filter((c) => c.company_type === "Client").map((c) => ({ name: safeStr(c.name) || "—", primary_contact_name: safeStr(c.primary_contact_name), contact_email: safeStr(c.contact_email) }))
    const prospects = companies.filter((c) => c.company_type === "Prospect").map((c) => ({ name: safeStr(c.name) || "—", primary_contact_name: safeStr(c.primary_contact_name) }))

    const dealsRes = await crm.from("pipeline_deals").select("id, title, value, currency, stage, probability, expected_close_date, days_in_current_stage, companies(id, name)").is("closed_at", null).order("value", { ascending: false })
    const openDealsRows = (dealsRes.data ?? []) as CRMPipelineDeal[]
    const openDealIds = openDealsRows.map((d) => d.id).filter(Boolean) as string[]
    const openDeals: CRMData["openDeals"] = []
    for (const d of openDealsRows) {
      const value = d.value != null ? Number(d.value) : null
      if (value == null || value === 0 || !safeStr(d.stage)) continue
      openDeals.push({ id: d.id, title: d.title, companies: d.companies, value, currency: d.currency, stage: d.stage, probability: d.probability, expected_close_date: d.expected_close_date, days_in_current_stage: d.days_in_current_stage })
    }

    const ninetyDaysAgo = new Date(); ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
    let revenueSchedules: CRMRevenueSchedule[] = []
    if (openDealIds.length > 0) {
      const schedRes = await crm.from("pipeline_revenue_schedules").select("deal_id, amount, currency, scheduled_date, is_realized, realized_date").in("deal_id", openDealIds).gte("scheduled_date", ninetyDaysAgo.toISOString().slice(0, 10))
      revenueSchedules = (schedRes.data ?? []) as CRMRevenueSchedule[]
    }

    const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    const activitiesByDeal: Record<string, CRMPipelineActivity[]> = {}
    if (openDealIds.length > 0) {
      const actRes = await crm.from("pipeline_activities").select("deal_id, activity_type, created_at").in("deal_id", openDealIds).gte("created_at", thirtyDaysAgo.toISOString()).order("created_at", { ascending: false })
      const allActivities = (actRes.data ?? []) as CRMPipelineActivity[]
      allActivities.forEach((a) => { if (a.deal_id) (activitiesByDeal[a.deal_id] ??= []).push(a) })
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

type ContextTruncation = { previousBriefMaxChars?: number; lastTouchpointOnlyOver14?: boolean; q2Top?: number; q3Top?: number; emailTopUrgent?: number; prospectsTop?: number; pipelineMinDaysInStage?: number }

function buildContextBlock(todayStr: string, frontend: FrontendContext | undefined, ea: Awaited<ReturnType<typeof fetchEAData>>, crm: Awaited<ReturnType<typeof fetchCRMData>>, truncation?: ContextTruncation): string {
  const today = new Date()
  const todayAEST = todayAESTISO()
  const fourteenDaysAgo = new Date(today); fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14)
  const sections: string[] = []
  const skippedSections: string[] = []
  const t = truncation ?? {}
  function section(name: string, fn: () => string): void { try { const out = fn(); if (out) sections.push(out) } catch (err) { console.error(`[buildContextBlock] ${name} failed:`, err); skippedSections.push(name) } }

  sections.push(`=== LIVE CONTEXT: TODAY IS ${todayStr} ===\nUse ONLY the data below. Never say you don't have access to calendar, tasks, or email. If a section says "None" or "No meetings today", report that; do not suggest connecting or granting access.`)

  section("ACTIVE CLIENTS", () => { if (!crm || crm.clients.length === 0) return ""; const lines = ["", "ACTIVE CLIENTS:"]; crm.clients.forEach((c) => lines.push(`- ${safeStr(c.name) || "—"} | Contact: ${safeStr(c.primary_contact_name) || "—"} | ${safeStr(c.contact_email) || "—"}`)); return lines.join("\n") })
  section("ACTIVE PROSPECTS", () => {
    if (!crm || crm.prospects.length === 0) return ""
    let list = crm.prospects
    if (t.prospectsTop != null && t.prospectsTop > 0 && crm.openDeals.length > 0) {
      const valueByCompany: Record<string, number> = {}
      crm.openDeals.forEach((d) => { const name = safeStr(d.companies?.name); if (name) valueByCompany[name] = (valueByCompany[name] ?? 0) + (d.value ?? 0) })
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
        if (s.is_realized && s.realized_date) { const d = new Date(s.realized_date); if (d >= fyStart && d <= fyEnd) realizedThisFY += amount }
        else if (s.scheduled_date) { const sd = s.scheduled_date.slice(0, 10); if (sd >= todayAEST) scheduledUpcoming += amount; else overdueRevenue += amount }
      }
    }
    const gap = Math.max(0, REVENUE_TARGET_AUD - realizedThisFY)
    lines.push(realizedThisFY > 0 ? `- Realized this FY: $${realizedThisFY.toLocaleString()}` : "- Realized this FY: —")
    lines.push(scheduledUpcoming > 0 ? `- Scheduled upcoming: $${scheduledUpcoming.toLocaleString()}` : "- Scheduled upcoming: —")
    if (overdueRevenue > 0) lines.push(`- OVERDUE: $${overdueRevenue.toLocaleString()} ⚠️ RISK`)
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
      if (daysInStage > 30) flags += ` ⚠️ STALLED — ${daysInStage} days`
      const closeStr = d.expected_close_date?.slice(0, 10) ?? ""
      if (closeStr && closeStr < todayAEST) flags += " ⚠️ OVERDUE CLOSE"
      lines.push(`- ${safeStr(d.title) || "—"} | ${safeStr(d.companies?.name) || "—"} | $${value.toLocaleString()} ${safeStr(d.currency)} | ${safeStr(d.stage) || "—"} | ${d.probability ?? 0}%${flags}`)
    }
    return lines.join("\n")
  })
  section("LAST CLIENT TOUCHPOINT", () => {
    if (!crm || crm.companyLastActivity.length === 0) return ""
    let list = crm.companyLastActivity
    if (t.lastTouchpointOnlyOver14) list = list.filter((a) => new Date(a.created_at) < fourteenDaysAgo)
    const lines = ["", "LAST CLIENT TOUCHPOINT:"]
    list.forEach((a) => { const flag = new Date(a.created_at) < fourteenDaysAgo ? " ⚠️ NO CONTACT IN 14+ DAYS" : ""; lines.push(`- ${a.companyName} | ${formatDateTime(a.created_at)} | ${safeStr(a.activity_type) || "—"}${flag}`) })
    return lines.join("\n")
  })
  section("TODAY'S CALENDAR", () => {
    const todayEvents = frontend?.todayEvents ?? []
    const lines = ["", "TODAY'S CALENDAR:"]
    const filtered = todayEvents.filter((e) => { if (!safeStr(e.subject)) return false; const isAllDay = !e.start?.dateTime; if (isAllDay && !safeStr(e.location?.displayName) && !safeStr(e.organizer?.emailAddress?.name)) return false; return true })
    filtered.forEach((e) => { const time = formatTime(e.start); const subj = safeStr(e.subject) || "(No subject)"; const org = safeStr(e.organizer?.emailAddress?.name); const loc = safeStr(e.location?.displayName); lines.push(`- ${time} ${subj}${org ? ` with ${org}` : ""}${loc ? ` at ${loc}` : ""}`) })
    if (filtered.length === 0) lines.push("- No meetings today")
    return lines.join("\n")
  })
  section("Q1 TASKS", () => { const lines = ["", "Q1 TASKS — act today:"]; const valid = ea.q1.filter((tk) => safeStr(tk.title)); valid.forEach((tk) => lines.push(`- ${safeStr(tk.title) || "—"} | Client: ${safeStr(tk.client_name) || "—"} | Due: ${safeStr(tk.due_date) || "—"} | ${tk.estimated_minutes ?? "?"}min`)); if (valid.length === 0) lines.push("- None"); return lines.join("\n") })
  section("Q2 TASKS", () => { const lines = ["", "Q2 TASKS — schedule this week:"]; let valid = ea.q2.filter((x) => safeStr(x.title)); if (t.q2Top != null && t.q2Top > 0) valid = [...valid].sort((a, b) => (b.estimated_minutes ?? 0) - (a.estimated_minutes ?? 0)).slice(0, t.q2Top); valid.forEach((x) => lines.push(`- ${safeStr(x.title) || "—"} | Client: ${safeStr(x.client_name) || "—"} | ${x.estimated_minutes ?? "?"}min`)); if (valid.length === 0) lines.push("- None"); return lines.join("\n") })
  section("OVERDUE TASKS", () => { const lines = ["", "OVERDUE TASKS:"]; const valid = ea.overdue.filter((tk) => safeStr(tk.title)); valid.forEach((tk) => lines.push(`- ${safeStr(tk.title) || "—"} | Client: ${safeStr(tk.client_name) || "—"} | Was due: ${formatDateOnly(tk.due_date) || "—"} ⚠️`)); if (valid.length === 0) lines.push("- None"); return lines.join("\n") })
  section("Q3 TASKS", () => { const lines = ["", "Q3 TASKS — delegate:"]; let valid = ea.q3.filter((x) => safeStr(x.title)); if (t.q3Top != null && t.q3Top > 0) valid = valid.slice(0, t.q3Top); valid.forEach((x) => lines.push(`- ${safeStr(x.title) || "—"} | Client: ${safeStr(x.client_name) || "—"} | To: ${safeStr(x.delegated_to) || "—"}`)); if (valid.length === 0) lines.push("- None"); return lines.join("\n") })
  section("OVERDUE FOLLOW-UPS", () => { const lines = ["", `OVERDUE FOLLOW-UPS (${ea.followUps.length} total):`]; const valid = ea.followUps.filter((f) => (f.days_overdue ?? 0) >= 0); valid.forEach((f) => lines.push(`- "${safeStr(f.subject) || "—"}" → ${safeStr(f.recipient_name) || safeStr(f.recipient) || "—"} — ${f.days_overdue ?? 0} days ⚠️`)); if (valid.length === 0) lines.push("- None"); return lines.join("\n") })
  section("EMAIL STATUS", () => { const unread = frontend?.unreadCount ?? frontend?.emails?.unreadCount ?? 0; const q1Emails = frontend?.q1Emails ?? frontend?.emails?.q1Emails ?? []; const topN = t.emailTopUrgent ?? 3; const lines = ["", "EMAIL STATUS:", `- ${unread} unread | ${q1Emails.length} urgent (Q1)`]; q1Emails.slice(0, topN).forEach((e) => lines.push(`- Top urgent: ${safeStr(e.subject) || "—"} from ${safeStr(e.from) || "—"}`)); if (q1Emails.length === 0 && unread === 0) lines.push("- No unread / no Q1 emails"); return lines.join("\n") })
  section("PREVIOUS BRIEF", () => { if (t.previousBriefMaxChars === 0 || !ea.previousBrief) return ""; const text = t.previousBriefMaxChars != null && t.previousBriefMaxChars > 0 ? ea.previousBrief.slice(0, t.previousBriefMaxChars) + (ea.previousBrief.length > t.previousBriefMaxChars ? "…" : "") : ea.previousBrief; return ["", "PREVIOUS BRIEF (yesterday):", text].join("\n") })

  let out = sections.join("\n")
  if (skippedSections.length > 0) out += "\n\n[Warning: " + skippedSections.join(", ") + " could not be loaded]"
  return out
}

function applyTruncationUntilUnderBudget(todayStr: string, frontend: FrontendContext | undefined, ea: Awaited<ReturnType<typeof fetchEAData>>, crm: Awaited<ReturnType<typeof fetchCRMData>>): string {
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
  for (const step of steps) { out = buildContextBlock(todayStr, frontend, ea, crm, step); if (wordCount(out) <= CONTEXT_WORD_BUDGET) break }
  out += "\n\n[Context trimmed to fit token budget. Full data available on request.]"
  return out
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405)
  if (!ANTHROPIC_API_KEY) return jsonResponse({ error: "ANTHROPIC_API_KEY is not configured" }, 500)

  try {
    const body = (await req.json()) as RequestBody
    const message = typeof body?.message === "string" ? body.message.trim() : ""
    const rawMessages = Array.isArray(body?.messages) ? body.messages : []
    const context = body?.context

    if (!message && rawMessages.length === 0) return jsonResponse({ error: "message or messages required" }, 400)

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const chatPrompt = await fetchChatPrompt(sb)
    if (!chatPrompt) return jsonResponse({ error: "System prompt not configured. Add an active record to ai_prompts where prompt_name = 'chat'." }, 500)

    const todayStr = new Date().toLocaleDateString("en-AU", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: AEST })
    const [eaData, crmData] = await Promise.all([fetchEAData(sb), fetchCRMData()])
    const contextBlock = applyTruncationUntilUnderBudget(todayStr, context, eaData, crmData)
    const systemPrompt = chatPrompt + "\n\n" + contextBlock

    const anthropicMessages: { role: "user" | "assistant"; content: string }[] = []
    for (const m of rawMessages) {
      const role = m?.role === "assistant" ? "assistant" : "user"
      const content = typeof m?.content === "string" ? m.content.trim() : ""
      if (content) anthropicMessages.push({ role, content })
    }
    if (message && (anthropicMessages.length === 0 || anthropicMessages[anthropicMessages.length - 1].content !== message)) {
      anthropicMessages.push({ role: "user", content: message })
    }
    if (anthropicMessages.length === 0) return jsonResponse({ error: "No valid messages" }, 400)

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: systemPrompt, messages: anthropicMessages }),
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const errMsg = data?.error?.message ?? data?.message ?? res.statusText ?? "Anthropic API error"
      return jsonResponse({ error: errMsg }, res.status >= 400 ? res.status : 500)
    }
    const text = data?.content?.[0]?.text ?? ""

    // Cost log
    const inputTokens = data?.usage?.input_tokens ?? 0
    const outputTokens = data?.usage?.output_tokens ?? 0
    const cost = (inputTokens * 3 + outputTokens * 15) / 1_000_000
    await sb.from("api_cost_log").insert({ operation: "chat", model: MODEL, input_tokens: inputTokens, output_tokens: outputTokens, estimated_cost: cost })

    return jsonResponse({ response: text, message: text })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return jsonResponse({ error: msg }, 500)
  }
})
