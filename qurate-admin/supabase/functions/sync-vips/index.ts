// Sync VIP company list from SharePoint + OneDrive folder names.
//
// Reads three sources every cron tick:
//   1. SharePoint site quratepty.sharepoint.com/sites/QurateClient
//        /Shared Documents/02.  Work in Progress/Qurate Clients - <COMPANY>
//   2. Same site
//        /Shared Documents/01.  Archive/Qurate Clients - <COMPANY>
//   3. Personal OneDrive (richard's drive)
//        /1. Own - Engagements/<N>.  <COMPANY>
//
// Extracts company names, dedupes, writes to user_preferences.vip_companies_auto.
// Also writes user_preferences.vip_companies_auto_synced_at as an ISO timestamp.
//
// Required scopes on the MS access token: Sites.Read.All, Files.Read.All.
// Authentication: calls the ms-auth Edge Function via service-role to get a fresh access token.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GRAPH = "https://graph.microsoft.com/v1.0";

const SITE_HOSTNAME = "quratepty.sharepoint.com";
const SITE_PATH = "/sites/QurateClient";
// Paths relative to the site's default drive root. "Shared Documents" IS the drive root,
// so we don't include it in the folder path.
const SITE_WIP_FOLDER = "02.  Work in Progress";
const SITE_ARCHIVE_FOLDER = "01.  Archive";
const ONEDRIVE_ENGAGEMENTS_FOLDER = "1. Own - Engagements";

// Folder name → company name regex.
const QURATE_PATTERN = /^Qurate Clients - (.+?)$/i;
const NUMBERED_PATTERN = /^\d+\.\s+(.+)$/;

// Reject anything containing these tokens (junk / cleanup folders).
const REJECT_TOKENS = ["duplicate", "removed", "_to_delete", "old", "archive", "archived"];

// Hand-curated abbreviation expansion for OneDrive folder names that use shortened forms.
// Keys are case-insensitive matches against the raw extracted name; values are the
// canonical company name we store in user_preferences.
const ABBREVIATION_MAP: Record<string, string> = {
  "lop": "Land of Plenty",
  "thinkwater": "Think Water",
  "tw": "Think Water",
};

function getServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

async function getAccessToken(): Promise<string> {
  const sb = getServiceClient();
  const { data, error } = await sb.functions.invoke("ms-auth", { method: "GET" });
  if (error || data?.error) {
    throw new Error(data?.error || error?.message || "Failed to get MS access token");
  }
  return data.access_token as string;
}

async function graph<T = unknown>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${GRAPH}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph ${res.status} on ${path}: ${text}`);
  }
  return await res.json() as T;
}

interface DriveItem {
  id: string;
  name: string;
  folder?: { childCount?: number };
  file?: unknown;
}

interface DriveItemList { value?: DriveItem[] }
interface SiteResponse { id: string }

// Encode a folder path for use after `:/` in a Graph URL.
// Each segment is URL-encoded but `/` separators are preserved.
function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

async function listFolderChildren(
  accessToken: string,
  driveRootRef: string,
  folderPath: string,
): Promise<string[]> {
  // driveRootRef examples:
  //   "/sites/{site-id}/drive"   (site)
  //   "/me/drive"                (personal OneDrive)
  const path = `${driveRootRef}/root:/${encodePath(folderPath)}:/children?$top=200&$select=id,name,folder,file`;
  let names: string[] = [];
  let next: string | null = path;
  while (next) {
    const url: string = next.startsWith("http") ? next : `${GRAPH}${next}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Graph ${res.status} listing ${folderPath}: ${text}`);
    }
    const data: DriveItemList & { "@odata.nextLink"?: string } = await res.json();
    const items = data.value ?? [];
    for (const item of items) {
      if (item.folder) names.push(item.name);
    }
    next = data["@odata.nextLink"] ?? null;
  }
  return names;
}

async function resolveSiteId(accessToken: string, hostname: string, sitePath: string): Promise<string> {
  // Trim leading slash so we get /sites/{hostname}:/sites/QurateClient (one slash between)
  const trimmed = sitePath.startsWith("/") ? sitePath.slice(1) : sitePath;
  const site = await graph<SiteResponse>(accessToken, `/sites/${hostname}:/${trimmed}`);
  return site.id;
}

function extractName(folder: string, pattern: RegExp): string | null {
  const m = folder.match(pattern);
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const tok of REJECT_TOKENS) {
    if (lower.includes(tok)) return null;
  }
  // Apply abbreviation expansion if we have a known mapping for the lowered+stripped key.
  const key = lower.replace(/[^a-z0-9]/g, "");
  if (ABBREVIATION_MAP[key]) return ABBREVIATION_MAP[key];
  return raw;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const accessToken = await getAccessToken();

    // 1. Resolve the QurateClient site to get its driveRef.
    const siteId = await resolveSiteId(accessToken, SITE_HOSTNAME, SITE_PATH);
    const siteDriveRef = `/sites/${siteId}/drive`;

    // 2. List from each source. Per-source failure → empty result + recorded error.
    const errors: Record<string, string> = {};
    const safeList = (
      label: string,
      driveRef: string,
      folderPath: string,
    ): Promise<string[]> => listFolderChildren(accessToken, driveRef, folderPath).catch(e => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`${label} list failed:`, msg);
      errors[label] = msg;
      return [] as string[];
    });

    const [wipFolders, archiveFolders, ownFolders] = await Promise.all([
      safeList("wip", siteDriveRef, SITE_WIP_FOLDER),
      safeList("archive", siteDriveRef, SITE_ARCHIVE_FOLDER),
      safeList("own", "/me/drive", ONEDRIVE_ENGAGEMENTS_FOLDER),
    ]);

    // 3. Extract company names per pattern.
    const wipNames = wipFolders.map(f => extractName(f, QURATE_PATTERN)).filter((n): n is string => !!n);
    const archiveNames = archiveFolders.map(f => extractName(f, QURATE_PATTERN)).filter((n): n is string => !!n);
    const ownNames = ownFolders.map(f => extractName(f, NUMBERED_PATTERN)).filter((n): n is string => !!n);

    // 4. Dedupe (case-insensitive) preserving first occurrence's casing, and sort.
    const seen = new Set<string>();
    const all: string[] = [];
    for (const n of [...wipNames, ...ownNames, ...archiveNames]) {
      const key = n.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(n);
    }
    all.sort((a, b) => a.localeCompare(b));

    // 5. Upsert to user_preferences.
    const sb = getServiceClient();
    const now = new Date().toISOString();
    const { error: upsertErr } = await sb.from("user_preferences").upsert([
      { key: "vip_companies_auto", value: all, updated_at: now },
      { key: "vip_companies_auto_synced_at", value: now, updated_at: now },
    ], { onConflict: "key" });
    if (upsertErr) throw upsertErr;

    return new Response(
      JSON.stringify({
        success: true,
        count: all.length,
        names: all,
        sources: {
          wip: wipNames.length,
          archive: archiveNames.length,
          own: ownNames.length,
        },
        errors: Object.keys(errors).length > 0 ? errors : undefined,
        synced_at: now,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("sync-vips error:", message);
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
