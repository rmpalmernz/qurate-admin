// sender-history — read-aggregate of email_processing_history for a sender.
// Called by the prompt-tuning UI to show history + suggested confidence adjustment.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders })

  try {
    const url = new URL(req.url)
    const email = url.searchParams.get("email")
    const limit = parseInt(url.searchParams.get("limit") || "20", 10)

    if (!email) {
      return new Response(
        JSON.stringify({ error: "email query parameter is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    )

    const { data: emails, error } = await supabase
      .from("email_processing_history")
      .select(
        "id, ai_category, ai_confidence_score, manual_review_category, manual_review_notes, review_status, processed_at, reviewed_at, subject"
      )
      .eq("sender_email", email)
      .order("processed_at", { ascending: false })
      .limit(limit)

    if (error) throw error

    if (!emails || emails.length === 0) {
      return new Response(
        JSON.stringify({
          sender_email: email,
          total_emails: 0,
          classifications: [],
          overrides: [],
          pattern_summary: "No prior history for this sender",
          confidence_adjustment: -10,
          dominant_category: null,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    type Row = { id: string; ai_category?: string; ai_confidence_score?: number; manual_review_category?: string; manual_review_notes?: string; review_status?: string; processed_at?: string; reviewed_at?: string; subject?: string }
    const rows = emails as Row[]

    const classifications = rows.map((e) => ({
      category: e.manual_review_category || e.ai_category,
      ai_category: e.ai_category,
      was_corrected: !!(e.manual_review_category && e.manual_review_category !== e.ai_category),
      confidence: e.ai_confidence_score,
      date: e.processed_at ? e.processed_at.split("T")[0] : null,
      subject: e.subject,
    }))

    const overrides = rows
      .filter((e) => e.manual_review_category && e.manual_review_category !== e.ai_category)
      .map((e) => ({
        from: e.ai_category,
        to: e.manual_review_category,
        notes: e.manual_review_notes,
        date: e.reviewed_at ? e.reviewed_at.split("T")[0] : e.processed_at?.split("T")[0],
      }))

    const categoryCounts: Record<string, number> = {}
    for (const c of classifications) {
      const cat = c.category || "unknown"
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1
    }
    const dominant_category = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null
    const dominantCount = dominant_category ? categoryCounts[dominant_category] : 0

    const total = classifications.length
    const pattern_summary =
      dominant_category && dominantCount > total * 0.6
        ? `Consistently classified as '${dominant_category}' (${dominantCount}/${total} emails)`
        : dominant_category
        ? `Mixed classification: dominant '${dominant_category}' (${dominantCount}/${total})`
        : "No clear pattern"

    let confidence_adjustment = 0
    if (overrides.length > 0) confidence_adjustment = 20
    else if (total >= 3) confidence_adjustment = 15
    else confidence_adjustment = -10

    return new Response(
      JSON.stringify({
        sender_email: email,
        total_emails: total,
        classifications,
        overrides,
        pattern_summary,
        confidence_adjustment,
        dominant_category,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("sender-history error:", message)
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})
