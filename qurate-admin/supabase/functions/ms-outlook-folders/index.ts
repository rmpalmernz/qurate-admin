// ms-outlook-folders — sync Eisenhower-mapped Outlook subfolders into eisenhower_tasks.
//
// AI: Anthropic Claude Haiku 4.5 only. No Lovable.
//
// Triggers:
//   - pg_cron 'sync-outlook-matrix' (currently PAUSED — see docs/INFRASTRUCTURE.md for the
//     dedup-bug fix that must land before re-enabling).
//   - Manual: ?reprocess=true (re-AI tasks already in eisenhower_tasks),
//             ?backfill_dates=true (fill email_received_at from Graph),
//             default = read 4 mapped folders, AI-extract tasks, insert.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")

const MODEL = "claude-haiku-4-5-20251001"
const MAX_TOKENS = 1024
// Haiku 4.5 pricing per million tokens.
const PRICE_INPUT_PER_MTOK = 1.0
const PRICE_OUTPUT_PER_MTOK = 5.0

const FOLDER_MAP: Record<string, string> = {
  "1.  Urgent and Important (Do)": "do",
  "2.  Not Urgent Important (Plan)": "schedule",
  "3.  Urgent not Important (Delegate)": "delegate",
  "4.  Not Important Not Urgent (Elimination)": "eliminate",
}

const GRAPH_BASE = "https://graph.microsoft.com/v1.0"

const TASK_EXTRACTION_PROMPT = `You are an executive assistant converting emails into SMART tasks (Specific, Measurable, Achievable, Relevant, Time-bound).

Rules:
- Title: imperative verb + specific outcome, under 60 characters (e.g. "Send LOI to Acme by Friday", "Approve Q2 budget reforecast")
- If the email contains a deadline, include it in the title
- If no clear action exists, prefix with "Review:" (e.g. "Review: FY26 tax summary from BDO")
- Description: one sentence — who needs what, by when, and why it matters
- Never fabricate details not in the email
- Strip greetings, signatures, and filler from your analysis

You will receive a JSON array of emails. Return ONLY a JSON array of objects with "index", "task_title", and "task_description" fields. No prose around it.`

const CONSOLIDATION_PROMPT = `You are an executive assistant. You will receive multiple emails from the SAME sender.

Analyze whether any of them relate to the SAME action, project, or task.
- If emails are about the same topic/request/project, consolidate them into ONE task
- If emails are about DIFFERENT unrelated topics, create SEPARATE tasks
- Use your judgment: a follow-up on the same topic = same task; a new unrelated request = separate task

Rules for task titles:
- Imperative verb + specific outcome, under 60 characters
- If consolidating, the title should cover the overall engagement
- Description: bullet list of distinct action items from each email in the group

Return ONLY a JSON array of objects:
[
  {
    "group_id": <number>,
    "email_index": <number>,
    "task_title": "...",
    "task_description": "..."
  }
]

Same group_id = merge into one task. Different group_id = separate tasks.
For consolidated groups, the title/description in each entry with the same group_id should be IDENTICAL (the merged version).
For standalone emails, each gets a unique group_id. No prose around the JSON.`

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

async function graphGet(accessToken: string, path: string) {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Graph API error [${res.status}]: ${text}`)
  }
  return res.json()
}

interface EmailMessage {
  messageId: string
  subject: string
  bodyPreview: string
  senderName: string
  senderEmail: string
  quadrant: string
  receivedDateTime: string | null
}

interface AiTask { index: number; task_title: string; task_description: string }
interface ConsolidationResult { group_id: number; email_index: number; task_title: string; task_description: string }

interface AiCallResult { content: string | null; inputTokens: number; outputTokens: number }

async function callAi(systemPrompt: string, userContent: string): Promise<AiCallResult> {
  if (!ANTHROPIC_API_KEY) return { content: null, inputTokens: 0, outputTokens: 0 }

  const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
  })

  if (!aiResponse.ok) {
    console.error(`Anthropic error [${aiResponse.status}]:`, await aiResponse.text())
    return { content: null, inputTokens: 0, outputTokens: 0 }
  }

  const aiData = await aiResponse.json()
  const content = aiData?.content?.[0]?.text ?? null
  const inputTokens = aiData?.usage?.input_tokens ?? 0
  const outputTokens = aiData?.usage?.output_tokens ?? 0
  return { content, inputTokens, outputTokens }
}

let aiInputTokensTotal = 0
let aiOutputTokensTotal = 0

async function extractTasksWithAi(messages: EmailMessage[]): Promise<Map<string, { title: string; description: string }>> {
  if (!ANTHROPIC_API_KEY) {
    console.warn("ANTHROPIC_API_KEY not set, falling back to raw subjects")
    return new Map()
  }

  const result = new Map<string, { title: string; description: string }>()
  const BATCH_SIZE = 10

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE)
    const emailsPayload = batch.map((m, idx) => ({
      index: idx,
      from: m.senderName,
      subject: m.subject,
      body_preview: m.bodyPreview.substring(0, 400),
    }))

    try {
      const { content, inputTokens, outputTokens } = await callAi(TASK_EXTRACTION_PROMPT, JSON.stringify(emailsPayload))
      aiInputTokensTotal += inputTokens
      aiOutputTokensTotal += outputTokens
      if (!content) continue

      const jsonMatch = content.match(/\[[\s\S]*\]/)
      if (!jsonMatch) {
        console.error("Could not parse AI response as JSON array:", content.substring(0, 200))
        continue
      }

      const tasks: AiTask[] = JSON.parse(jsonMatch[0])
      for (const task of tasks) {
        if (task.index >= 0 && task.index < batch.length) {
          result.set(batch[task.index].messageId, {
            title: task.task_title || batch[task.index].subject,
            description: task.task_description || batch[task.index].bodyPreview.substring(0, 500),
          })
        }
      }
    } catch (err) {
      console.error("AI batch processing error:", err)
    }
  }

  return result
}

interface ConsolidatedTask {
  title: string
  description: string
  quadrant: string
  senderName: string
  messageIds: string[]
  primaryMessageId: string
  receivedDateTime: string | null
}

async function consolidateSenderEmails(senderEmail: string, messages: EmailMessage[]): Promise<ConsolidatedTask[]> {
  const sorted = [...messages].sort((a, b) => {
    if (!a.receivedDateTime && !b.receivedDateTime) return 0
    if (!a.receivedDateTime) return 1
    if (!b.receivedDateTime) return -1
    return new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime()
  })

  const emailsPayload = sorted.map((m, idx) => ({
    index: idx,
    subject: m.subject,
    body_preview: m.bodyPreview.substring(0, 400),
    quadrant: m.quadrant,
    received: m.receivedDateTime,
  }))

  const { content, inputTokens, outputTokens } = await callAi(CONSOLIDATION_PROMPT, JSON.stringify(emailsPayload))
  aiInputTokensTotal += inputTokens
  aiOutputTokensTotal += outputTokens

  if (!content) {
    return sorted.map((m) => ({
      title: m.subject,
      description: m.bodyPreview.substring(0, 500),
      quadrant: m.quadrant,
      senderName: m.senderName,
      messageIds: [m.messageId],
      primaryMessageId: m.messageId,
      receivedDateTime: m.receivedDateTime,
    }))
  }

  try {
    const jsonMatch = content.match(/\[[\s\S]*\]/)
    if (!jsonMatch) throw new Error("No JSON array in response")
    const results: ConsolidationResult[] = JSON.parse(jsonMatch[0])

    const groups = new Map<number, ConsolidationResult[]>()
    for (const r of results) {
      if (!groups.has(r.group_id)) groups.set(r.group_id, [])
      groups.get(r.group_id)!.push(r)
    }

    const tasks: ConsolidatedTask[] = []
    for (const [, groupItems] of groups) {
      const emailIndices = groupItems.map((g) => g.email_index).filter((i) => i >= 0 && i < sorted.length)
      if (emailIndices.length === 0) continue

      const groupMessages = emailIndices.map((i) => sorted[i])
      const mostRecent = groupMessages[0]
      const firstItem = groupItems[0]

      tasks.push({
        title: firstItem.task_title || mostRecent.subject,
        description: firstItem.task_description || mostRecent.bodyPreview.substring(0, 500),
        quadrant: mostRecent.quadrant,
        senderName: mostRecent.senderName,
        messageIds: groupMessages.map((m) => m.messageId),
        primaryMessageId: mostRecent.messageId,
        receivedDateTime: mostRecent.receivedDateTime,
      })
    }

    return tasks
  } catch (err) {
    console.error(`Consolidation parse error for ${senderEmail}:`, err)
    return sorted.map((m) => ({
      title: m.subject,
      description: m.bodyPreview.substring(0, 500),
      quadrant: m.quadrant,
      senderName: m.senderName,
      messageIds: [m.messageId],
      primaryMessageId: m.messageId,
      receivedDateTime: m.receivedDateTime,
    }))
  }
}

async function logAiCost(operation: string) {
  if (aiInputTokensTotal === 0 && aiOutputTokensTotal === 0) return
  const sb = getServiceClient()
  const cost = (aiInputTokensTotal * PRICE_INPUT_PER_MTOK + aiOutputTokensTotal * PRICE_OUTPUT_PER_MTOK) / 1_000_000
  await sb.from("api_cost_log").insert({
    operation,
    model: MODEL,
    input_tokens: aiInputTokensTotal,
    output_tokens: aiOutputTokensTotal,
    estimated_cost: cost,
  })
}

async function handleReprocess(): Promise<Response> {
  const sb = getServiceClient()
  const { data: tasks, error } = await sb
    .from("eisenhower_tasks")
    .select("id, title, description, quadrant, client_name, source_email_id")
    .eq("source_type", "email")
    .order("created_at", { ascending: false })

  if (error) throw error
  if (!tasks || tasks.length === 0) {
    return new Response(JSON.stringify({ reprocessed: 0, summary: "No email-sourced tasks found." }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } })
  }

  const messages: EmailMessage[] = tasks.map((t: Record<string, unknown>) => ({
    messageId: String(t.id ?? ""),
    subject: String(t.title ?? ""),
    bodyPreview: String(t.description ?? ""),
    senderName: String(t.client_name ?? "Unknown"),
    senderEmail: "",
    quadrant: String(t.quadrant ?? ""),
    receivedDateTime: null,
  }))

  aiInputTokensTotal = 0; aiOutputTokensTotal = 0
  const aiTasks = await extractTasksWithAi(messages)

  let updated = 0
  for (const task of tasks) {
    const ai = aiTasks.get(task.id as string)
    if (ai && ai.title !== task.title) {
      const { error: updateError } = await sb
        .from("eisenhower_tasks")
        .update({ title: ai.title, description: ai.description, updated_at: new Date().toISOString() })
        .eq("id", task.id)
      if (!updateError) updated++
    }
  }

  await logAiCost("email_task_reprocess")

  return new Response(JSON.stringify({ reprocessed: updated, total: tasks.length, ai_processed: aiTasks.size }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } })
}

async function handleBackfillDates(): Promise<Response> {
  const sb = getServiceClient()
  const accessToken = await getAccessToken()

  const { data: tasks, error } = await sb
    .from("eisenhower_tasks")
    .select("id, source_email_id")
    .eq("source_type", "email")
    .is("email_received_at", null)
    .not("source_email_id", "is", null)

  if (error) throw error
  if (!tasks || tasks.length === 0) {
    return new Response(JSON.stringify({ updated: 0, summary: "No tasks need date backfill." }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } })
  }

  let updated = 0; let failed = 0
  for (const task of tasks) {
    try {
      const msg = await graphGet(accessToken, `/me/messages/${task.source_email_id}?$select=receivedDateTime`)
      if (msg.receivedDateTime) {
        const { error: updateError } = await sb
          .from("eisenhower_tasks")
          .update({ email_received_at: msg.receivedDateTime, updated_at: new Date().toISOString() })
          .eq("id", task.id)
        if (!updateError) updated++; else failed++
      }
    } catch (err) {
      console.warn(`Failed to fetch date for task ${task.id}:`, err)
      failed++
    }
  }

  return new Response(JSON.stringify({ updated, failed, total: tasks.length, summary: `Backfilled ${updated} of ${tasks.length} tasks.` }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } })
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders })

  try {
    const url = new URL(req.url)
    const reprocess = url.searchParams.get("reprocess") === "true"
    const backfillDates = url.searchParams.get("backfill_dates") === "true"

    if (backfillDates) return await handleBackfillDates()
    if (reprocess) return await handleReprocess()

    const accessToken = await getAccessToken()
    const sb = getServiceClient()

    // 1. List top-level mail folders and find Inbox
    const foldersData = await graphGet(accessToken, "/me/mailFolders?$top=100")
    const topFolders: Array<{ id: string; displayName: string }> = foldersData.value || []
    const inbox = topFolders.find((f) => f.displayName === "Inbox")
    if (!inbox) {
      return new Response(JSON.stringify({ error: "Inbox not found", top_folders: topFolders.map((f) => f.displayName) }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } })
    }

    // 2. Inbox children → match EA folders
    const inboxChildData = await graphGet(accessToken, `/me/mailFolders/${inbox.id}/childFolders?$top=100`)
    const allChildren: Array<{ id: string; displayName: string; totalItemCount?: number }> = inboxChildData.value || []
    const eaFolders = allChildren.filter((f) => FOLDER_MAP[f.displayName])
    if (eaFolders.length === 0) {
      return new Response(JSON.stringify({
        error: "No matching folders found",
        inbox_children: allChildren.map((f) => ({ name: f.displayName, items: f.totalItemCount })),
      }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } })
    }

    // 3. Fetch messages
    const allMessages: EmailMessage[] = []
    for (const folder of eaFolders) {
      const quadrant = FOLDER_MAP[folder.displayName]
      if (!quadrant) continue
      const messagesData = await graphGet(accessToken,
        `/me/mailFolders/${folder.id}/messages?$top=25&$select=id,subject,bodyPreview,from,receivedDateTime&$orderby=receivedDateTime desc`)
      for (const msg of (messagesData.value || [])) {
        allMessages.push({
          messageId: msg.id,
          subject: msg.subject || "(No subject)",
          bodyPreview: msg.bodyPreview || "",
          senderName: msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || "Unknown",
          senderEmail: msg.from?.emailAddress?.address || "",
          quadrant,
          receivedDateTime: msg.receivedDateTime || null,
        })
      }
    }

    if (allMessages.length === 0) {
      return new Response(JSON.stringify({ created: 0, summary: "Folders found but no messages in them yet.", details: {} }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } })
    }

    // 4. Dedup: only fetch existing rows for the messageIds we're about to consider
    //    (NB: this uses the .in() pattern; the older fetch-all-then-filter pattern was the
    //    cause of the runaway noted in INFRASTRUCTURE.md.)
    const messageIds = allMessages.map((m) => m.messageId)
    const { data: existingTasks, error: queryError } = await sb
      .from("eisenhower_tasks")
      .select("source_email_id, source_email_ids")
      .eq("source_type", "email")
      .in("source_email_id", messageIds)
    if (queryError) throw queryError

    const existingIds = new Set<string>()
    for (const t of (existingTasks || [])) {
      if (t.source_email_id) existingIds.add(t.source_email_id)
      if (t.source_email_ids) {
        for (const eid of t.source_email_ids) existingIds.add(eid)
      }
    }
    const newMessages = allMessages.filter((m) => !existingIds.has(m.messageId))

    if (newMessages.length === 0) {
      return new Response(JSON.stringify({ created: 0, summary: "No new tasks to create (all emails already synced).", details: {} }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } })
    }

    // 5. Group by sender
    const senderGroups = new Map<string, EmailMessage[]>()
    for (const msg of newMessages) {
      const key = msg.senderEmail.toLowerCase() || msg.senderName
      if (!senderGroups.has(key)) senderGroups.set(key, [])
      senderGroups.get(key)!.push(msg)
    }

    // 6. Process per-sender (concurrency-limited)
    aiInputTokensTotal = 0; aiOutputTokensTotal = 0
    const CONCURRENCY = 5
    const senderEntries = Array.from(senderGroups.entries())
    const allConsolidatedTasks: ConsolidatedTask[] = []
    let aiBatchCount = 0

    for (let i = 0; i < senderEntries.length; i += CONCURRENCY) {
      const batch = senderEntries.slice(i, i + CONCURRENCY)
      const batchResults = await Promise.all(
        batch.map(async ([senderKey, senderMessages]) => {
          if (senderMessages.length === 1) {
            const aiTasks = await extractTasksWithAi(senderMessages)
            const msg = senderMessages[0]
            const ai = aiTasks.get(msg.messageId)
            return {
              tasks: [{
                title: ai?.title || msg.subject,
                description: ai?.description || msg.bodyPreview.substring(0, 500),
                quadrant: msg.quadrant,
                senderName: msg.senderName,
                messageIds: [msg.messageId],
                primaryMessageId: msg.messageId,
                receivedDateTime: msg.receivedDateTime,
              }] as ConsolidatedTask[],
              hadAi: !!ai,
            }
          } else {
            console.log(`Consolidating ${senderMessages.length} emails from ${senderKey}`)
            const consolidated = await consolidateSenderEmails(senderKey, senderMessages)
            return { tasks: consolidated, hadAi: true }
          }
        })
      )
      for (const result of batchResults) {
        allConsolidatedTasks.push(...result.tasks)
        if (result.hadAi) aiBatchCount++
      }
    }

    // 7. Insert
    const details: Record<string, number> = { do: 0, schedule: 0, delegate: 0, eliminate: 0 }
    const rows = allConsolidatedTasks.map((t) => {
      details[t.quadrant] = (details[t.quadrant] || 0) + 1
      return {
        title: t.title,
        description: t.description,
        quadrant: t.quadrant,
        source_type: "email",
        source_email_id: t.primaryMessageId,
        source_email_ids: t.messageIds.length > 1 ? t.messageIds : null,
        client_name: t.senderName,
        status: "open",
        email_received_at: t.receivedDateTime || null,
      }
    })

    const { error: insertError } = await sb.from("eisenhower_tasks").insert(rows)
    if (insertError) throw insertError

    const consolidatedCount = allConsolidatedTasks.filter((t) => t.messageIds.length > 1).length
    const summaryParts = Object.entries(details)
      .filter(([, count]) => count > 0)
      .map(([q, count]) => `${count} ${q.charAt(0).toUpperCase() + q.slice(1)}`)
    const summary = `Created ${allConsolidatedTasks.length} tasks from ${newMessages.length} emails (${consolidatedCount} consolidated): ${summaryParts.join(", ")}`

    // 8. Cost log (Claude Haiku 4.5)
    if (aiBatchCount > 0) await logAiCost("email_task_extraction")

    return new Response(JSON.stringify({
      created: allConsolidatedTasks.length,
      emails_processed: newMessages.length,
      consolidated: consolidatedCount,
      summary,
      details,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("ms-outlook-folders error:", message)
    return new Response(JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } })
  }
})
