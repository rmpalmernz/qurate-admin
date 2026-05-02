// Microsoft OAuth orchestration.
// Source-controlled mirror of the deployed Edge Function (project btzlkiwmdegubbvzbmyo).
//
// Storage model (2026-05-02 Vault refactor):
//   - The refresh token is stored encrypted in Supabase Vault under the secret name
//     'microsoft_refresh_token'. Access via SECURITY DEFINER wrappers in the public schema:
//        public.set_ms_refresh_token(text)
//        public.get_ms_refresh_token() returns text
//        public.delete_ms_refresh_token()
//        public.has_ms_refresh_token() returns boolean
//   - Access tokens are NEVER persisted. Every "give me an access token" call exchanges
//     the stored refresh token at Microsoft and returns a fresh access token to the caller.
//     ~300-500ms latency per call, but no bearer credential at rest.
//
// Scopes (2026-05-02): Calendars.Read, Mail.ReadWrite, Sites.Read.All, Files.Read.All,
// offline_access. Adding a new scope requires a fresh user consent flow (prompt=consent).

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

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

async function getStoredRefreshToken(): Promise<string | null> {
  const sb = getServiceClient();
  const { data, error } = await sb.rpc("get_ms_refresh_token");
  if (error) throw new Error(`Failed to read refresh token from Vault: ${error.message}`);
  return (data as string | null) ?? null;
}

async function storeRefreshToken(token: string): Promise<void> {
  const sb = getServiceClient();
  const { error } = await sb.rpc("set_ms_refresh_token", { token });
  if (error) throw new Error(`Failed to store refresh token in Vault: ${error.message}`);
}

async function deleteRefreshToken(): Promise<void> {
  const sb = getServiceClient();
  const { error } = await sb.rpc("delete_ms_refresh_token");
  if (error) throw new Error(`Failed to delete refresh token from Vault: ${error.message}`);
}

async function hasRefreshToken(): Promise<boolean> {
  const sb = getServiceClient();
  const { data, error } = await sb.rpc("has_ms_refresh_token");
  if (error) throw new Error(`Failed to check refresh token presence: ${error.message}`);
  return Boolean(data);
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
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

  return await res.json() as TokenResponse;
}

async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<TokenResponse> {
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

  return await res.json() as TokenResponse;
}

// Always exchanges the stored refresh token for a fresh access token. If MS rotates
// the refresh token, the new one is persisted to Vault. Access token is returned to
// the caller, never stored.
async function getFreshAccessToken(): Promise<string> {
  const stored = await getStoredRefreshToken();
  if (!stored) {
    throw new Error("Not connected to Microsoft. Please sign in again.");
  }
  const refreshed = await refreshAccessToken(stored);
  if (refreshed.refresh_token && refreshed.refresh_token !== stored) {
    await storeRefreshToken(refreshed.refresh_token);
  }
  return refreshed.access_token;
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
      // prompt=consent forces re-consent so newly-added scopes get explicitly granted.
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
      if (!tokens.refresh_token) {
        throw new Error("OAuth response missing refresh_token (offline_access scope not granted?)");
      }
      await storeRefreshToken(tokens.refresh_token);

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "disconnect") {
      await deleteRefreshToken();
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "status") {
      const connected = await hasRefreshToken();
      return new Response(JSON.stringify({ connected }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Default: return a fresh access token. Refreshes from the Vault-stored refresh
    // token on every call. Access token is not persisted anywhere.
    const accessToken = await getFreshAccessToken();
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
