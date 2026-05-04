// send-brief is DEPRECATED. Replaced by morning-brief which generates AND emails in one call.
// Kept as a 410 stub. Callers should POST {"send": true} to /functions/v1/morning-brief.

Deno.serve(() => new Response(JSON.stringify({
  error: "Gone. POST {\"send\": true} to /functions/v1/morning-brief instead.",
  replacement: "morning-brief",
}), { status: 410, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }))
