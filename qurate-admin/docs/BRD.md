# BRD — Qurate Admin Agent

> **v4, evergreen — last refreshed 2026-06-27.** v4 pivots the product model from a "mobile dashboard over Microsoft 365" to an **ambient executive assistant**. The previous version (v3, 2026-05-03) described a 7-tab dashboard that, in practice, had recreated tools the user already owns (a second inbox, a read-only calendar). v4 removes those surfaces, makes the daily brief, push nudges, chat, and an approval queue the product, and treats the back-of-house intelligence as the thing to surface rather than bury. v3 is superseded. For the chronological story see the [appendix](#appendix-how-we-got-here) and `docs/CHANGELOG.md`.

---

## 1. Product summary

**Pitch.** A Chief-of-Staff–style executive assistant for a single user. It reads everything coming at the user across Microsoft 365 (mail, calendar) plus the Qurate Advisory CRM, decides what actually needs the user, and surfaces only that — pre-classified, pre-summarised, with a drafted action ready to approve. The user's job shrinks from *read → triage → decide → act* to *approve / edit / dismiss*.

**The model: ambient, not a destination.** There is no app the user must visit to stay on top of things. The EA meets the user where they already are. It has four surfaces:

1. **Daily brief email (primary).** Lands in the inbox by 06:30 AEST, with an end-of-day variant. The spine of the product — most days, reading the brief is the whole interaction.
2. **Proactive push nudges.** Event-driven, action-oriented ("You owe David a reply — 3 days · approve the draft?", "Koda deal stalled 31 days", "2pm Think Water — prep ready"). Approve from the notification where possible.
3. **Chat thread.** Ask anything in plain English, grounded in live EA + CRM context.
4. **Thin approval app — the Action Queue.** The only reason to open the app: work the queue of things the EA has surfaced — approve, edit, dismiss, or snooze. Each item carries a one-line summary, a recommended action, a drafted artifact where relevant, and a deep-link to Outlook for the full thing.

**What the EA explicitly does *not* do.** It does not give the user a second inbox to triage or a worse copy of the Outlook calendar. Outlook remains the system of record for mail and calendar; the EA deep-links to it rather than mirroring it.

**Back-of-house.** Supabase Edge Functions + pg_cron + Anthropic Claude run unattended: email classification → task/queue extraction, follow-up detection, the morning brief, daily VIP sync from SharePoint, and (v4) the nudge engine. This is where the intelligence lives, and in the ambient model it is the product's engine, not a hidden subsystem.

**Tech stack at a glance.** Next.js 14 App Router on Vercel · Supabase Postgres + Edge Functions (Deno) · Microsoft Graph for mail/calendar/SharePoint + outbound send · Anthropic Claude (Sonnet 4.5 for chat/brief/draft, Haiku 4.5 for batch classification/extraction) · pg_cron for scheduling · Web Push for nudges (v4).

**Key constraints.**
- Single user (no multi-tenant, no `user_id` columns)
- Mobile-first PWA — most use happens on iPhone, occasional desktop
- Dark navy theme only (no light mode)
- AEST (Brisbane, no DST)
- **Legacy debt:** the surviving UI is still hand-rolled inline styles in one large dashboard file. The v4 shrink (removing Mail/Calendar, collapsing Tasks/Clients) reduces this surface materially — see §15.

---

## 2. Product principles — what an EA is, and is not

These principles govern every decision in this document. Any surface that violates one is wrong by definition.

1. **Reduce surface area.** Success is the user spending *less* time in the app and in email — not a prettier inbox. Every feature must remove work, not relocate it.
2. **Don't duplicate systems of record.** Outlook *is* the inbox and the calendar. The EA deep-links to it; it never rebuilds it. You cannot out-build Microsoft at mail, and trying splits the user's attention across two places.
3. **Proactive, not reactive.** The EA pushes what needs attention (brief, nudges); it never waits for the user to come and triage. If the user has to go looking, the EA has failed.
4. **Approval-gated action.** Every surfaced item arrives with a recommended action and a one-tap approve / edit / dismiss. The EA drafts and proposes; it never auto-sends on the user's behalf.
5. **The intelligence is the moat.** Classifications, follow-up detection, sender-history patterns, revenue/pipeline context — that is the value. The Outlook clone never was. Surface the intelligence; don't let it sit unused in tables.
6. **Trust requires recall.** In an ambient model the user stops double-checking the inbox, so anything the EA misses is invisible. High recall, explicit "nothing needs you" states, and a periodic "here's what I auto-handled" digest are mandatory, not nice-to-haves. The EA must be *trustworthy enough to stop checking behind it.*

**Design implication.** This is the through-line for any external design process: the product should feel like a chief of staff handing you a short list, not a software inbox asking you to do its sorting.

---

## 3. Personas & jobs to be done

**Persona — Richard Palmer.** Partner, Qurate Advisory (M&A advisory, $2M–$50M EV deals). Also runs Alstonville Plants (horticulture, $500k+ free-cash target). Independent Director, Think Water Group. Operates on EOS (Quarterly Rocks, L10 meetings, Scorecard). Brisbane. iPhone-primary, occasional desktop.

**Jobs to be done — reframed around "the EA handles it, surfaces the exception."**

| Cadence | The job, ambient framing |
|---|---|
| Each morning, before 07:00 | Read one brief email: today's schedule, what must get done, revenue status, the single recommended first action. No app visit required. |
| Throughout the day | Get nudged only when something needs a decision (urgent VIP email with a drafted reply, a follow-up gone cold, a stalled deal). Approve/edit/dismiss from the nudge or the queue. |
| Throughout the day | The EA extracts tasks from email and classifies them; the user confirms or re-files the exceptions, rather than maintaining a board. |
| Several times a day | Glance at the Action Queue: "what still needs me right now?" — ideally empty by end of day. |
| Weekly | Brief surfaces Q2 focus blocks and L10 prep; user asks chat for anything deeper. |
| Monthly | Brief tracks revenue vs the $500k AUD target and flags stalled deals automatically. |
| Ad-hoc | Ask chat ("what did Acme send last week?", "draft a reply to John") — grounded in live context. |

Sources: `chat` system prompt (`ai_prompts.system_prompt where prompt_name='chat'`); morning-brief embedded `SYSTEM_PROMPT` in `supabase/functions/morning-brief/index.ts`; CRM context injected by both `chat` and `morning-brief`.

**Implication for design.** Optimise for a 5-second read of "what matters" on mobile, and for approving an action in one tap. Deep work and browsing belong in the source tools (Outlook, the CRM), reached by deep-link.

---

## 4. The ambient surfaces & information architecture

The product is **four surfaces**, two of them outside any app:

```
                 ┌─────────────────────────────┐
   OUTSIDE       │  1. Daily brief email (AM/PM)│  ← primary; push to inbox
   THE APP       │  2. Push nudges              │  ← proactive, approve-from-notification
                 └─────────────────────────────┘
                 ┌─────────────────────────────┐
   THIN APP      │  3. Chat thread             │  ← ask anything
   (PWA)         │  4. Action Queue ("Today")  │  ← approve / edit / dismiss / snooze
                 └─────────────────────────────┘
                              ↑ deep-links out to ↓
                 ┌─────────────────────────────┐
   SYSTEMS OF    │  Outlook (mail + calendar)  │  ← unchanged, owned by Microsoft
   RECORD        │  Qurate CRM (pipeline)      │
                 └─────────────────────────────┘
```

**Reduced in-app IA.** The app collapses from seven tabs to **three**:

| # | Key | Label | Purpose |
|---|---|---|---|
| 1 | `today` | **Today** | The Action Queue — the home surface. Items needing approval/decision. |
| 2 | `chat` | **Chat** | Conversational assistant grounded in live context. |
| 3 | `settings` | **Settings** | Preferences, VIP list, Microsoft connection, notification controls. |

**Removed:** the **Mail** and **Calendar** tabs (see §15). **Collapsed into Today + brief + chat:** the standalone **Tasks** (Eisenhower) board and the **Clients** widget — tasks now surface as queue items and brief lines; client status surfaces as a brief section and a chat query. (These two collapses are the recommended end-state of the radical-scope decision; they are easy to revisit if a standalone view proves necessary.)

**Layout** — header (56 px: gold "Q" logo · active title · Sign Out) · scrollable content · bottom nav (3 items). Header and nav respect iOS safe-area insets. Modal style by viewport: bottom sheet < 768 px, centred dialog ≥ 768 px.

---

## 5. Surface specs

Template per surface: **Purpose · Primary goal · What's shown · Primary actions · Secondary actions · States · Known limitations.**

### 5.1 Daily brief email (primary surface)

**Purpose.** The one-screen executive read that means the user rarely needs the app at all.

**Primary goal.** "Tell me what matters today and the one thing to do first."

**What's shown** (structure the AI follows — see §8):
1. One-paragraph situation summary
2. Today's schedule (from Graph)
3. Revenue & pipeline status vs the $500k AUD target
4. Q1 priorities (what must get done today)
5. Q2 focus recommendation — one specific block + time estimate
6. Risk flags — overdue follow-ups, stalled deals (>30 days in stage), clients with no contact in 14+ days
7. Single recommended first action
8. **(v4) Deep-links** — each surfaced item links into the Action Queue (to approve a drafted reply) or out to Outlook/CRM for the full artifact.

**Primary actions.** Read. Tap any item to deep-link into the queue or the source. (The brief itself is delivered; it is not a place the user edits.)

**Delivery.** pg_cron `morning-brief-daily` at 20:30 UTC weekdays (06:30 AEST) calls `morning-brief` with `{send:true}`; an **end-of-day variant** (v4) summarises what got handled and what rolls over. Generated by Claude Sonnet 4.5, persisted to `ai_daily_briefs`, rendered markdown→HTML, emailed via Graph `/me/sendMail`. Self-emails on failure.

**States.** Sent (normal) · "Nothing needs you today" (explicit, not an empty void) · Failure → self-alert email to the user.

**Known limitations / requirements.**
- Delivery reliability is **non-negotiable** in the ambient model — the brief must always send. The historical cron/auth fragility is now a top-priority fix (Epic A, §17), not a backlog item.
- The brief depends on a valid Microsoft token; token reliability is treated as a product requirement (§12).

### 5.2 Push nudge / notification (new in v4)

**Purpose.** Surface a single thing that needs a decision *now*, at the moment it becomes actionable, without making the user open anything.

**Primary goal.** "Decide this in one tap."

**What's shown.** A short, specific message + the recommended action: e.g. "Reply to Grant P. (term sheet) — draft ready · Approve / Edit / Dismiss"; "David N. — you owe a reply, 3 days · Draft"; "Koda deal stalled 31 days · Open in CRM"; "2pm Think Water — prep ready · View".

**Primary actions.** Approve (send/execute the drafted action) · Edit (opens the queue item) · Dismiss/Snooze — from the notification where the platform allows, otherwise deep-linking to the queue.

**Triggers (nudge rules).** New Q1/VIP email with a drafted reply; a follow-up crossing its threshold (e.g. 48h no reply); a deal crossing the stalled threshold; an imminent meeting with prep ready.

**Controls.** Batched to avoid fatigue; severity thresholds so only genuine decisions interrupt; **quiet hours bound to the user's focus blocks** (from `user_preferences`). Configurable in Settings.

**States.** Delivered · approved (confirmation) · failed-to-deliver (falls back to surfacing in the queue + brief). 

**Known limitations.** Requires a Web Push channel for the PWA (§11) — net-new infrastructure. iOS PWA push has platform constraints to validate during build.

### 5.3 Action Queue — "Today" tab (new in v4; the thin app's home)

**Purpose.** The single prioritised list of everything that needs the user, each item pre-processed and action-ready. Replaces the inbox, the calendar tab, and the task board as the in-app home.

**Primary goal.** "Clear what needs me — approve, edit, or dismiss — and get to empty."

**What's shown.** A priority-ordered list of queue items. Each card:
- One-line AI summary of what it is and why it surfaced
- Source + classification (VIP / Q1 / follow-up / stalled deal / task-to-confirm), drawn from the back-of-house intelligence
- The drafted artifact where relevant (e.g. the reply text), inline and editable
- Recommended action + an "Open in Outlook / CRM" deep-link for full context

**Item types (v4).** Drafted reply to approve · follow-up nudge to send/snooze · task to confirm or re-file (replaces the manual Eisenhower board) · stalled-deal flag · meeting prep to read.

**Primary actions.** **Approve** (sends the reply / executes the action via the relevant Edge Function) · **Edit** (adjust the draft before approving) · **Dismiss** · **Snooze** (re-surface later).

**Secondary actions.** Filter by type; "Open in Outlook/CRM"; mark a classification wrong (feeds the intelligence — §10).

**States.** Items present (prioritised) · **"Nothing needs you" empty state** (explicit and reassuring, per principle 6) · sending/approving (button disabled + spinner) · approve failure (revert + toast).

**Known limitations.** The queue is only as good as the intelligence feeding it (§10) and the recall guarantees (§13). Building it is the re-scoped Epic B.

### 5.4 Chat tab (carry, elevated)

**Purpose.** Conversational assistant grounded in live EA + CRM context — the catch-all for anything the brief and queue don't cover.

**Primary goal.** "Ask in plain English, get a useful, context-aware answer."

**What's shown.** Conversation history (user right/gold, assistant left/beige); markdown rendering (bold, lists, tables); input + Send; on first load, quick-action chips ("Morning briefing", "Triage inbox", "Today's schedule", "Q1 tasks", "Weekly review", "Focus block").

**Primary actions.** Send a message → `chat` Edge Function injects a live context block (calendar, tasks, follow-ups, CRM pipeline/revenue, email counts) into the Claude Sonnet 4.5 system prompt before forwarding. Tap a chip → sends its canned query. Auto-scroll to latest.

**States.** Sending ("Thinking…") · error ("Sorry, I encountered an error. Please try again.").

**Known limitations.** No conversation persistence in the UI today (server-side `chat_conversations` / `chat_messages` exist); each call re-fetches context (~1–2s overhead); no streaming. Persisting history and streaming are candidate enhancements now that chat is a primary surface.

### 5.5 Settings tab (carry, trimmed)

**Purpose.** Configure preferences, manage the VIP list, control the Microsoft connection, and (v4) tune notifications.

**What's shown.** Briefing time · focus start/end (also drive nudge quiet hours) · timezone · manual VIP companies (editable) · SharePoint-synced VIP companies (read-only + last-synced) · **(v4) notification controls** (nudge categories on/off, quiet hours, batching) · Microsoft connection status (+ Disconnect).

**Primary actions.** Edit prefs → Save (upsert to `user_preferences`) · add/remove VIP · **Sync now** (triggers `sync-vips`) · **Disconnect** (`/api/auth/logout`). Disconnect is destructive and should ask for confirmation.

**States.** Loading · Saving ("Saving…") · Saved ("Saved ✓") · Syncing + result · empty SharePoint VIP list.

**Known limitations.** Save is all-or-nothing for the form. Auto-archive rules remain display-only unless promoted to a real rule engine (relevant to the recall safety net, §13).

---

## 6. Design system

All tokens from `app/globals.css`. No component library — primitives are hand-rolled. The colour, type, and spacing systems carry over from v3 unchanged; v4 adds queue/nudge components and drops Mail/Calendar-specific primitives.

### 6.1 Colour palette

| Token | Hex / RGBA | Primary use |
|---|---|---|
| `--color-navy` | `#2E3D49` | App background |
| `--color-navy-light` | `#374857` | Card / surface background |
| `--color-navy-border` | `rgba(217,210,190,0.15)` | Subtle dividers, card borders |
| `--color-gold` | `#C19131` | Primary action, accents, active nav, brief headings |
| `--color-beige` | `#D9D2BE` | Secondary text, muted, third-tier UI |
| `--color-white` | `#FFFFFF` | Primary text |
| `--color-red` | `#C0392B` | Urgent, errors, danger, badges |
| `--color-black` | `#000000` | Modal scrim (72% alpha) |

Semantic aliases: `--bg`, `--surface`, `--surface2: #3f5262`, `--border`, `--text`, `--muted`.

**Queue item priority tints (v4)** reuse the existing quadrant palette so urgency reads consistently: urgent/Q1 → red `#C0392B`; scheduled/Q2 → gold `#C19131`; delegate/Q3 → beige `#D9D2BE`; low/Q4 → gray `#6B7280` (each at 0.08 bg / 0.2 border).

### 6.2 Typography

- **Heading stack:** `'Gujarati Sangam MN', 'DM Sans', serif` (`--font-heading`)
- **Body / sub stack:** `'Helvetica Neue', 'DM Sans', system-ui, sans-serif`
- **Weights:** 300 body · 400 normal · 500 semi-bold buttons · 600 card titles · 700 display
- `-webkit-font-smoothing: antialiased`

### 6.3 Spacing & radius

| Token | Value | Use |
|---|---|---|
| `--space-section` | 24 px | Gap between major sections |
| `--space-card` | 16 px | Internal card padding |
| `--touch-min` | 44 px | Minimum tappable target |
| `--radius-card` | 8 px | Cards, panels |
| `--radius-button` | 8 px | Buttons, inputs |
| `--radius-tag` | 4 px | Badges, pills |
| `--nav-height` | 64 px | Bottom-nav item height |

Header height: 56 px.

### 6.4 Component primitives

Carried: `TabBtn`, `Card`, `Badge`, `QuadrantBadge` (reused for queue priority), `Spinner`, `Modal`, `SectionHeading`. **New for v4:** `QueueItemCard` (summary + classification tag + inline draft + action row), `Nudge` (notification template), and an `ActionRow` (Approve / Edit / Dismiss / Snooze controls). **Dropped:** Mail list row, email detail drawer, calendar agenda/week primitives.

**Constraint callout for designers.** No shadow-elevation system — depth comes from colour + border + opacity. Avoid drop shadows unless intended as a new direction.

---

## 7. Interaction patterns

| Pattern | Where | Detail |
|---|---|---|
| **Approve / Edit / Dismiss / Snooze** | Action Queue, Nudges | The core verb set replacing inbox triage. Approve executes via the relevant Edge Function; Edit opens the draft inline; Snooze re-surfaces later. |
| **Approve-from-notification** | Push nudges | Decide without opening the app where the platform supports notification actions. |
| **Inline draft edit** | Queue reply items | The drafted reply is editable in place before Approve; never auto-sent (principle 4). |
| **Deep-link out** | Queue, Brief | "Open in Outlook / CRM" for the full artifact instead of rebuilding it in-app (principle 2). |
| **Optimistic update** | Queue approve/dismiss | UI updates immediately; server reconciles; failure = revert + toast. |
| **Bottom-sheet / centred dialog** | < 768 px / ≥ 768 px | Drag handle, click-outside / Esc to close. |
| **Auto-scroll** | Chat | Scrolls to latest message. |
| **Quick-action chips** | Chat (first load) | Six canned-query shortcuts. |
| **Explicit empty state** | Queue, Brief | "Nothing needs you" is a designed state, per principle 6. |

**Retired patterns** (belonged to the removed surfaces): swipe-to-archive on an inbox row; drag-between-quadrants on a task board; the right-slide email detail drawer.

**Open for design:** in-app toast/snackbar (needed for queue feedback) · undo after destructive ops · notification batching UX.

---

## 8. Voice & tone

Source: `chat` system prompt + the `SYSTEM_PROMPT` in `morning-brief/index.ts`.

**Voice.** Direct and sparse — treats the user's time as scarce. "World-class Chief of Staff" persona. No hedging, no fluff. Never says "I don't have access to…" — context is always injected; missing data is reported as "None" / "No X today". Prioritises one clear next action over comprehensive coverage.

**UI copy implications.** Empty states, button labels, nudges, and error strings must match this voice. In-product examples: "No urgent tasks — great start." · "No meetings today — clear day ahead." · verb-first actions ("Approve", "Generate Brief", not "Click to…") · apology + next step ("Sorry, I encountered an error. Please try again."). For v4, nudge copy should be specific and decision-first ("Reply to Grant — draft ready", not "You have a new notification").

---

## 9. Accessibility baseline

**In place.** 44×44 px touch targets · dark theme with gold-on-navy clearing WCAG AA at body sizes · form `<label>`s on most fields.

**Open for refinement.** Explicit focus indicators / tab order · `aria-*` labels (none in the dashboard today) · badge contrast at small sizes with 0.08-alpha tints · `prefers-reduced-motion` handling · `aria-live` for queue/error feedback · **(v4) notification a11y** — nudges must be screen-reader-legible and not rely on colour alone for urgency. A WCAG 2.1 AA pass would be largely additive.

---

## 10. Back-of-house intelligence (the engine)

In the ambient model this is the product's engine: it decides what surfaces in the brief, the queue, and the nudges. The v4 mandate is that **no computed intelligence sits unused** — every signal must drive a surface or be explicitly marked reserved.

### 10.1 Edge Functions

All AI is Anthropic Claude. (Lovable AI Gateway fully removed.)

| Slug | Triggered by | Role in the ambient model |
|---|---|---|
| `ms-auth` | dashboard, other Edge Fns | OAuth orchestration. Refresh token in **Supabase Vault** (`microsoft_refresh_token`); access tokens never persisted. Reliability is now a product requirement (§12). |
| `morning-brief` | pg_cron (06:30 AEST) + app | **Primary surface generator.** Builds the brief from tasks, follow-ups, CRM pipeline/revenue, calendar, previous brief; persists to `ai_daily_briefs`; emails via Graph; self-alerts on failure. v4 adds the end-of-day variant + deep-links. |
| `chat` | app | Conversational assistant; injects the live EA + CRM context block. |
| `draft-reply` | app / queue | Generates the drafted reply that a queue item / nudge carries. Claude Sonnet 4.5. |
| `ms-outlook-folders` | pg_cron (15 min) | Classifies email → extracts SMART tasks (Claude Haiku 4.5), consolidates per-sender → `eisenhower_tasks`. Feeds the **task-to-confirm** queue items. |
| `follow-ups` | (to be cron-driven) | Detects sent emails >48h with no reply → `follow_ups`. **Now drives follow-up nudges + queue items** (previously computed but never surfaced). |
| `sender-history` | internal | Aggregates a sender's classification history/patterns. v4: feeds confidence + prioritisation into the queue, instead of only a prompt-tuning UI. |
| `sync-vips` | pg_cron (daily) + Settings | Syncs VIP companies from SharePoint/OneDrive → `user_preferences.vip_companies_auto`. Drives VIP prioritisation. |
| `delete-outlook-email`, `fetch-email`, `reimport-emails`, `improve-prompt`, `active-prompt` | app / manual | Supporting actions (archive on approve, fetch full body for a queue item, re-classification, prompt tooling). |
| `ms-calendar` | pg_cron | Caches Graph calendar → `calendar_events`; feeds the brief's schedule + meeting-prep nudges. (No longer backing a Calendar tab.) |
| `daily-brief`, `send-brief` | none | **DEPRECATED** 410 stubs — replaced by `morning-brief`. |

**Net-new for v4:** a **nudge engine** (rules + dispatch over Web Push) — see §11.

### 10.2 Data model — every signal gets a home

`public` schema. The v4 test: each table either drives a surface or is explicitly reserved.

| Table | Surfacing path in v4 |
|---|---|
| `eisenhower_tasks` | Brief (Q1/Q2) + queue (task-to-confirm). Healthy; dedup enforced by `ux_eisenhower_tasks_source_email_id`. |
| `email_processing_history` (~2,343 rows) | **Now core:** drives drafted-reply queue items + VIP/Q1 nudges. Previously untapped (~22/2,343 consumed) — closing this is Epic B. |
| `follow_ups` | **Now surfaced:** follow-up nudges + queue items (previously computed then shown as a hardcoded "none"). |
| `ai_daily_briefs` | Brief surface (AM + PM). `sent_at` tracks delivery. |
| `user_preferences` | Prefs, VIP lists, focus hours → also drive nudge quiet hours. |
| `ai_prompts` | System prompts for `chat` / `draft-reply` / classification. |
| `api_cost_log` | Per-call AI spend tracking (chat, brief, extraction, draft-reply). |
| `chat_conversations`, `chat_messages` | Chat history (server-side; UI persistence is a candidate enhancement). |
| `sender-history` outputs | Confidence/prioritisation for the queue. |
| `calendar_events` | Brief schedule + meeting-prep nudges. |
| `strategy_rocks` (7), `eos_annual_goals` (6) | Brief (EOS status). Await richer surfacing. |
| `vip_contacts`, `briefing_sections`, `email_drafts`, `personal_items`, `teams_messages`, `core_*` | **Reserved** — explicitly not yet surfaced; future modules. |

**Headline.** The pivot's whole point: the intelligence that already exists (classifications, follow-ups, sender patterns) stops being orphaned and becomes the queue, the brief, and the nudges.

---

## 11. Notification & delivery infrastructure (new in v4)

The ambient model depends on two outbound channels working reliably.

**Brief delivery (must always send).** pg_cron → `morning-brief {send:true}` → Graph `/me/sendMail`. The historical fragility (cron paused / Microsoft token invalid → no brief) is now a top-priority reliability fix, with self-alert on failure as the backstop. Treated as Epic A.

**Push nudges (net-new).**
- **Channel:** Web Push for the installed PWA (subscription stored against the single user). iOS PWA push constraints to validate during build; email/Teams fallback considered if Web Push proves unreliable on the user's devices.
- **Nudge engine:** rules evaluate the intelligence (new VIP/Q1 email, follow-up threshold crossed, deal stalled, meeting imminent) → dispatch a nudge with an approve/edit/dismiss action.
- **Fatigue controls:** batching, severity thresholds, and quiet hours bound to the user's focus blocks (`user_preferences`). Anything suppressed still appears in the queue and the next brief — nothing is dropped silently (principle 6).

---

## 12. Authentication

OAuth via Microsoft Identity Platform; `ms-auth` orchestrates.

- Login: `/` → `ms-auth?action=login` → consent → `/api/auth/callback` → `ms-auth?action=callback` exchanges the code, stores the **refresh token in `vault.secrets` (`microsoft_refresh_token`)**, drops the access token, sets the `ms_auth_connected=1` cookie (httpOnly, sameSite=lax).
- Every Graph-needing call hits `ms-auth`, which exchanges the Vault refresh token for a **request-scoped** access token. Access tokens are never persisted.
- Disconnect: `ms-auth?action=disconnect` deletes the Vault secret + clears the cookie.

**Scopes:** `Calendars.Read · Mail.ReadWrite · Sites.Read.All · Files.Read.All · offline_access`.

**Ambient-model implication.** Token reliability is a **product requirement**, not just an auth detail: if `ms-auth` can't get a token, the brief doesn't send and nudges go quiet — and because the user isn't checking a Mail tab, the failure is invisible. Token failure must therefore raise a loud, user-visible alert (self-email + an in-app banner), not fail silently.

---

## 13. Trust, recall & safety (new in v4)

The defining risk of the ambient model: **removing the Mail tab removes the user's safety net.** When the user stops double-checking the inbox, anything the EA fails to surface is simply missed. The product is only viable if it earns enough trust to be checked-behind rarely. Requirements:

1. **High recall over precision.** When unsure, surface — a slightly noisy queue beats a silent miss. Low-confidence classifications are surfaced for review, never dropped.
2. **Explicit empty states.** "Nothing needs you" is an affirmative, designed message — never a blank screen that's ambiguous between "all clear" and "broken".
3. **Auto-handled digest.** A periodic "here's what I auto-archived / deprioritised" summary (in the brief or as a digest) so the user can audit the EA's decisions and correct them. The auto-archive rules must be auditable, not invisible.
4. **Correctable intelligence.** Marking a queue item's classification wrong feeds back (via `email_processing_history` review fields / sender-history) so recall improves over time.
5. **Loud failure.** Delivery/token failures alert the user (§12) rather than degrading silently.

This section is the counterweight that makes removing Mail/Calendar safe. Building it is Epic E.

---

## 14. Security findings

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | RLS open on most tables (`USING (true) WITH CHECK (true)`) | 🟢 low (single user) | Acceptable today; blocker for multi-tenant |
| 2 | Anon key embedded in client | 🟢 low | Standard for Supabase + single user |
| 3 | pg_cron commands embed JWT as plaintext | 🟢 low | Public anon key only |
| 4 | No CSP / security headers | 🟡 medium | Vercel defaults only; worth a follow-up |
| 5 | Edge Functions log errors to console | 🟢 low | Acceptable for solo project |
| 6 | **(v4) Web Push subscription + deep-link tokens** | 🟡 medium | New surface — ensure push subscription and any deep-link tokens don't leak access to mail content; validate during Epic C |

**Resolved earlier:** Microsoft refresh token moved to Vault; access tokens no longer persisted.

---

## 15. What we're removing & migration path (new in v4)

**Removed surfaces.**
- **Mail tab** — the second inbox. Outlook is the inbox. The slice the user needs to *act* (draft a reply) moves into the Action Queue and nudges.
- **Calendar tab** — the read-only Graph mirror. Outlook owns the calendar; the brief carries today's schedule and meeting-prep nudges; full calendar opens in Outlook by deep-link.

**Collapsed surfaces (recommended end-state).**
- **Tasks (Eisenhower board)** → tasks surface as brief lines + "task-to-confirm" queue items; the manual drag-drop board is retired in favour of confirming/re-filing the AI's classification.
- **Clients widget** → a brief section ("who's gone quiet") + a chat query.

**How draft-reply survives without a Mail tab.** A queue item / nudge carries: the email's AI summary, the sender + subject, the **full body fetched on demand** (`fetch-email`), the **drafted reply** (`draft-reply`), and an **"Open in Outlook"** deep-link. The user approves or edits inline; approve sends via Graph and archives via `delete-outlook-email`. No inbox browsing required.

**Codebase implication.** Removing Mail/Calendar and collapsing Tasks/Clients shrinks the large dashboard file substantially — which downgrades the urgency of the old "decompose the monolith" epic. The shrink *is* part of the decomposition.

**Migration stance.** This is staged, not big-bang: stand up the Action Queue and nudges (consuming the existing intelligence) *before* retiring Mail/Calendar, so the user never loses the ability to act on email during the transition.

---

## 16. Open issues

| # | Issue | Severity | Tracking |
|---|---|---|---|
| 1 | Intelligence under-consumed — classifications, follow-ups, sender patterns mostly unused | 🔴 high | Epic B (the core of the pivot) |
| 2 | Brief delivery fragile — cron/auth can silently stop the 06:30 send | 🔴 high | Epic A |
| 3 | No push channel yet — nudges require net-new Web Push infra | 🟡 medium | Epic C |
| 4 | Recall/trust safety net not built — no auto-handled digest, no explicit "nothing needs you" | 🟡 medium | Epic E |
| 5 | Action Queue does not exist yet | 🟡 medium | Epic B |
| 6 | Token failure can fail silently (no loud user-visible alert) | 🟡 medium | Epic A / §12 |
| 7 | No Sentry/error tracking for the Next.js app | 🟢 low | (DSN pending) |
| 8 | No Playwright/E2E tests | 🟢 low | quality backlog |
| 9 | Permissive RLS; "Richard" hardcoded | 🟢 low (single user) | deferred (multi-tenant) |
| 10 | No in-app toast/snackbar (needed for queue feedback) | 🟢 low | design decision |

**Resolved earlier** (see `docs/CHANGELOG.md`): runaway pg_cron, broken brief delivery path, settings non-persistence, Lovable API dependency, missing Vault for refresh token.

---

## 17. Roadmap

The v4 pivot reorders the work. Priority order:

| Epic | Scope | Status |
|---|---|---|
| **A — Bulletproof + richer brief** | Fix cron/auth so 06:30 always sends; loud failure alert; end-of-day variant; deep-links from brief into queue/Outlook | ⬜ top priority (foundation of trust) |
| **B — The Action Queue** | Consume `email_processing_history` + `follow_ups` → prioritised queue items with drafted actions + approve/edit/dismiss/snooze (re-scope of old "bridge dashboard ↔ back-of-house") | ⬜ core of the pivot |
| **C — Proactive nudges / push** | Web Push channel + nudge engine + batching + quiet hours | ⬜ not started |
| **D — Remove Mail & Calendar; collapse Tasks/Clients** | Deep-link to Outlook; retire the rebuilt surfaces (after B + C land) | ⬜ not started |
| **E — Trust & recall safety net** | Auto-handled digest, low-confidence surfacing, explicit empty states, correctable classifications | ⬜ not started |
| Decompose monolith | Largely absorbed by the v4 shrink (D) — downgraded | 🟡 partial / lower priority |
| Multi-tenant | Add the partner | ⏸ deferred |

**Highest-leverage next move:** Epic A then Epic B — make the brief unmissable, then make the intelligence actionable. Everything else builds on those two.

> **Follow-ups beyond this document:** `docs/EPICS.md` and `docs/CHANGELOG.md` should be updated to match this reprioritisation; that is tracked separately from this BRD refinement.

---

## Appendix — How we got here

This product began as a Next.js dashboard against Microsoft 365. A back-of-house Supabase pipeline (Edge Functions + pg_cron + AI) was added separately, classifying emails into `email_processing_history` and writing tasks to `eisenhower_tasks`. The two surfaces never quite met — the dashboard kept reading Graph live and largely ignored the populated tables.

A 2026-05-02 audit surfaced the gap plus urgent issues (a runaway pg_cron job had ballooned `eisenhower_tasks` to 227,407 rows and was bleeding AI credits; the brief had no working email delivery; settings lived in `localStorage`; token storage was silently failing). Work on 2026-05-02 → 05-03 closed the critical path: paused/fixed the cron and added a dedup index (Epic 0); built `morning-brief` on Claude Sonnet 4.5 (Epic 2); persisted settings + synced VIPs (Epic 4); added failure self-alerts + `/api/health` (Epic 6 partial); moved the refresh token to Vault.

**2026-06-27 — the v4 ambient pivot.** A product review found that, even after the critical-path fixes, the dashboard had effectively *recreated Outlook*: a Mail tab that was a second inbox (consuming ~22 of 2,343 classified emails) and a read-only Calendar tab that was a strictly-worse copy of the native one, while the genuine assistant value (brief, chat) was underdeveloped and the computed intelligence (follow-ups, sender patterns) sat unused. The conclusion: a chief of staff must *reduce* the surface area the user touches, not add a second one, and you cannot out-build Microsoft at mail. v4 reframes the product as an **ambient executive assistant** — brief email, push nudges, chat, and a thin approval queue — removes the Mail and Calendar tabs, collapses the Tasks board and Clients widget, and elevates the back-of-house intelligence from a hidden subsystem to the product's engine. The defining new requirement is **trust through recall** (§13): once the user stops double-checking the inbox, the EA must be reliable enough that a miss is rare and auditable.

For the day-by-day record see `docs/CHANGELOG.md`. For active work see `docs/EPICS.md`.
