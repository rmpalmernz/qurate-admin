// improve-prompt — analyses correction patterns and suggests an improved system prompt.
// AI: Anthropic Claude Sonnet 4.5 (was Lovable Gemini, migrated 2026-05-04 alongside Epic 3
// source-control to fully kill Lovable from the codebase).

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")
const MODEL = "claude-sonnet-4-5"
const MAX_TOKENS = 4096

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

interface CorrectionInput {
  subject: string
  aiCategory: string
  correctCategory: string
  feedback: string | null
}

interface RequestBody {
  currentPrompt: string
  promptName: string
  promptVersion: string
  corrections: CorrectionInput[]
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } })
}

function incrementVersion(version: string): string {
  const parts = version.split(".")
  if (parts.length >= 2) {
    const minor = parseInt(parts[1] || "0") + 1
    return `${parts[0]}.${minor}`
  }
  return `${version}.1`
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders })

  try {
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured")

    const body: RequestBody = await req.json()
    const { currentPrompt, promptVersion, corrections } = body

    if (!corrections.length) {
      return jsonResponse({
        improvedPrompt: currentPrompt,
        analysis: "No corrections to analyze. The current prompt appears to be working well.",
        suggestedVersion: promptVersion,
      })
    }

    const correctionExamples = corrections.map((c, i) =>
      `${i + 1}. Subject: "${c.subject}"\n   AI classified as: ${c.aiCategory.toUpperCase()}\n   Should be: ${c.correctCategory.toUpperCase()}\n   ${c.feedback ? `User feedback: "${c.feedback}"` : ''}`
    ).join("\n\n")

    const patternMap = new Map<string, number>()
    corrections.forEach((c) => {
      const key = `${c.aiCategory} → ${c.correctCategory}`
      patternMap.set(key, (patternMap.get(key) || 0) + 1)
    })
    const patterns = Array.from(patternMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([pattern, count]) => `- ${pattern}: ${count} times`)
      .join("\n")

    const systemPrompt = `You are an expert at improving AI classification prompts for email triage.

Your task is to analyze correction patterns and improve a prompt to prevent similar mistakes.

IMPORTANT GUIDELINES:
1. Keep the improved prompt concise and focused
2. Add specific rules or examples based on the correction patterns
3. Don't remove existing logic that works - only add or refine
4. Focus on the most common correction patterns first
5. If feedback mentions specific keywords or patterns, incorporate them

Respond ONLY with a JSON object (no prose, no code fences) containing:
- "analysis": A brief summary of what patterns you found and what you're fixing (2-3 sentences)
- "improvedPrompt": The complete improved prompt
- "suggestedVersion": Increment the minor version (e.g., 1.0 -> 1.1)`

    const userPrompt = `## Current Prompt
${currentPrompt}

## Current Version
${promptVersion}

## Correction Patterns (most common first)
${patterns}

## Detailed Correction Examples
${correctionExamples}

Please analyze these corrections and improve the prompt to prevent similar mistakes.`

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    })
    const aiData = await res.json().catch(() => ({}))
    if (!res.ok) {
      const errMsg = aiData?.error?.message || aiData?.message || res.statusText || "Anthropic API error"
      return jsonResponse({ error: errMsg }, res.status >= 400 ? res.status : 500)
    }

    const content = aiData?.content?.[0]?.text ?? ""
    if (!content) throw new Error("Anthropic returned no content")

    // Extract JSON object from response (Claude sometimes wraps in code fences despite instructions).
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error("Invalid response format from AI: no JSON object found")
    const result = JSON.parse(jsonMatch[0])

    return jsonResponse({
      improvedPrompt: result.improvedPrompt || currentPrompt,
      analysis: result.analysis || "Analysis complete.",
      suggestedVersion: result.suggestedVersion || incrementVersion(promptVersion),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("improve-prompt error:", message)
    return jsonResponse({ error: message }, 500)
  }
})
