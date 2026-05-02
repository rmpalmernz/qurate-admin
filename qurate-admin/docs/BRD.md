# BRD — Qurate Admin Agent (Current State)

## Context

You set out to build a personal admin agent that ingests your Microsoft 365 inbox + calendar and helps you decide what to focus on. What exists today is a working **single-user Next.js PWA** wired to Microsoft Graph and Anthropic Claude (via Supabase Edge Functions), with a 7-tab dashboard centred on the Eisenhower matrix. This BRD documents what has actually shipped vs. what is stubbed, so the next build phase can be planned accurately.

Scope: an as-built audit of the repo. No code changes are proposed here.

---

## 1. Product Summary

**Pitch:** "Personal EA dashboard for an executive — email, calendar, tasks, and AI reasoning in one mobile-first PWA."

**Primary user:** Hardcoded as "Richard" — single-user deployment.

**Core value loop today:**
1. User signs in with Microsoft → 2. Dashboard pulls 50 most recent emails + 14 days of calendar → 3. AI generates a morning brief, drafts replies, and answers chat queries → 4. User triages emails into the Eisenhower matrix and tracks VIP clients.

---

## 2. Functional Capabilities — Built vs Partial vs Missing

### Fully built and working

| Capability | Where | Notes |
|---|---|---|
| Microsoft OAuth login | `app/page.tsx`, `app/api/auth/callback/route.ts` | Token never touches browser; HttpOnly cookie `ms_auth_connected` (30-day) |
| Route guard | `middleware.ts` | Cookie check on `/dashboard/*` |
| Inbox fetch (50 most recent) | `app/dashboard/page.tsx` `loadEmails()` | Direct call to Graph `/me/messages` |
| 14-day calendar | `app/dashboard/page.tsx` `loadCalendar()` | Graph `/me/calendarView`; UTC `Z`-suffix fix included |
| Send email | `app/dashboard/page.tsx` `sendEmail()` | Graph `/me/sendMail` |
| AI reply drafting | `/draft-reply` Edge Function | Claude Haiku |
| Morning briefing | `BriefingTab` → `/chat` Edge Function | Claude Haiku; persists to `ai_daily_briefs` |
| Chat assistant | `ChatTab` → `/chat` Edge Function | Multi-turn, markdown rendering, quick-action buttons |
| Eisenhower matrix CRUD | `MatrixTab` | Drag-to-reorder, drag-to-merge, status transitions |
| Email → quadrant mapping | `emailToQuadrant()` | Reads upstream `ai_priority_level` / `ai_category` |
| VIP client tracker | `ClientsTab` | Email count, last contact, urgent task count |
| Settings | `SettingsTab` | Briefing time, focus block window, VIP list |
| PWA install | `public/manifest.json`, `public/sw.js` | iOS/Android installable |
| Sign out / token revoke | `app/api/auth/logout/route.ts` | |

### Partially built / depends on something outside the repo

| Capability | Gap |
|---|---|
| AI email categorisation (`ai_quadrant`, `ai_priority_level`, `ai_category`, `ai_client_name`) | **Consumed by the UI but not produced anywhere in this repo.** Assumes an upstream ingestion pipeline. Without it, fallback rules in `emailCategory()` handle by domain only. |
| Settings persistence | Stored in browser `localStorage` only — not synced to Supabase, lost on device change |
| Auto-archive rules | Displayed in Settings UI but not enforced anywhere |
| MS access token refresh | Fetched once on dashboard mount; long sessions may fail silently |
| Briefing scheduling | "Briefing time" preference exists in Settings but no scheduler runs it; the brief is only generated when the user clicks the button |

### Not implemented

- Multi-user support (no `user_id` column anywhere; "Richard" hardcoded into prompts)
- Inbox search / filter beyond quadrant
- Calendar event create / edit / RSVP
- Task recurrence
- Background workers / cron / scheduled briefing generation
- Tests (unit, integration, e2e)
- `.env.example` file
- Email-to-task extraction (creating Eisenhower tasks directly from an email thread)

---

## 3. Technical Architecture (as-built)

```
Browser (Next.js 14.2 App Router PWA, React 18, TS, Tailwind)
   │
   ├── /                       Login
   ├── /dashboard              7-tab SPA (~2,300 lines in one file)
   ├── /api/auth/callback      OAuth code exchange → cookie
   └── /api/auth/logout        Token revoke + cookie clear
        │
        ▼
Supabase Edge Functions (Deno) — secrets live here, NOT in this repo
   ├── /ms-auth      Azure AD OAuth orchestration + token mgmt
   ├── /chat         Anthropic proxy (Haiku/Sonnet routing)
   └── /draft-reply  Single-shot reply generator (Haiku)
        │
        ├──▶ Microsoft Graph v1.0  (/me/messages, /me/calendarView, /me/sendMail)
        └──▶ Anthropic Claude API

Supabase Postgres (called directly from browser via REST + anon key)
   ├── eisenhower_tasks     CRUD
   └── ai_daily_briefs      Read + insert
```

**Key design decisions worth knowing before extending:**
- Anthropic and Microsoft secrets only exist server-side in Edge Function secrets — the browser holds no privileged credentials beyond the Supabase anon key + an OAuth session cookie.
- The dashboard is one ~2,300-line component. Any new feature beyond a small tweak should probably begin with a refactor (see §6).
- Eisenhower mapping is the spine of the product — both email triage and task management feed it.

---

## 4. Data Model

`eisenhower_tasks` (uuid PK, no `user_id`)
- `title`, `description`, `quadrant` (q1–q4), `status` (open/in_progress/waiting/done/cancelled), `client_name`, `due_date`, `estimated_minutes`, `priority_score`, `delegation_channel`, `email_ids[]` (source emails), `tags[]`, `created_at`

`ai_daily_briefs` (uuid PK, no `user_id`)
- `brief_text` (markdown), `created_at`

**RLS:** README states it should be on; verify before sharing the anon key publicly.

---

## 5. External Dependencies & Config

**In `.env.local`:**
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

**In Supabase Edge Function secrets (not in repo):**
- `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`
- `ANTHROPIC_API_KEY`
- `SITE_URL`

**No `.env.example` exists** — onboarding a second engineer requires the README + Supabase dashboard access.

---

## 6. Recommended Build Roadmap

Ordered by value × leverage.

### A. Close the loop the product currently leaks
1. **Build the email categorisation pipeline.** Today the UI reads `ai_quadrant` / `ai_priority_level` / `ai_category` / `ai_client_name`, but nothing writes them. Add a Supabase Edge Function that runs on inbox fetch (or on a schedule), classifies each email via Claude, writes to a new `email_classifications` table keyed by Graph `message.id`. Without this, inbox triage is mostly heuristic.
2. **Email → Task extraction.** Add a button on each email that calls a new `/extract-tasks` Edge Function (Claude Haiku) and inserts directly into `eisenhower_tasks` with `email_ids` set. Single biggest UX win — converts inbox triage into matrix progress.
3. **Persist Settings to Supabase.** Move briefing time / focus block / VIP list out of `localStorage` into a `user_settings` table. Required before scheduled briefings work.

### B. Make the agent autonomous, not on-demand
4. **Scheduled morning briefing.** Supabase pg_cron or scheduled Edge Function fires at the user's `briefing_time`, generates the brief, sends a push notification (PWA) or email.
5. **Proactive token refresh.** Move MS token refresh into a periodic Edge Function call rather than once-per-mount.

### C. Structural debt that will block future features
6. **Decompose `app/dashboard/page.tsx`.** Each `*Tab` function should become its own file under `app/dashboard/_components/`. Hoist data-fetching hooks into `app/dashboard/_hooks/`. Currently the biggest blocker to parallel work.
7. **Add a `user_id` everywhere.** Even if you stay single-user, this is far cheaper to do now than after data accumulates. Add the column, set via RLS `auth.uid()`, parameterise all queries.
8. **Drop a smoke test suite.** A handful of Playwright tests covering login → dashboard → load emails → generate brief would catch every regression.

### D. Capability expansion (only after A–C)
9. Calendar event creation + meeting RSVP via Graph.
10. Inbox search/filter UI (Graph `$search` already supported).
11. Multi-user onboarding flow.

---

## 7. Critical Files to Know

| Purpose | Path |
|---|---|
| Everything user-facing | `app/dashboard/page.tsx` (~2,300 lines) |
| Login | `app/page.tsx` |
| OAuth callback | `app/api/auth/callback/route.ts` |
| Route guard | `middleware.ts` |
| Supabase client | `lib/supabase.ts` |
| Brand styling | `app/globals.css` |
| README (accurate, up-to-date) | `README.md` |

The Edge Functions (`ms-auth`, `chat`, `draft-reply`) and the SQL schema for `eisenhower_tasks` / `ai_daily_briefs` live in your Supabase project — not in this repo. Worth pulling them into a `supabase/` folder for version control.

---

## 8. Verification

1. `cd qurate-admin && npm install && npm run dev` → open `localhost:3000`, sign in with MS, confirm dashboard renders.
2. In Email tab, open an email → click "Draft AI Reply" → confirm Claude returns a draft.
3. In Briefing tab, click "Generate Brief" → confirm it streams a brief and persists a row in `ai_daily_briefs`.
4. In Matrix tab, create a task and drag across quadrants → confirm `eisenhower_tasks` row updates.
5. Supabase SQL: `select count(*) from ai_daily_briefs;` and `select count(*) from eisenhower_tasks;` to confirm tables exist.
6. In browser dev console inspect `emails[0]` and check whether `ai_quadrant` / `ai_category` are populated — this tells you whether the upstream classification pipeline is wired up or whether the UI is running on heuristic fallbacks (item A1).
