// reimport-emails — full re-classification pass over Outlook inbox.
//   1. Purges email_processing_history rows for messages deleted from Outlook
//   2. Fetches up to N latest emails (default 200)
//   3. Re-classifies via the active prompt in ai_prompts
//   4. Inserts into email_processing_history
//   5. Creates eisenhower_tasks via per-sender consolidation
//
// AI: Anthropic Claude — Haiku 4.5 for batch classification + consolidation.
//   (Was Lovable Gemini; migrated 2026-05-04 alongside Epic 3 source-control.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")
const GRAPH_BASE = "https://graph.microsoft.com/v1.0"

const MODEL = "claude-haiku-4-5-20251001"
const MAX_TOKENS = 2048
// Haiku 4.5 pricing per million tokens.
const PRICE_INPUT_PER_MTOK = 1.0
const PRICE_OUTPUT_PER_MTOK = 5.0

const BATCH_SIZE = 10
const PURGE_CHECK_BATCH = 20
const CONCURRENCY = 5

const CONSOLIDATION_PROMPT = `You are an executive assistant. You will receive multiple emails from the SAME sender.

Analyze whether any of them relate to the SAME action, project, or task.
- Same topic/request/project = ONE task
- Different unrelated topics = SEPARATE tasks

Rules for task titles:
- Imperative verb + specific outcome, under 60 characters
- Description: bullet list of distinct action items per group

Return ONLY a JSON array: [{"group_id": <number>, "email_index": <number>, "task_title": "...", "task_description": "..."}]
Same group_id = merge. Different group_id = separate.
For consolidated groups, identical title/description across entries with the same group_id.
For standalone emails, each gets a unique group_id. No prose.`

const TASK_EXTRACTION_PROMPT = `You are an executive assistant converting emails into SMART tasks.

Rules:
- Title: imperative verb + specific outcome, under 60 characters
- If the email contains a deadline, include it in the title
- If no clear action exists, prefix with "Review:"
- Description: one sentence — who needs what, by when, and why it matters
- Never fabricate details not in the email

You will receive a JSON array of emails. Return ONLY a JSON array of objects with "index", "task_title", and "task_description" fields. No prose.`

const FOLDER_TO_QUADRANT: Record<string, string> = {
  "1.  Urgent and Important (Do)": "do",
  "2.  Not Urgent Important (Plan)": "schedule",
  "3.  Urgent not Important (Delegate)": "delegate",
  "4.  Not Important Not Urgent (Elimination)": "eliminate",
}

interface ReimportEmail {
  messageId: string; subject: string; bodyPreview: string;
  senderName: string; senderEmail: string; quadrant: string; receivedDateTime: string | null
}
interface ConsolidatedTask {
  title: string; description: string; quadrant: string; senderName: string;
  messageIds: string[]; primaryMessageId: string; receivedDateTime: string | null
}
interface AiCallResult { content: string | null; inputTokens: number; outputTokens: number }

let aiInputTokens = 0
let aiOutputTokens = 0

async function callAi(systemPrompt: string, userContent: string, options?: { temperature?: number }): Promise<AiCallResult> {
  if (!ANTHROPIC_API_KEY) return { content: null, inputTokens: 0, outputTokens: 0 }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: options?.temperature ?? 0.3,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
  })
  if (!res.ok) {
    console.error(`Anthropic error [${res.status}]:`, await res.text())
    return { content: null, inputTokens: 0, outputTokens: 0 }
  }
  const data = await res.json()
  const content = data?.content?.[0]?.text ?? null
  const inputTokens = data?.usage?.input_tokens ?? 0
  const outputTokens = data?.usage?.output_tokens ?? 0
  aiInputTokens += inputTokens
  aiOutputTokens += outputTokens
  return { content, inputTokens, outputTokens }
}

async function consolidateSenderEmails(senderEmail: string, messages: ReimportEmail[]): Promise<ConsolidatedTask[]> {
  const sorted = [...messages].sort((a, b) => {
    if (!a.receivedDateTime && !b.receivedDateTime) return 0
    if (!a.receivedDateTime) return 1
    if (!b.receivedDateTime) return -1
    return new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime()
  })
  const payload = sorted.map((m, idx) => ({
    index: idx, subject: m.subject, body_preview: m.bodyPreview.substring(0, 400),
    quadrant: m.quadrant, received: m.receivedDateTime,
  }))
  const { content } = await callAi(CONSOLIDATION_PROMPT, JSON.stringify(payload))
  if (!content) {
    return sorted.map((m) => ({ title: m.subject, description: m.bodyPreview.substring(0, 500), quadrant: m.quadrant, senderName: m.senderName, messageIds: [m.messageId], primaryMessageId: m.messageId, receivedDateTime: m.receivedDateTime }))
  }
  try {
    const jsonMatch = content.match(/\[[\s\S]*\]/)
    if (!jsonMatch) throw new Error("No JSON array")
    const results: { group_id: number; email_index: number; task_title: string; task_description: string }[] = JSON.parse(jsonMatch[0])
    const groups = new Map<number, typeof results>()
    for (const r of results) {
      if (!groups.has(r.group_id)) groups.set(r.group_id, [])
      groups.get(r.group_id)!.push(r)
    }
    const tasks: ConsolidatedTask[] = []
    for (const [, groupItems] of groups) {
      const indices = groupItems.map((g) => g.email_index).filter((i) => i >= 0 && i < sorted.length)
      if (indices.length === 0) continue
      const groupMsgs = indices.map((i) => sorted[i])
      const mostRecent = groupMsgs[0]
      const first = groupItems[0]
      tasks.push({
        title: first.task_title || mostRecent.subject,
        description: first.task_description || mostRecent.bodyPreview.substring(0, 500),
        quadrant: mostRecent.quadrant, senderName: mostRecent.senderName,
        messageIds: groupMsgs.map((m) => m.messageId), primaryMessageId: mostRecent.messageId,
        receivedDateTime: mostRecent.receivedDateTime,
      })
    }
    return tasks
  } catch (err) {
    console.error(`Consolidation parse error for ${senderEmail}:`, err)
    return sorted.map((m) => ({ title: m.subject, description: m.bodyPreview.substring(0, 500), quadrant: m.quadrant, senderName: m.senderName, messageIds: [m.messageId], primaryMessageId: m.messageId, receivedDateTime: m.receivedDateTime }))
  }
}

async function createEisenhowerTasks(sb: ReturnType<typeof createClient>, classifiedEmails: ReimportEmail[]): Promise<{ created: number; consolidated: number }> {
  if (classifiedEmails.length === 0) return { created: 0, consolidated: 0 }

  const messageIds = classifiedEmails.map((m) => m.messageId)
  const { data: existingTasks } = await sb
    .from("eisenhower_tasks")
    .select("source_email_id, source_email_ids")
    .eq("source_type", "email")
    .in("source_email_id", messageIds)

  const existingIds = new Set<string>()
  for (const t of (existingTasks || []) as Array<{ source_email_id?: string; source_email_ids?: string[] }>) {
    if (t.source_email_id) existingIds.add(t.source_email_id)
    if (t.source_email_ids) for (const eid of t.source_email_ids) existingIds.add(eid)
  }

  const newEmails = classifiedEmails.filter((m) => !existingIds.has(m.messageId))
  if (newEmails.length === 0) return { created: 0, consolidated: 0 }

  const senderGroups = new Map<string, ReimportEmail[]>()
  for (const msg of newEmails) {
    const key = msg.senderEmail.toLowerCase() || msg.senderName
    if (!senderGroups.has(key)) senderGroups.set(key, [])
    senderGroups.get(key)!.push(msg)
  }

  const senderEntries = Array.from(senderGroups.entries())
  const allTasks: ConsolidatedTask[] = []
  for (let i = 0; i < senderEntries.length; i += CONCURRENCY) {
    const batch = senderEntries.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(async ([senderKey, senderMsgs]) => {
      if (senderMsgs.length === 1) {
        const msg = senderMsgs[0]
        const { content } = await callAi(TASK_EXTRACTION_PROMPT, JSON.stringify([{
          index: 0, from: msg.senderName, subject: msg.subject, body_preview: msg.bodyPreview.substring(0, 400),
        }]))
        let title = msg.subject
        let description = msg.bodyPreview.substring(0, 500)
        if (content) {
          try {
            const match = content.match(/\[[\s\S]*\]/)
            if (match) {
              const parsed = JSON.parse(match[0])
              if (parsed[0]) { title = parsed[0].task_title || title; description = parsed[0].task_description || description }
            }
          } catch { /* fallback */ }
        }
        return [{ title, description, quadrant: msg.quadrant, senderName: msg.senderName, messageIds: [msg.messageId], primaryMessageId: msg.messageId, receivedDateTime: msg.receivedDateTime }] as ConsolidatedTask[]
      }
      console.log(`Consolidating ${senderMsgs.length} emails from ${senderKey}`)
      return await consolidateSenderEmails(senderKey, senderMsgs)
    }))
    for (const r of results) allTasks.push(...r)
  }

  const rows = allTasks.map((t) => ({
    title: t.title, description: t.description, quadrant: t.quadrant,
    source_type: "email", source_email_id: t.primaryMessageId,
    source_email_ids: t.messageIds.length > 1 ? t.messageIds : null,
    client_name: t.senderName, status: "open", email_received_at: t.receivedDateTime || null,
  }))
  const { error } = await sb.from("eisenhower_tasks").insert(rows)
  if (error) {
    console.error("Task insert error:", error.message)
    return { created: 0, consolidated: 0 }
  }
  const consolidated = allTasks.filter((t) => t.messageIds.length > 1).length
  return { created: allTasks.length, consolidated }
}

function getServiceClient() { return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) }

async function getAccessToken(): Promise<string> {
  const sb = getServiceClient()
  const { data, error } = await sb.functions.invoke("ms-auth", { method: "GET" })
  if (error || data?.error) throw new Error(data?.error || error?.message || "Failed to get access token")
  return data.access_token
}

async function fetchEmails(accessToken: string, count: number): Promise<Array<Record<string, unknown>>> {
  const url = `${GRAPH_BASE}/me/messages?$top=${count}&$select=id,subject,bodyPreview,body,from,receivedDateTime&$orderby=receivedDateTime desc`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`Graph API error [${res.status}]: ${await res.text()}`)
  const json = await res.json()
  return json.value || []
}

async function getActivePrompt(sb: ReturnType<typeof createClient>): Promise<{ system_prompt: string; prompt_version: string }> {
  const { data, error } = await sb
    .from("ai_prompts")
    .select("system_prompt, prompt_version")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .single()
  if (error) throw new Error("No active prompt found: " + error.message)
  return data as { system_prompt: string; prompt_version: string }
}

function categoryToFolder(category: string): string {
  const map: Record<string, string> = {
    do: "1.  Urgent and Important (Do)",
    do_first: "1.  Urgent and Important (Do)",
    plan: "2.  Not Urgent Important (Plan)",
    schedule: "2.  Not Urgent Important (Plan)",
    delegate: "3.  Urgent not Important (Delegate)",
    eliminate: "4.  Not Important Not Urgent (Elimination)",
  }
  return map[category?.toLowerCase()] || "4.  Not Important Not Urgent (Elimination)"
}

async function classifyBatch(emails: { index: number; from: string; subject: string; body_preview: string }[], systemPrompt: string): Promise<Array<Record<string, unknown>>> {
  const userMessage = `Classify each of the following emails. Return ONLY a JSON array (no prose) where each element has: index, category, reasoning, confidence, sentiment, thread_escalation, history_applied, registry_match, task_title.\n\n${JSON.stringify(emails, null, 2)}`
  const { content } = await callAi(systemPrompt, userMessage, { temperature: 0.2 })
  if (!content) throw new Error("Anthropic returned no content for batch classification")
  const jsonMatch = content.match(/\[[\s\S]*\]/)
  if (!jsonMatch) throw new Error("AI response did not contain a valid JSON array")
  return JSON.parse(jsonMatch[0])
}

async function purgeDeletedEmails(sb: ReturnType<typeof createClient>, accessToken: string): Promise<{ purged: number; checked: number }> {
  const { data: rows, error } = await sb.from("email_processing_history").select("id, email_id").not("email_id", "is", null)
  if (error || !rows || rows.length === 0) return { purged: 0, checked: 0 }
  const toDelete: string[] = []
  for (let i = 0; i < rows.length; i += PURGE_CHECK_BATCH) {
    const batch = rows.slice(i, i + PURGE_CHECK_BATCH) as Array<{ id: string; email_id: string }>
    const checks = batch.map(async (row) => {
      try {
        const res = await fetch(`${GRAPH_BASE}/me/messages/${row.email_id}?$select=id`, { headers: { Authorization: `Bearer ${accessToken}` } })
        if (res.status === 404) {
          toDelete.push(row.id)
        } else if (!res.ok) {
          try { const body = await res.json(); if (body?.error?.code === "ErrorItemNotFound") toDelete.push(row.id) } catch { /* ignore */ }
        }
      } catch { /* network error — skip */ }
    })
    await Promise.all(checks)
  }
  if (toDelete.length > 0) {
    console.log(`Purging ${toDelete.length} deleted emails from DB...`)
    for (let i = 0; i < toDelete.length; i += 50) {
      const batch = toDelete.slice(i, i + 50)
      const { error: delError } = await sb.from("email_processing_history").delete().in("id", batch)
      if (delError) console.error("Purge delete error:", delError.message)
    }
  }
  return { purged: toDelete.length, checked: rows.length }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders })

  try {
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured")

    const sb = getServiceClient()
    let emailCount = 200
    try {
      const body = await req.json()
      if (body?.count) emailCount = Math.min(body.count, 500)
    } catch { /* default */ }

    aiInputTokens = 0
    aiOutputTokens = 0

    const accessToken = await getAccessToken()
    const purgeResult = await purgeDeletedEmails(sb, accessToken)
    console.log(`Purge complete: checked ${purgeResult.checked}, purged ${purgeResult.purged}`)

    const messages = await fetchEmails(accessToken, emailCount)
    console.log(`Fetched ${messages.length} emails from Outlook`)

    const prompt = await getActivePrompt(sb)
    console.log(`Using prompt version: ${prompt.prompt_version}`)

    const { data: existingRows } = await sb.from("email_processing_history").select("email_id")
    const existingIds = new Set((existingRows || []).map((r: { email_id?: string }) => r.email_id))
    const newMessages = messages.filter((m: Record<string, unknown>) => !existingIds.has(m.id as string))
    const skipped = messages.length - newMessages.length

    let imported = 0
    let errors = 0

    for (let i = 0; i < newMessages.length; i += BATCH_SIZE) {
      const batch = newMessages.slice(i, i + BATCH_SIZE)
      const batchInput = batch.map((m: Record<string, unknown>, idx: number) => ({
        index: idx,
        from: ((m.from as { emailAddress?: { address?: string } })?.emailAddress?.address) || "unknown",
        subject: (m.subject as string) || "(no subject)",
        body_preview: ((m.bodyPreview as string) || "").substring(0, 500),
      }))
      try {
        const classifications = await classifyBatch(batchInput, prompt.system_prompt)
        const rows = batch.map((m: Record<string, unknown>, idx: number) => {
          const cls = (classifications.find((c) => (c as { index?: number }).index === idx) as Record<string, unknown> | undefined) || (classifications[idx] as Record<string, unknown> | undefined) || {}
          const category = (((cls.category as string) || "eliminate")).toLowerCase()
          return {
            email_id: m.id as string,
            subject: (m.subject as string) || null,
            sender_name: ((m.from as { emailAddress?: { name?: string } })?.emailAddress?.name) || null,
            sender_email: ((m.from as { emailAddress?: { address?: string } })?.emailAddress?.address) || null,
            body_preview: (m.bodyPreview as string) || null,
            body_full: ((m.body as { content?: string })?.content) || null,
            ai_category: category,
            ai_justification: (cls.reasoning as string) || null,
            ai_confidence_score: (cls.confidence as number) ?? null,
            ai_outlook_folder: categoryToFolder(category),
            prompt_version: prompt.prompt_version,
            ai_todo_task_title: (cls.task_title as string) || null,
            review_status: "pending",
            processed_at: new Date().toISOString(),
          }
        })
        const { error: insertError } = await sb.from("email_processing_history").insert(rows)
        if (insertError) { console.error(`Batch insert error: ${insertError.message}`); errors += batch.length }
        else imported += batch.length
      } catch (batchErr) {
        console.error(`Batch ${i / BATCH_SIZE} error:`, batchErr)
        errors += batch.length
      }
      console.log(`Progress: ${Math.min(i + BATCH_SIZE, newMessages.length)}/${newMessages.length}`)
    }

    // Build classified list for Eisenhower task creation
    const classifiedForTasks: ReimportEmail[] = []
    for (const m of newMessages) {
      const senderEmail = ((m.from as { emailAddress?: { address?: string } })?.emailAddress?.address) || ""
      const senderName = ((m.from as { emailAddress?: { name?: string } })?.emailAddress?.name) || senderEmail || "Unknown"
      const { data: classRow } = await sb.from("email_processing_history").select("ai_outlook_folder").eq("email_id", m.id as string).limit(1).single()
      const folder = (classRow as { ai_outlook_folder?: string } | null)?.ai_outlook_folder || "4.  Not Important Not Urgent (Elimination)"
      const quadrant = FOLDER_TO_QUADRANT[folder] || "eliminate"
      classifiedForTasks.push({
        messageId: m.id as string,
        subject: (m.subject as string) || "(No subject)",
        bodyPreview: ((m.bodyPreview as string) || "").substring(0, 500),
        senderName, senderEmail, quadrant,
        receivedDateTime: (m.receivedDateTime as string) || null,
      })
    }

    const taskResult = await createEisenhowerTasks(sb, classifiedForTasks)
    console.log(`Tasks created: ${taskResult.created} (${taskResult.consolidated} consolidated)`)

    const estimatedCost = (aiInputTokens * PRICE_INPUT_PER_MTOK + aiOutputTokens * PRICE_OUTPUT_PER_MTOK) / 1_000_000
    if (aiInputTokens > 0 || aiOutputTokens > 0) {
      await sb.from("api_cost_log").insert({
        operation: "email_reimport",
        model: MODEL,
        input_tokens: aiInputTokens,
        output_tokens: aiOutputTokens,
        estimated_cost: estimatedCost,
      })
    }

    const summary = {
      imported, skipped, errors,
      total: messages.length,
      purged: purgeResult.purged,
      tasks_created: taskResult.created,
      tasks_consolidated: taskResult.consolidated,
    }
    console.log("Reimport complete:", summary)

    return new Response(JSON.stringify(summary), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("reimport-emails error:", message)
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }
})
