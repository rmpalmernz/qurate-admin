// nudge-engine — evaluates rules over the live intelligence and dispatches Web Push
// nudges for the few things that genuinely need Richard right now (Epic C).
//
// Rules: cold follow-ups · stalled deals · overdue scheduled revenue · Q1 tasks due/overdue.
// Fatigue controls: AEST quiet hours (07:00–19:00 only), focus-block suppression (high
// severity only), per-rule cooldowns via nudge_log, and a hard cap per run. Suppressed
// items are never lost — they remain in the Action Queue and the daily brief.
//
// Delivery is delegated to the send-push function (single VAPID implementation).
// Idempotency: nudge_log dedup_key + cooldown window.
//
// Trigger: pg_cron every 30 min (gating is done in-function against AEST).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!
const CRM_SUPABASE_URL = Deno.env.get("CRM_SUPABASE_URL")
const CRM_SUPABASE_ANON_KEY = Deno.env.get("CRM_SUPABASE_ANON_KEY")

const AEST = "Australia/Brisbane"
const QUIET_START_MIN = 7 * 60   // 07:00 AEST
const QUIET_END_MIN = 19 * 60    // 19:00 AEST
const MAX_PER_RUN = 3            // hard cap; extras defer to next run / brief
const DEDUP_LOOKBACK_HOURS = 72

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } })
}

type Severity = "high" | "medium"
interface Nudge { dedupKey: string; rule: string; severity: Severity; rank: number; title: string; body: string; url: string; cooldownHours: number }

function todayAESTISO(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: AEST })
}

// Current AEST time-of-day in minutes + weekday (1=Mon..7=Sun).
function aestClock(): { minutes: number; isWeekday: boolean } {
  const now = new Date()
  const hhmm = now.toLocaleTimeString("en-GB", { timeZone: AEST, hour: "2-digit", minute: "2-digit", hour12: false })
  const [h, m] = hhmm.split(":").map(Number)
  const wd = now.toLocaleDateString("en-US", { timeZone: AEST, weekday: "short" })
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(wd)
  return { minutes: h * 60 + m, isWeekday }
}

function parseHHMMtoMin(v: unknown): number | null {
  const s = typeof v === "string" ? v : ""
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

async function getFocusWindow(sb: ReturnType<typeof createClient>): Promise<{ start: number | null; end: number | null }> {
  const { data } = await sb.from("user_preferences").select("key, value").in("key", ["focus_start", "focus_end"])
  const rows = (data ?? []) as Array<{ key: string; value: unknown }>
  const get = (k: string) => rows.find(r => r.key === k)?.value
  return { start: parseHHMMtoMin(get("focus_start")), end: parseHHMMtoMin(get("focus_end")) }
}

// ─── Rule evaluation ─────────────────────────────────────────────────────────
async function evaluateRules(sb: ReturnType<typeof createClient>): Promise<Nudge[]> {
  const today = todayAESTISO()
  const out: Nudge[] = []

  // 1. Cold follow-ups (>=3 days overdue, unresolved).
  const { data: fuData } = await sb
    .from("follow_ups")
    .select("id, subject, recipient, recipient_name, days_overdue")
    .is("resolved_at", null)
    .gte("days_overdue", 3)
    .order("days_overdue", { ascending: false })
  for (const f of (fuData ?? []) as Array<{ id: string; subject?: string; recipient?: string; recipient_name?: string; days_overdue?: number }>) {
    const days = f.days_overdue ?? 0
    const who = f.recipient_name || f.recipient || "someone"
    out.push({
      dedupKey: `followup:${f.id}`, rule: "cold_followup",
      severity: days >= 5 ? "high" : "medium", rank: days,
      title: "Follow-up gone cold", body: `Chase ${who}: "${f.subject || "(no subject)"}" — ${days}d overdue`,
      url: "/dashboard?tab=today", cooldownHours: 24,
    })
  }

  // 2. Q1 tasks due today or overdue.
  const { data: taskData } = await sb
    .from("eisenhower_tasks")
    .select("id, title, client_name, due_date, quadrant, status")
    .eq("quadrant", "do").neq("status", "done").not("due_date", "is", null).lte("due_date", today)
  for (const tk of (taskData ?? []) as Array<{ id: string; title?: string; client_name?: string; due_date?: string }>) {
    const overdue = (tk.due_date ?? today) < today
    out.push({
      dedupKey: `task:${tk.id}`, rule: "q1_task",
      severity: overdue ? "high" : "medium", rank: overdue ? 100 : 50,
      title: overdue ? "Q1 task overdue" : "Q1 task due today",
      body: `${tk.title || "(untitled)"}${tk.client_name ? ` · ${tk.client_name}` : ""}`,
      url: "/dashboard?tab=today", cooldownHours: 24,
    })
  }

  // 3 + 4. CRM: stalled deals + overdue scheduled revenue.
  if (CRM_SUPABASE_URL && CRM_SUPABASE_ANON_KEY) {
    try {
      const crm = createClient(CRM_SUPABASE_URL, CRM_SUPABASE_ANON_KEY)
      const { data: deals } = await crm
        .from("pipeline_deals")
        .select("id, title, stage, days_in_current_stage, value, company_id, companies(name)")
        .is("closed_at", null)
      const dealRows = (deals ?? []) as Array<{ id: string; title?: string; stage?: string; days_in_current_stage?: number; value?: number; companies?: { name?: string } | null }>
      for (const d of dealRows) {
        const days = d.days_in_current_stage ?? 0
        if (days > 30) {
          out.push({
            dedupKey: `stalled:${d.id}`, rule: "stalled_deal",
            severity: days > 60 ? "high" : "medium", rank: days,
            title: "Deal stalled", body: `${d.companies?.name || d.title || "Deal"} — ${days}d in ${d.stage || "stage"}`,
            url: "/dashboard?tab=today", cooldownHours: 72,
          })
        }
      }

      const openIds = dealRows.map(d => d.id).filter(Boolean)
      if (openIds.length > 0) {
        const { data: sched } = await crm
          .from("pipeline_revenue_schedules")
          .select("deal_id, amount, currency, scheduled_date, is_realized")
          .in("deal_id", openIds)
          .eq("is_realized", false)
          .lt("scheduled_date", today)
        const byDeal: Record<string, number> = {}
        for (const s of (sched ?? []) as Array<{ deal_id: string; amount?: number; currency?: string; scheduled_date?: string }>) {
          const amt = Number(s.amount)
          if (!amt || isNaN(amt)) continue
          byDeal[s.deal_id] = (byDeal[s.deal_id] ?? 0) + amt
        }
        for (const [dealId, amt] of Object.entries(byDeal)) {
          const name = dealRows.find(d => d.id === dealId)?.companies?.name || "a deal"
          out.push({
            dedupKey: `revenue:${dealId}`, rule: "overdue_revenue",
            severity: "high", rank: 90,
            title: "Revenue overdue", body: `$${amt.toLocaleString()} scheduled but not realised — ${name}`,
            url: "/dashboard?tab=today", cooldownHours: 72,
          })
        }
      }
    } catch (err) {
      console.warn("nudge-engine CRM rules failed (non-fatal):", err)
    }
  }

  return out
}

async function dispatch(n: Nudge): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: n.title, body: n.body, url: n.url, tag: n.dedupKey }),
    })
    return res.ok
  } catch (err) {
    console.error("dispatch failed:", err)
    return false
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })

  try {
    const body = await req.json().catch(() => ({})) as { force?: boolean }
    const force = body?.force === true
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // ─── Quiet-hours / weekday gate (skippable with force) ───────────────────
    const { minutes, isWeekday } = aestClock()
    const inActiveWindow = minutes >= QUIET_START_MIN && minutes < QUIET_END_MIN
    if (!force && (!isWeekday || !inActiveWindow)) {
      return jsonResponse({ skipped: "quiet_hours", aest_minutes: minutes, is_weekday: isWeekday })
    }

    const focus = await getFocusWindow(sb)
    const inFocusBlock = focus.start != null && focus.end != null && minutes >= focus.start && minutes < focus.end

    // ─── Evaluate + severity gate ────────────────────────────────────────────
    let candidates = await evaluateRules(sb)
    if (inFocusBlock && !force) candidates = candidates.filter(c => c.severity === "high")
    if (candidates.length === 0) return jsonResponse({ sent: 0, reason: "no_candidates", in_focus_block: inFocusBlock })

    // ─── Dedup against recent nudge_log ──────────────────────────────────────
    const sinceIso = new Date(Date.now() - DEDUP_LOOKBACK_HOURS * 3600_000).toISOString()
    const { data: recent } = await sb.from("nudge_log").select("dedup_key, created_at").gte("created_at", sinceIso)
    const lastSent = new Map<string, number>()
    for (const r of (recent ?? []) as Array<{ dedup_key: string; created_at: string }>) {
      const t = new Date(r.created_at).getTime()
      if (!lastSent.has(r.dedup_key) || t > lastSent.get(r.dedup_key)!) lastSent.set(r.dedup_key, t)
    }
    const fresh = candidates.filter(c => {
      if (force) return true
      const last = lastSent.get(c.dedupKey)
      return last == null || (Date.now() - last) >= c.cooldownHours * 3600_000
    })
    if (fresh.length === 0) return jsonResponse({ sent: 0, reason: "all_on_cooldown", candidates: candidates.length })

    // ─── Prioritise + cap ────────────────────────────────────────────────────
    const sevWeight = (s: Severity) => (s === "high" ? 1000 : 0)
    fresh.sort((a, b) => (sevWeight(b.severity) + b.rank) - (sevWeight(a.severity) + a.rank))
    const toSend = fresh.slice(0, MAX_PER_RUN)
    const deferred = fresh.length - toSend.length

    const results: Array<{ dedupKey: string; ok: boolean }> = []
    for (const n of toSend) {
      const ok = await dispatch(n)
      results.push({ dedupKey: n.dedupKey, ok })
      if (ok) {
        await sb.from("nudge_log").insert({ dedup_key: n.dedupKey, rule: n.rule, title: n.title, body: n.body, url: n.url })
      }
    }

    return jsonResponse({
      sent: results.filter(r => r.ok).length,
      attempted: toSend.length,
      deferred,
      in_focus_block: inFocusBlock,
      results,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("nudge-engine error:", msg)
    return jsonResponse({ error: msg }, 500)
  }
})
