// follow-ups — detects sent emails >48h with no reply and writes to follow_ups table.
// Called manually from the dashboard "Refresh follow-ups" action.
//
// NOTE: This was inherited prior-art and STILL uses Lovable AI in spots elsewhere in the
// pipeline (none in this function — pure Graph + DB). No migration required here.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ms-graph-token",
}

interface GraphMessage {
  id: string
  conversationId?: string
  subject?: string
  toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>
  sentDateTime?: string
  sender?: { emailAddress?: { address?: string } }
  receivedDateTime?: string
}

interface FollowUpRow {
  email_id: string
  conversation_id: string
  sent_date: string
  subject: string
  recipient: string
  recipient_name: string | null
  days_overdue: number
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

async function getMsToken(): Promise<string | null> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/ms-auth`, {
    headers: { apikey: SUPABASE_ANON_KEY },
  })
  if (!res.ok) return null
  const data = await res.json()
  return data.access_token ?? null
}

async function graphFetch(token: string, path: string, searchParams?: URLSearchParams): Promise<{ value?: unknown[] }> {
  const url = new URL(`https://graph.microsoft.com/v1.0/me${path}`)
  if (searchParams) url.search = searchParams.toString()
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Graph API error: ${res.status} ${await res.text()}`)
  return res.json()
}

function isAutoReply(subject: string): boolean {
  const s = (subject || "").toLowerCase()
  return s.includes("out of office") || s.includes("automatic reply") || s.includes("auto-reply")
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })

  try {
    let token: string | null = req.headers.get("x-ms-graph-token")?.trim() || null
    if (!token && req.method === "POST") {
      try {
        const body = await req.json() as { access_token?: string }
        token = body?.access_token ?? null
      } catch { /* no body or invalid JSON */ }
    }
    if (!token) token = await getMsToken()
    if (!token) return jsonResponse({ error: "Microsoft token not available. Sign in again." }, 401)

    const sevenDaysAgo = new Date(Date.now() - SEVEN_DAYS_MS)
    const cutoff48h = new Date(Date.now() - FORTY_EIGHT_HOURS_MS)
    const isoSevenDays = sevenDaysAgo.toISOString()

    const meParams = new URLSearchParams({ $select: "mail,userPrincipalName" })
    const meRes = await graphFetch(token, "", meParams)
    const userEmail = ((meRes as { mail?: string; userPrincipalName?: string }).mail ||
      (meRes as { mail?: string; userPrincipalName?: string }).userPrincipalName || "").toLowerCase()

    const sentParams = new URLSearchParams({
      $top: "100",
      $select: "id,conversationId,subject,toRecipients,sentDateTime",
      $filter: `sentDateTime ge ${isoSevenDays}`,
      $orderby: "sentDateTime desc",
    })
    const sentData = await graphFetch(token, "/mailFolders/sentItems/messages", sentParams)
    const sentMessages = (sentData.value || []) as GraphMessage[]

    const overdue: FollowUpRow[] = []

    for (const msg of sentMessages) {
      const sentStr = msg.sentDateTime
      if (!sentStr || !msg.conversationId || !msg.id) continue

      const sentDate = new Date(sentStr)
      if (sentDate >= cutoff48h) continue
      if (isAutoReply(msg.subject || "")) continue

      const convId = msg.conversationId
      const convParams = new URLSearchParams({
        $filter: `conversationId eq '${convId.replace(/'/g, "''")}'`,
        $orderby: "receivedDateTime desc",
        $top: "15",
        $select: "sender,receivedDateTime",
      })
      let convData: { value?: GraphMessage[] }
      try {
        convData = await graphFetch(token, "/messages", convParams)
      } catch { continue }
      const convMessages = (convData.value || []) as GraphMessage[]

      const hasReplyAfterSent = convMessages.some((m) => {
        const fromAddr = (m.sender?.emailAddress?.address || "").toLowerCase()
        const received = m.receivedDateTime ? new Date(m.receivedDateTime).getTime() : 0
        return fromAddr && fromAddr !== userEmail && received > sentDate.getTime()
      })
      if (hasReplyAfterSent) continue

      const toRec = msg.toRecipients?.[0]?.emailAddress
      const recipient = (toRec?.address || "").trim() || "unknown"
      const recipientName = toRec?.name?.trim() || null
      const sentThreshold = sentDate.getTime() + FORTY_EIGHT_HOURS_MS
      const daysOverdue = Math.max(0, Math.floor((Date.now() - sentThreshold) / (24 * 60 * 60 * 1000)))

      overdue.push({
        email_id: msg.id,
        conversation_id: convId,
        sent_date: sentDate.toISOString(),
        subject: (msg.subject || "").trim() || "(No subject)",
        recipient,
        recipient_name: recipientName,
        days_overdue: daysOverdue,
      })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    await supabase.from("follow_ups").delete().is("resolved_at", null)
    if (overdue.length > 0) {
      const { error } = await supabase.from("follow_ups").insert(overdue)
      if (error) throw new Error(`Failed to insert follow_ups: ${error.message}`)
    }

    return jsonResponse({ count: overdue.length, items: overdue })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return jsonResponse({ error: message }, 500)
  }
})
