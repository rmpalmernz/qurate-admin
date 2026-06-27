// spend-guard — daily AI-spend circuit-breaker.
//
// Sums today's (AEST) api_cost_log spend and compares it to DAILY_SPEND_CEILING_USD.
// Over ceiling  -> pauses the two autonomous AI crons (morning-brief-daily,
//                  sync-outlook-matrix) and emails an alert.
// Back under    -> resumes them (only if the guard was the one that paused them)
//                  and emails an all-clear.
// The 227k-row runaway cron was fixed with a unique index; this is the general
// backstop so no schedule can ever bleed credits unattended.
//
// Triggered by pg_cron 'spend-guard' (every 13 min). Self-contained by design:
// Supabase MCP deploys each function independently, so helpers are inlined rather
// than shared via ../_shared (which only resolves under CLI bundling).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!
const CEILING_USD = Number(Deno.env.get("DAILY_SPEND_CEILING_USD") ?? "2.0")
const GRAPH = "https://graph.microsoft.com/v1.0"

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

// ─── Email helpers (inlined from morning-brief) ──────────────────────────────
async function getMsAccessToken(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/ms-auth`, {
    headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  })
  if (!res.ok) throw new Error(`ms-auth ${res.status}: ${await res.text()}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data.access_token as string
}

async function getUserEmail(accessToken: string): Promise<string> {
  const res = await fetch(`${GRAPH}/me?$select=mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`/me ${res.status}: ${await res.text()}`)
  const me = await res.json()
  const email = me.mail || me.userPrincipalName
  if (!email) throw new Error("/me returned no email")
  return email as string
}

async function sendMail(accessToken: string, to: string, subject: string, html: string, importance = "high") {
  const body = {
    message: {
      subject,
      body: { contentType: "HTML", content: html },
      toRecipients: [{ emailAddress: { address: to } }],
      importance,
    },
    saveToSentItems: "true",
  }
  const res = await fetch(`${GRAPH}/me/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`sendMail ${res.status}: ${await res.text()}`)
}

// Best-effort notification — never let an email failure mask the guard's action.
async function notify(subject: string, html: string, importance = "high"): Promise<void> {
  try {
    const token = await getMsAccessToken()
    const email = await getUserEmail(token)
    await sendMail(token, email, subject, html, importance)
  } catch (err) {
    console.error("spend-guard notify failed:", err instanceof Error ? err.message : String(err))
  }
}

const fmt = (n: number) => `$${n.toFixed(4)}`

// ─── Main handler ────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    const { data: spendData, error: spendErr } = await sb.rpc("ai_spend_today_aest")
    if (spendErr) throw new Error(`ai_spend_today_aest: ${spendErr.message}`)
    const spend = Number(spendData ?? 0)

    const { data: stateRow } = await sb
      .from("spend_guard_state")
      .select("paused")
      .eq("id", true)
      .maybeSingle()
    const paused = (stateRow as { paused?: boolean } | null)?.paused === true

    const over = spend >= CEILING_USD
    let action: "paused" | "resumed" | "none" = "none"

    if (over && !paused) {
      const { error } = await sb.rpc("set_ai_crons_active", { p_active: false })
      if (error) throw new Error(`set_ai_crons_active(false): ${error.message}`)
      await sb.from("spend_guard_state").update({
        paused: true, paused_at: new Date().toISOString(), last_spend: spend, updated_at: new Date().toISOString(),
      }).eq("id", true)
      action = "paused"
      await notify(
        `⚠️ AI spend ceiling hit — crons paused (${fmt(spend)})`,
        `<!doctype html><html><body style="font-family:-apple-system,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#1f2937">
<h2 style="color:#b91c1c;border-bottom:2px solid #b91c1c;padding-bottom:8px">AI spend ceiling hit</h2>
<p>Today's AI spend reached <strong>${fmt(spend)}</strong>, at or over the <strong>${fmt(CEILING_USD)}</strong> daily ceiling.</p>
<p>The autonomous AI crons <code>morning-brief-daily</code> and <code>sync-outlook-matrix</code> have been <strong>paused</strong>. They'll resume automatically once daily spend drops back under the ceiling (i.e. tomorrow), or run <code>select public.set_ai_crons_active(true);</code> to resume now.</p>
<p style="color:#475569;font-size:13px">If this was unexpected, check <code>api_cost_log</code> for a runaway operation before resuming.</p>
</body></html>`,
      )
    } else if (!over && paused) {
      const { error } = await sb.rpc("set_ai_crons_active", { p_active: true })
      if (error) throw new Error(`set_ai_crons_active(true): ${error.message}`)
      await sb.from("spend_guard_state").update({
        paused: false, last_spend: spend, updated_at: new Date().toISOString(),
      }).eq("id", true)
      action = "resumed"
      await notify(
        `✅ AI crons resumed (${fmt(spend)})`,
        `<!doctype html><html><body style="font-family:-apple-system,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#1f2937">
<h2 style="color:#047857;border-bottom:2px solid #047857;padding-bottom:8px">AI crons resumed</h2>
<p>Today's AI spend is <strong>${fmt(spend)}</strong>, back under the <strong>${fmt(CEILING_USD)}</strong> ceiling. <code>morning-brief-daily</code> and <code>sync-outlook-matrix</code> are active again.</p>
</body></html>`,
        "normal",
      )
    }

    return jsonResponse({ spend, ceiling: CEILING_USD, paused: over, action })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("spend-guard error:", msg)
    return jsonResponse({ error: msg }, 500)
  }
})
