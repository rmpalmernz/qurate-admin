// Send the daily brief by email.
//
// Flow:
//   1. Calls daily-brief Edge Function. If today's brief is already cached in
//      ai_daily_briefs (one row per brief_date), daily-brief returns the cached
//      copy. Otherwise it generates and persists a fresh one.
//   2. Skip if today's brief is already marked sent_at, unless body.force === true.
//   3. Get a fresh MS Graph access token via ms-auth (Vault-stored refresh token).
//   4. Look up the user's email via /me.
//   5. Render markdown → HTML.
//   6. POST /me/sendMail.
//   7. Update ai_daily_briefs.sent_at = now() for today's brief_date.
//
// Triggered by:
//   - pg_cron 'send-brief-daily' on weekdays at 20:30 UTC (= 06:30 AEST / 07:30 AEDT)
//   - dashboard "Send brief now" button (future), or manual curl.
//
// Authentication: relies on the caller having a valid Supabase anon JWT (cron uses
// anon key in the Authorization header). The function uses service-role internally
// to read/write user_preferences and ai_daily_briefs.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { marked } from "https://esm.sh/marked@13";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const GRAPH = "https://graph.microsoft.com/v1.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function getServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

async function getMsAccessToken(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/ms-auth`, {
    headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ms-auth ${res.status}: ${body}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.access_token as string;
}

interface BriefResponse { brief: string; briefDate?: string; brief_date?: string }

async function fetchOrGenerateBrief(force: boolean): Promise<{ markdown: string; briefDate: string }> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/daily-brief`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ forceRefresh: force }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`daily-brief ${res.status}: ${body}`);
  }
  const data = await res.json() as BriefResponse;
  if (!data.brief) throw new Error("daily-brief returned no brief content");
  return {
    markdown: data.brief,
    briefDate: data.briefDate ?? data.brief_date ?? new Date().toISOString().split("T")[0],
  };
}

async function getUserEmail(accessToken: string): Promise<string> {
  const res = await fetch(`${GRAPH}/me?$select=mail,userPrincipalName,displayName`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`/me ${res.status}: ${body}`);
  }
  const me = await res.json();
  const email = me.mail || me.userPrincipalName;
  if (!email) throw new Error("/me returned no email");
  return email as string;
}

async function sendMail(accessToken: string, to: string, subject: string, html: string) {
  const body = {
    message: {
      subject,
      body: { contentType: "HTML", content: html },
      toRecipients: [{ emailAddress: { address: to } }],
      importance: "high",
    },
    saveToSentItems: "true",
  };
  const res = await fetch(`${GRAPH}/me/sendMail`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`sendMail ${res.status}: ${text}`);
  }
}

function htmlEnvelope(innerHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; max-width: 680px; margin: 0 auto; padding: 24px; line-height: 1.55; color: #1f2937; }
  h1 { color: #0f172a; border-bottom: 2px solid #c19131; padding-bottom: 8px; margin-top: 0; }
  h2 { color: #c19131; margin-top: 28px; font-size: 16px; text-transform: uppercase; letter-spacing: 0.5px; }
  h3 { color: #0f172a; margin-top: 18px; }
  ul, ol { padding-left: 24px; }
  li { margin: 4px 0; }
  strong { color: #0f172a; }
  blockquote { margin: 16px 0; padding: 8px 14px; border-left: 3px solid #c19131; color: #475569; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
  code { background: #f1f5f9; padding: 1px 6px; border-radius: 3px; font-size: 13px; }
  table { border-collapse: collapse; margin: 12px 0; }
  td, th { padding: 6px 10px; border: 1px solid #e5e7eb; text-align: left; }
</style></head><body>${innerHtml}</body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let force = false;
    let skipIfSent = true;
    try {
      const body = await req.json();
      force = body?.force === true;
      // Setting force=true also bypasses the "already sent today" guard.
      if (force) skipIfSent = false;
      else if (body?.skipIfSent === false) skipIfSent = false;
    } catch {
      // empty body — keep defaults
    }

    const sb = getServiceClient();

    // 1. Fetch or generate today's brief.
    const { markdown, briefDate } = await fetchOrGenerateBrief(force);

    // 2. Idempotency: skip if already sent today (unless force).
    if (skipIfSent) {
      const { data: row } = await sb
        .from("ai_daily_briefs")
        .select("sent_at")
        .eq("brief_date", briefDate)
        .maybeSingle();
      if (row?.sent_at) {
        return new Response(
          JSON.stringify({
            skipped: true,
            reason: "already_sent",
            brief_date: briefDate,
            sent_at: row.sent_at,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // 3. Microsoft access token + user email.
    const accessToken = await getMsAccessToken();
    const userEmail = await getUserEmail(accessToken);

    // 4. Render brief markdown → HTML envelope.
    const innerHtml = await marked.parse(markdown);
    const fullHtml = htmlEnvelope(innerHtml as string);

    // 5. Send.
    const dateLabel = new Date(briefDate + "T00:00:00").toLocaleDateString("en-AU", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    await sendMail(accessToken, userEmail, `Daily Brief — ${dateLabel}`, fullHtml);

    // 6. Record send.
    const sentAt = new Date().toISOString();
    const { error: updateErr } = await sb
      .from("ai_daily_briefs")
      .update({ sent_at: sentAt })
      .eq("brief_date", briefDate);
    if (updateErr) {
      console.warn("Failed to mark sent_at:", updateErr.message);
    }

    return new Response(
      JSON.stringify({
        success: true,
        brief_date: briefDate,
        sent_to: userEmail,
        sent_at: sentAt,
        bytes: fullHtml.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("send-brief error:", message);
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
