// delete-outlook-email — Graph DELETE /me/messages/{id}.
// Called by dashboard archive button.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders })

  try {
    const { messageId } = await req.json()
    if (!messageId) {
      return new Response(JSON.stringify({ error: "messageId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    const tokenRes = await fetch(`${SUPABASE_URL}/functions/v1/ms-auth`, {
      headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": "application/json" },
    })
    if (!tokenRes.ok) throw new Error(`Failed to get access token: ${await tokenRes.text()}`)
    const { access_token } = await tokenRes.json()

    const graphRes = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${messageId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${access_token}` },
    })

    if (!graphRes.ok) {
      const body = await graphRes.text()
      console.error(`Graph DELETE failed [${graphRes.status}]:`, body)
      return new Response(
        JSON.stringify({ error: `Graph API error: ${graphRes.status}`, details: body }),
        { status: graphRes.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("delete-outlook-email error:", message)
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }
})
