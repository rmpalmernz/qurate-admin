// ms-calendar — pulls Microsoft Graph /me/calendarview and (optionally) upserts into calendar_events.
//
// Query params:
//   start    ISO datetime (default: now)
//   end      ISO datetime (default: end of `start`'s day)
//   persist  "true" (default) to upsert into calendar_events; "false" to skip persistence
//
// Triggers:
//   - pg_cron `sync-calendar-30min` every 30 min for the next 14 days
//   - dashboard CalendarTab when the cache is empty or stale
//
// Returns: { events: [...], persist: { upserted, errors } }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
}

const GRAPH_BASE = "https://graph.microsoft.com/v1.0"
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/ms-auth`, {
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
  })
  if (!res.ok) throw new Error(`Failed to get access token: ${await res.text()}`)
  const { access_token, error } = await res.json()
  if (error) throw new Error(error)
  return access_token
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders })

  try {
    const url = new URL(req.url)
    const startDate = url.searchParams.get("start") || new Date().toISOString()
    const endParam = url.searchParams.get("end")
    const persist = url.searchParams.get("persist") !== "false"

    let endDate: string
    if (endParam) {
      endDate = endParam
    } else {
      const d = new Date(startDate)
      d.setHours(23, 59, 59, 999)
      endDate = d.toISOString()
    }

    const accessToken = await getAccessToken()
    const graphUrl = `${GRAPH_BASE}/me/calendarview?startdatetime=${encodeURIComponent(startDate)}&enddatetime=${encodeURIComponent(endDate)}&$orderby=start/dateTime&$top=50&$select=subject,start,end,location,attendees,isAllDay,bodyPreview,organizer,isCancelled,responseStatus`

    const graphRes = await fetch(graphUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="Australia/Sydney"' },
    })
    if (!graphRes.ok) throw new Error(`Graph API error [${graphRes.status}]: ${await graphRes.text()}`)
    const data = await graphRes.json()

    type GraphEvent = { id: string; subject: string; start?: { dateTime?: string }; end?: { dateTime?: string }; isAllDay?: boolean; location?: { displayName?: string }; bodyPreview?: string; organizer?: { emailAddress?: { name?: string; address?: string } }; attendees?: Array<{ emailAddress?: { name?: string; address?: string }; status?: { response?: string } }>; isCancelled?: boolean; responseStatus?: { response?: string } }

    const events = (data.value || []).map((e: GraphEvent) => ({
      graph_event_id: e.id,
      subject: e.subject,
      start_time: e.start?.dateTime ? e.start.dateTime + "+11:00" : null,
      end_time: e.end?.dateTime ? e.end.dateTime + "+11:00" : null,
      is_all_day: e.isAllDay ?? false,
      location: e.location?.displayName ?? "",
      body_preview: e.bodyPreview ?? "",
      organizer_name: e.organizer?.emailAddress?.name ?? "",
      organizer_email: e.organizer?.emailAddress?.address ?? "",
      attendees: (e.attendees ?? []).map((a) => ({
        name: a.emailAddress?.name ?? "",
        email: a.emailAddress?.address ?? "",
        response: a.status?.response ?? "none",
      })),
      is_cancelled: e.isCancelled ?? false,
      response_status: e.responseStatus?.response ?? "none",
      synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }))

    let persistResult = { upserted: 0, errors: 0 }
    if (persist && events.length > 0) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
      const { error: upsertError } = await supabase
        .from("calendar_events")
        .upsert(events, { onConflict: "graph_event_id" })
      if (upsertError) {
        console.error("Calendar persist error:", upsertError)
        persistResult.errors = 1
      } else {
        persistResult.upserted = events.length
      }
    }

    const cleanEvents = events.map((e: { graph_event_id: string; subject: string; start_time: string | null; end_time: string | null; location: string; is_all_day: boolean; body_preview: string; organizer_name: string; attendees: Array<{ name: string; email: string }> }) => ({
      id: e.graph_event_id,
      subject: e.subject,
      start: e.start_time,
      end: e.end_time,
      location: e.location,
      isAllDay: e.is_all_day,
      bodyPreview: e.body_preview,
      organizer: e.organizer_name,
      attendees: e.attendees.map((a) => a.name || a.email),
    }))

    return new Response(JSON.stringify({ events: cleanEvents, persist: persistResult }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("ms-calendar error:", message)
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }
})
