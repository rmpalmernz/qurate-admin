// daily-brief is DEPRECATED. Replaced by morning-brief (Anthropic Claude Sonnet 4.5).
// Kept as a 410 stub so callers get a clear signal instead of executing stale code.
// Safe to delete from Supabase entirely once nothing has called it for >7 days.

Deno.serve(() => new Response(JSON.stringify({
  error: "Gone. Use /functions/v1/morning-brief instead.",
  replacement: "morning-brief",
}), { status: 410, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }))
