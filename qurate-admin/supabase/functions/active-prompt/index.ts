// active-prompt — returns the most recently updated active row from ai_prompts.
// Called by the prompt-tuning UI.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    )

    const { data: rows, error } = await supabase
      .from("ai_prompts")
      .select("prompt_name, prompt_version, system_prompt, updated_at")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)

    if (error) throw error
    const data = rows?.[0]
    if (!data) {
      return new Response(
        JSON.stringify({ error: "No active prompt found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    return new Response(
      JSON.stringify({
        prompt_name: data.prompt_name,
        prompt_version: data.prompt_version,
        system_prompt: data.system_prompt,
        updated_at: data.updated_at,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("active-prompt error:", message)
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})
