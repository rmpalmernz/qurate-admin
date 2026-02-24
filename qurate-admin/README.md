# Qurate Admin Agent

An AI-powered executive administration dashboard for business professionals and M&A advisory. Consolidates email, calendar, task management, and AI reasoning into a single mobile-first Progressive Web App backed by Microsoft 365 and Claude AI.

---

## Overview

Qurate Admin Agent acts as a personal EA for a named executive user. It connects to a Microsoft 365 account to surface emails, calendar events, and tasks in one place — with AI assistance for triage, drafting, briefings, and conversational queries.

**Current user:** Richard (single-user deployment)

---

## Features

| Tab | Description |
|---|---|
| **Briefing** | AI-generated morning brief synthesising emails, calendar, and Q1 tasks |
| **Email** | Outlook inbox with AI categorisation, swipe-to-archive, AI-drafted replies, and send |
| **Calendar** | 14-day rolling view (Agenda + Week grid) overlaid with Eisenhower tasks |
| **Matrix** | Eisenhower task matrix (Q1–Q4) with drag-to-reorder, drag-to-merge, and full CRUD |
| **Clients** | VIP client tracker showing email counts, task activity, and last contact |
| **Chat** | Conversational Claude assistant with markdown rendering and quick-action buttons |
| **Settings** | Briefing time, focus block window, VIP client list, and Microsoft connection management |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 14.2.5 (App Router) |
| UI | React 18, TypeScript 5, Custom CSS, TailwindCSS 3.4.1 |
| Auth | Microsoft Azure AD (OAuth 2.0) |
| Backend | Supabase Edge Functions (Deno) |
| Database | Supabase PostgreSQL (REST API) |
| AI | Anthropic Claude API (Haiku + Sonnet) |
| External API | Microsoft Graph API v1.0 |
| Hosting | Vercel (Next.js) + Supabase Cloud |

---

## Architecture

```
Browser (Next.js PWA)
│
├── /                     Login — Microsoft OAuth entry point
├── /dashboard            Main app (7 tabs)
├── /api/auth/callback    OAuth code exchange → sets session cookie
├── /api/auth/logout      Token revocation + cookie clear
└── middleware.ts         Edge middleware — cookie guard on /dashboard/*
         │
         ▼
Supabase Edge Functions
├── /ms-auth              Azure AD orchestration (login / callback / token refresh / disconnect)
├── /chat                 Claude API proxy (Haiku / Sonnet routing)
└── /draft-reply          AI email reply generation
         │
         ├──▶ Microsoft Graph API v1.0
         │       /me/messages, /me/calendarView, /me/sendMail
         │
         └──▶ Supabase PostgreSQL
                  eisenhower_tasks    — task CRUD
                  ai_daily_briefs     — generated briefing storage
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com) project with Edge Functions deployed
- A Microsoft Azure AD app registration (for OAuth)
- An Anthropic API key (configured in your Supabase Edge Function secrets)

### Environment Variables

Create a `.env.local` file in the project root:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
```

All other secrets (Microsoft client ID/secret, Anthropic API key, MS tenant ID) are stored as Supabase Edge Function secrets — they never touch the browser.

### Install & Run

```bash
npm install
npm run dev       # http://localhost:3000
npm run build     # production build
npm run start     # serve production build
```

### Deploy to Vercel

```bash
vercel deploy
```

The `vercel.json` is already configured for Next.js. Add your environment variables in the Vercel dashboard under **Project → Settings → Environment Variables**.

---

## Authentication Flow

```
1. User visits /             → Login page
2. "Sign in with Microsoft"  → GET /ms-auth?action=login → Azure AD redirect
3. Azure AD callback         → /api/auth/callback?code=...
4. Code exchange             → Supabase Edge Function handles token
5. Cookie set                → ms_auth_connected=1 (HttpOnly, 30-day expiry)
6. Redirect                  → /dashboard
7. On every /dashboard/* req → middleware checks cookie, redirects to / if absent
8. On dashboard mount        → MS access token fetched server-side for Graph API calls
9. Sign out                  → token revoked, cookie cleared, redirect to /
```

The Microsoft access token is **never stored in the browser**. It is managed exclusively by the Supabase Edge Function.

---

## Database Schema

### `eisenhower_tasks`

| Column | Type | Notes |
|---|---|---|
| id | uuid | Primary key |
| title | text | Task title |
| description | text | Full description |
| quadrant | text | q1, q2, q3, or q4 |
| status | text | open, in_progress, waiting, done, cancelled |
| client_name | text | Associated VIP client |
| due_date | timestamptz | Optional deadline |
| estimated_minutes | integer | Time estimate |
| tags | text[] | Free-form labels |
| priority_score | integer | Computed urgency score |
| delegation_channel | text | Who/where to delegate |
| email_ids | text[] | Source email references |
| created_at | timestamptz | Auto-set |

### `ai_daily_briefs`

| Column | Type | Notes |
|---|---|---|
| id | uuid | Primary key |
| brief_text | text | Full generated brief (Markdown) |
| created_at | timestamptz | Auto-set |

---

## Supabase Edge Functions

Deploy from your Supabase project. Required functions:

| Function | Purpose |
|---|---|
| `ms-auth` | Microsoft OAuth orchestration — login, token exchange, refresh, disconnect |
| `chat` | Claude API proxy — routes to Haiku or Sonnet based on query complexity |
| `draft-reply` | Generates AI reply for a given email thread |

Required Edge Function secrets:

```
AZURE_CLIENT_ID
AZURE_CLIENT_SECRET
AZURE_TENANT_ID
ANTHROPIC_API_KEY
SITE_URL          # e.g. https://your-app.vercel.app
```

---

## VIP Clients

Default VIP clients (matched by email domain substring):

- Think Water
- Therefore
- Providence
- Armillary
- Alstonville

These can be overridden per-session in the **Settings** tab (stored in `localStorage`).

---

## AI Integration

| Feature | Model | Trigger |
|---|---|---|
| Morning briefing | Claude Haiku | Dashboard load / manual refresh |
| Email reply drafting | Claude Haiku | "Draft reply" button |
| Chat assistant | Claude Haiku / Sonnet | User message in Chat tab |

---

## PWA Support

The app is installable as a Progressive Web App on iOS and Android:

- Service Worker registered on dashboard mount
- Web app manifest in `/public`
- `viewport-fit: cover` for iOS notch support
- `100svh` viewport handling for mobile keyboard

---

## Project Structure

```
/app
  page.tsx                  Login page
  layout.tsx                Root layout (PWA meta tags, fonts)
  globals.css               Dark theme, CSS variables, responsive utilities
  /dashboard
    page.tsx                Main dashboard — all 7 tabs
    layout.tsx              Passthrough layout
  /api/auth
    /callback/route.ts      OAuth callback handler
    /logout/route.ts        Sign-out handler
/lib
  supabase.ts               Supabase client initialisation
/public
  icons, manifests          PWA assets
middleware.ts               Route protection (cookie check)
```

---

## Known Constraints

- **Single user** — Username ("Richard") and default VIP client list are hardcoded. Multi-user support requires a user profile table and dynamic config.
- **Token refresh** — MS token is fetched once on dashboard mount. Long-running sessions may need proactive refresh logic in the Edge Function.
- **Email categorisation pipeline** — AI categorisation fields (`ai_quadrant`, `ai_priority_level`) on email objects assume an upstream ingestion pipeline (not included in this repo).
- **No test suite** — Unit and integration tests are not yet present.
- **RLS** — Confirm Supabase Row Level Security is active on all tables before sharing the anon key in any public context.
- **Timezone** — Microsoft Graph returns UTC timestamps without a `Z` suffix. The app appends `Z` to force correct UTC parsing (relevant for AEDT users).

---

## License

Private — all rights reserved.
