// Microsoft OAuth orchestration + token storage.
// Source-controlled mirror of the deployed Edge Function (project btzlkiwmdegubbvzbmyo).
// When you change this file, deploy with `supabase functions deploy ms-auth` (or via MCP).
//
// Scope additions (2026-05-02): Sites.Read.All + Files.Read.All to support sync-vips
// reading Qurate client folders from SharePoint and personal OneDrive.
// IMPORTANT: existing tokens were granted only Calendars.Read + Mail.ReadWrite + offline_access.
// After deploying this update, the user must disconnect + reconnect to grant the new scopes.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const TENANT_ID = Deno.env.get("AZURE_TENANT_ID")!;
const CLIENT_ID = Deno.env.get("AZURE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("AZURE_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TOKEN_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
const SCOPES = [
  "https://graph.microsoft.com/Calendars.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Sites.Read.All",
  "https://graph.microsoft.com/Files.Read.All",
  "offline_access",
].join(" ");

function getServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

async function getStoredToken() {
  const sb = getServiceClient();
  const { data, error } = await sb
    .from("microsoft_oauth_tokens")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (error && error.code !== "PGRST116") throw error;
  return data;
}

async function refreshAccessToken(refreshToken: string) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: SCOPES,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed [${res.status}]: ${err}`);
  }

  return await res.json();
}

async function exchangeCodeForTokens(code: string, redirectUri: string) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    scope: SCOPES,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Code exchange failed [${res.status}]: ${err}`);
  }

  return await res.json();
}

async function storeTokens(tokens: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}) {
  const sb = getServiceClient();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  await sb.from("microsoft_oauth_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");

  const { error } = await sb.from("microsoft_oauth_tokens").insert({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
    scope: tokens.scope || SCOPES,
  });

  if (error) throw error;
}

async function getValidAccessToken(): Promise<string> {
  const stored = await getStoredToken();
  if (!stored) throw new Error("No Microsoft tokens found. Please connect your Outlook account first.");

  const expiresAt = new Date(stored.expires_at).getTime();
  const now = Date.now();

  if (now > expiresAt - 5 * 60 * 1000) {
    const refreshed = await refreshAccessToken(stored.refresh_token);
    await storeTokens(refreshed);
    return refreshed.access_token;
  }

  return stored.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    if (action === "login") {
      const redirectUri = url.searchParams.get("redirect_uri");
      if (!redirectUri) {
        return new Response(JSON.stringify({ error: "redirect_uri required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const authUrl = new URL(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`);
      authUrl.searchParams.set("client_id", CLIENT_ID);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", SCOPES);
      authUrl.searchParams.set("response_mode", "query");
      // prompt=consent forces re-consent, ensuring the user explicitly grants any newly added scopes.
      authUrl.searchParams.set("prompt", "consent");

      return new Response(JSON.stringify({ auth_url: authUrl.toString() }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "callback") {
      const { code, redirect_uri } = await req.json();
      if (!code || !redirect_uri) {
        return new Response(JSON.stringify({ error: "code and redirect_uri required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const tokens = await exchangeCodeForTokens(code, redirect_uri);
      await storeTokens(tokens);

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "disconnect") {
      const sb = getServiceClient();
      await sb.from("microsoft_oauth_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "status") {
      const stored = await getStoredToken();
      const connected = !!stored;
      const scope = stored?.scope || null;
      return new Response(JSON.stringify({ connected, scope }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accessToken = await getValidAccessToken();
    return new Response(JSON.stringify({ access_token: accessToken }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("ms-auth error:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
