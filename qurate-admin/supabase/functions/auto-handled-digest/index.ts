// auto-handled-digest — the trust/recall safety net (Epic E §3).
//
// In an ambient model the user stops checking the inbox, so anything the EA
// auto-files becomes invisible. This digest makes that auditable: a periodic
// "here's what I handled for you" email listing emails auto-deprioritised
// (Q3 delegate / Q4 eliminate) over the last 7 days, with low-confidence calls
// flagged for review, plus an Anthropic API spend line vs the $20/month budget
// (folds in the retired ST-07 "cost dashboard" need).
//
// Trigger: pg_cron weekly (Mon 07:00 AEST). Idempotent via api_cost_log.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"
import { marked } from "https://esm.sh/marked@13"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!
const GRAPH = "https://graph.microsoft.com/v1.0"
const AEST = "Australia/Brisbane"
const MONTHLY_BUDGET_AUD = 20
const LOW_CONFIDENCE = 0.6
const AUTO_HANDLED_CATEGORIES = ["delegate", "eliminate"]

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } })
}
function todayAESTISO(): string { return new Date().toLocaleDateString("en-CA", { timeZone: AEST }) }
function startOfTodayAESTUTC(): string { return new Date(todayAESTISO() + "T00:00:00+10:00").toISOString() }

async function getMsAccessToken(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/ms-auth`, { headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` } })
  if (!res.ok) throw new Error(`ms-auth ${res.status}: ${await res.text()}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data.access_token as string
}
async function getUserEmail(token: string): Promise<string> {
  const res = await fetch(`${GRAPH}/me?$select=mail,userPrincipalName`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`/me ${res.status}`)
  const me = await res.json()
  const email = me.mail || me.userPrincipalName
  if (!email) throw new Error("/me returned no email")
  return email as string
}
async function sendMail(token: string, to: string, subject: string, html: string) {
  const res = await fetch(`${GRAPH}/me/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { subject, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: "true" }),
  })
  if (!res.ok) throw new Error(`sendMail ${res.status}: ${await res.text()}`)
}
function htmlEnvelope(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;max-width:680px;margin:0 auto;padding:24px;line-height:1.55;color:#1f2937}
  h1{color:#0f172a;border-bottom:2px solid #c19131;padding-bottom:8px;margin-top:0}
  h2{color:#c19131;margin-top:28px;font-size:16px;text-transform:uppercase;letter-spacing:.5px}
  ul{padding-left:22px} li{margin:4px 0} strong{color:#0f172a}
  </style></head><body>${inner}</body></html>`
}

function normConfidence(v: unknown): number | null {
  const n = Number(v)
  if (!isFinite(n)) return null
  return n > 1 ? n / 100 : n
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405)

  try {
    const body = await req.json().catch(() => ({})) as { send?: boolean; force?: boolean }
    const send = body?.send !== false // default true
    const force = body?.force === true
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // Idempotency: at most one digest per day.
    if (send && !force) {
      const { data: already } = await sb.from("api_cost_log").select("id").eq("operation", "auto_handled_digest").gte("created_at", startOfTodayAESTUTC()).limit(1)
      if (already && (already as unknown[]).length > 0) return jsonResponse({ skipped: "already_sent" })
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString()

    // Auto-handled emails (Q3/Q4) in the last 7 days.
    const { data: ehRows } = await sb
      .from("email_processing_history")
      .select("subject, sender_name, sender_email, ai_category, ai_confidence_score, ai_outlook_folder, processed_at")
      .in("ai_category", AUTO_HANDLED_CATEGORIES)
      .gte("processed_at", sevenDaysAgo)
      .order("processed_at", { ascending: false })
    type EH = { subject?: string; sender_name?: string; sender_email?: string; ai_category?: string; ai_confidence_score?: number; ai_outlook_folder?: string }
    const handled = (ehRows ?? []) as EH[]

    const byCat: Record<string, number> = {}
    const lowConfidence: EH[] = []
    for (const r of handled) {
      const cat = r.ai_category || "other"
      byCat[cat] = (byCat[cat] ?? 0) + 1
      const c = normConfidence(r.ai_confidence_score)
      if (c != null && c < LOW_CONFIDENCE) lowConfidence.push(r)
    }

    // API spend (7-day + month-to-date) vs budget.
    const monthStartAEST = new Date(todayAESTISO().slice(0, 7) + "-01T00:00:00+10:00").toISOString()
    const [{ data: cost7 }, { data: costMTD }] = await Promise.all([
      sb.from("api_cost_log").select("estimated_cost").gte("created_at", sevenDaysAgo),
      sb.from("api_cost_log").select("estimated_cost").gte("created_at", monthStartAEST),
    ])
    const sum = (rows: unknown) => ((rows ?? []) as Array<{ estimated_cost?: number }>).reduce((a, r) => a + (Number(r.estimated_cost) || 0), 0)
    const spent7 = sum(cost7)
    const spentMTD = sum(costMTD)

    // Build markdown.
    const md: string[] = []
    md.push(`# What I handled for you\nLast 7 days — emails I auto-filed so they never hit your queue. Skim to confirm I got it right.\n`)
    if (handled.length === 0) {
      md.push(`**Nothing auto-filed this week.** Every classified email surfaced to you.`)
    } else {
      md.push(`## Auto-handled (${handled.length})`)
      for (const [cat, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
        const label = cat === "eliminate" ? "Eliminated (Q4 noise)" : cat === "delegate" ? "Delegated (Q3)" : cat
        md.push(`- **${label}:** ${n}`)
      }
      if (lowConfidence.length > 0) {
        md.push(`\n## ⚠️ I wasn't sure about these (${lowConfidence.length})\nLow-confidence calls — if any of these actually needed you, they're in Outlook; reply there and I'll learn from it.`)
        for (const r of lowConfidence.slice(0, 15)) {
          md.push(`- "${r.subject || "(no subject)"}" — ${r.sender_name || r.sender_email || "unknown"} → ${r.ai_category}`)
        }
      }
    }
    md.push(`\n## Running cost\n- Last 7 days: **$${spent7.toFixed(2)}**\n- Month to date: **$${spentMTD.toFixed(2)}** of $${MONTHLY_BUDGET_AUD} budget${spentMTD > MONTHLY_BUDGET_AUD ? " ⚠️ over budget" : ""}`)

    const markdown = md.join("\n")

    let sentTo: string | null = null
    if (send) {
      const token = await getMsAccessToken()
      const userEmail = await getUserEmail(token)
      const inner = await marked.parse(markdown)
      await sendMail(token, userEmail, `What I handled this week — ${todayAESTISO()}`, htmlEnvelope(inner as string))
      sentTo = userEmail
      await sb.from("api_cost_log").insert({ operation: "auto_handled_digest", model: "n/a", input_tokens: 0, output_tokens: 0, estimated_cost: 0 })
    }

    return jsonResponse({
      auto_handled: handled.length, by_category: byCat, low_confidence: lowConfidence.length,
      spent_7d: spent7, spent_mtd: spentMTD, sent_to: sentTo,
      markdown: send ? undefined : markdown,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("auto-handled-digest error:", msg)
    return jsonResponse({ error: msg }, 500)
  }
})
