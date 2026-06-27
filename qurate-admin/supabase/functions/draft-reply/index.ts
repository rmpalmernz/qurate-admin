// draft-reply — AI email reply generation. Anthropic Claude Sonnet 4.5.
// System prompt loaded from ai_prompts table where prompt_name = 'draft-reply'.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")
const MODEL = "claude-sonnet-4-5"
const MAX_TOKENS = 1024
// Sonnet 4.5 pricing per million tokens.
const PRICE_INPUT_PER_MTOK = 3.0
const PRICE_OUTPUT_PER_MTOK = 15.0

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405)
  if (!ANTHROPIC_API_KEY) return jsonResponse({ error: "ANTHROPIC_API_KEY is not configured" }, 500)

  try {
    const body = (await req.json()) as {
      email_id?: string
      subject?: string
      from_name?: string
      from_email?: string
      body_preview?: string
    }
    const subject = typeof body?.subject === "string" ? body.subject : ""
    const fromName = typeof body?.from_name === "string" ? body.from_name : ""
    const fromEmail = typeof body?.from_email === "string" ? body.from_email : ""
    const bodyPreview = typeof body?.body_preview === "string" ? body.body_preview : ""

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const { data } = await supabase
      .from("ai_prompts")
      .select("system_prompt")
      .eq("prompt_name", "draft-reply")
      .eq("is_active", true)
      .order("updated_at", { ascending: false })
      .limit(1)
    const row = (data ?? [])[0] as { system_prompt?: string } | undefined
    if (!row?.system_prompt) {
      console.warn("No active prompt found for draft-reply in ai_prompts table")
      return jsonResponse({
        error: "System prompt not configured. Please add an active record to ai_prompts table with prompt_name = 'draft-reply'.",
      }, 500)
    }

    const userPrompt = `From: ${fromName} <${fromEmail}>\nSubject: ${subject}\n\nMessage:\n${bodyPreview}`

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: row.system_prompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    })

    const resData = await res.json().catch(() => ({}))
    if (!res.ok) {
      const errMsg = resData?.error?.message || resData?.message || res.statusText || "Anthropic API error"
      return jsonResponse({ error: errMsg }, res.status >= 400 ? res.status : 500)
    }

    // Cost log — keeps draft-reply visible to the spend guard like the other AI calls.
    const inputTokens = resData?.usage?.input_tokens ?? 0
    const outputTokens = resData?.usage?.output_tokens ?? 0
    const cost = (inputTokens * PRICE_INPUT_PER_MTOK + outputTokens * PRICE_OUTPUT_PER_MTOK) / 1_000_000
    await supabase.from("api_cost_log").insert({
      operation: "draft_reply",
      model: MODEL,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost: cost,
    })

    const draft = resData?.content?.[0]?.text ?? resData?.content ?? ""
    return jsonResponse({ draft: draft.trim(), body_text: draft.trim() })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return jsonResponse({ error: msg }, 500)
  }
})
