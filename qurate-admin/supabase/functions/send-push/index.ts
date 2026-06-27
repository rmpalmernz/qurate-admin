// send-push — dispatches a Web Push notification to every stored subscription.
// Foundation slice for Epic C (proactive nudges): called manually to test delivery,
// and later by the nudge-engine. Payload: { title, body, url?, tag? }.
//
// Required Edge Function secrets:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (e.g. mailto:richard.palmer@qurate.com.au)
import webpush from "npm:web-push@3.6.7"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:richard.palmer@qurate.com.au"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

interface SubRow { id: string; endpoint: string; p256dh: string; auth: string }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })

  try {
    const body = await req.json().catch(() => ({})) as { title?: string; body?: string; url?: string; tag?: string }
    const payload = JSON.stringify({
      title: body.title || "Qurate EA",
      body: body.body || "Test notification",
      url: body.url || "/dashboard",
      tag: body.tag,
    })

    const { data: subs, error } = await sb
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
    if (error) throw error

    const results: Array<{ id: string; ok: boolean; status?: number; error?: string }> = []
    for (const s of (subs ?? []) as SubRow[]) {
      const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }
      try {
        await webpush.sendNotification(subscription, payload)
        await sb.from("push_subscriptions").update({ last_used_at: new Date().toISOString() }).eq("id", s.id)
        results.push({ id: s.id, ok: true })
      } catch (e) {
        const status = (e as { statusCode?: number })?.statusCode
        // 404/410 = subscription expired/unsubscribed — prune it.
        if (status === 404 || status === 410) {
          await sb.from("push_subscriptions").delete().eq("id", s.id)
        }
        results.push({ id: s.id, ok: false, status, error: e instanceof Error ? e.message : String(e) })
      }
    }

    return jsonResponse({ sent: results.filter(r => r.ok).length, total: results.length, results })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("send-push error:", msg)
    return jsonResponse({ error: msg }, 500)
  }
})
