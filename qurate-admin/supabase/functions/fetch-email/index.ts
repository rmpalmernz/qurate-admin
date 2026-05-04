// fetch-email — Graph GET /me/messages/{id} with full body.
// Called by dashboard email detail drawer.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const GRAPH_BASE = "https://graph.microsoft.com/v1.0"

function getServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
}

async function getAccessToken(): Promise<string> {
  const sb = getServiceClient()
  const { data, error } = await sb.functions.invoke("ms-auth", { method: "GET" })
  if (error || data?.error) {
    throw new Error(data?.error || error?.message || "Failed to get access token")
  }
  return data.access_token
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders })

  try {
    const { messageId } = await req.json()
    if (!messageId) {
      return new Response(
        JSON.stringify({ error: "messageId is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    const accessToken = await getAccessToken()
    const res = await fetch(
      `${GRAPH_BASE}/me/messages/${messageId}?$select=subject,bodyPreview,body,from,receivedDateTime,toRecipients,ccRecipients`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )

    if (!res.ok) {
      const text = await res.text()
      // Surface 404s as non-throwing so the client can react gracefully.
      if (res.status === 404) {
        return new Response(
          JSON.stringify({ error: `ErrorItemNotFound: ${text}` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        )
      }
      throw new Error(`Graph API error [${res.status}]: ${text}`)
    }

    const msg = await res.json()
    return new Response(
      JSON.stringify({
        subject: msg.subject || null,
        body_preview: msg.bodyPreview || null,
        body_html: msg.body?.content || null,
        body_type: msg.body?.contentType || null,
        sender_name: msg.from?.emailAddress?.name || null,
        sender_email: msg.from?.emailAddress?.address || null,
        received_at: msg.receivedDateTime || null,
        to: (msg.toRecipients || []).map((r: { emailAddress?: { address?: string } }) => r.emailAddress?.address).filter(Boolean),
        cc: (msg.ccRecipients || []).map((r: { emailAddress?: { address?: string } }) => r.emailAddress?.address).filter(Boolean),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("fetch-email error:", message)
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})
