# BRD — Qurate Admin Agent

> **v3, evergreen — last refreshed 2026-05-03.** Supersedes v2 (which was framed as a one-off post-audit incident report). This version describes the product as it stands today, with UX/UI detail to support an external design process. For the chronological story of how the system got here, see the [appendix](#appendix-how-we-got-here) and `docs/CHANGELOG.md`.

---

## 1. Product summary

**Pitch.** A Chief-of-Staff style executive admin agent for a single user. Pulls live data from Microsoft 365 (mail, calendar) plus a separate Qurate Advisory CRM. Classifies emails into the Eisenhower matrix, tracks tasks, generates a daily executive brief that lands in the user's inbox by 06:30 AEST, drafts replies on demand, and exposes a conversational AI assistant.

**Surfaces today:**
- **Dashboard** (Next.js PWA, mobile-first) — what the user touches. 7 bottom-tab views.
- **Back-of-house pipeline** (Supabase Edge Functions + pg_cron + Anthropic Claude) — runs unattended: hourly email triage, daily morning brief, daily VIP client sync from SharePoint.
- **Email channel** (Microsoft Graph `/me/sendMail`) — outbound delivery for the morning brief and any future scheduled comms.

**Tech stack at a glance.** Next.js 14 App Router on Vercel · Supabase Postgres + Edge Functions (Deno) · Microsoft Graph for mail/calendar/SharePoint · Anthropic Claude (Sonnet 4.5 for chat/brief/draft, Haiku 4.5 for batch task extraction) · pg_cron for scheduling.

**Key constraints.**
- Single user (no multi-tenant, no `user_id` columns)
- Mobile-first PWA — most use happens on iPhone, occasional desktop
- Dark navy theme only (no light mode)
- No component library — all UI hand-rolled with inline styles in one ~2,300-line dashboard file
- AEST (Brisbane, no DST)

---

## 2. Personas & jobs to be done

**Persona — Richard Palmer.** Partner, Qurate Advisory (M&A advisory, $2M–$50M EV deals). Also runs Alstonville Plants (horticulture, $500k+ free cash target). Independent Director, Think Water Group. Operates on EOS framework (Quarterly Rocks, L10 meetings, Scorecard). Brisbane.

**Jobs to be done.**
| Cadence | Job |
|---|---|
| Each morning, before 07:00 | Get a one-screen brief in inbox: today's calendar, Q1 tasks, revenue status, recommended first action |
| Throughout the day | Triage email — file urgent into Q1, send drafted replies, archive noise |
| Throughout the day | Log/finish tasks, drag between quadrants |
| Several times a day | Open dashboard for a glance: what's hot, who's stalled |
| Weekly | Review Q2 focus blocks, prep L10 meeting |
| Monthly | Check revenue progress vs $500k AUD retainer target, surface stalled deals |
| Ad-hoc | Ask the chat assistant (e.g., "what did Acme send last week?", "draft a reply to John") |

Sources: `chat` system prompt (`ai_prompts.system_prompt where prompt_name='chat'`); morning-brief embedded `SYSTEM_PROMPT` in `supabase/functions/morning-brief/index.ts`; dashboard hardcoded "Richard" references throughout `app/dashboard/page.tsx`.

**Implication for design.** Designs should optimise for high-frequency mobile glances (≤5 seconds to read what matters) over deep desktop sessions.

---

## 3. Information architecture & navigation

**Top-level layout** — three fixed regions:

```
┌────────────────────────────────────┐
│  Header (56 px)                    │  ← gold "Q" logo · active title · Sign Out
├────────────────────────────────────┤
│                                    │
│  Scrollable main content           │  ← active tab body
│                                    │
├────────────────────────────────────┤
│  Bottom nav (64 px per item)       │  ← 7 icons + labels + badges
└────────────────────────────────────┘
```

Both header and bottom nav respect iOS safe-area insets (`env(safe-area-inset-top/bottom)`).

**Bottom-nav tabs** — exact order, labels, and badges from `app/dashboard/page.tsx:2272-2280`:

| # | Key | Label | Icon | Badge |
|---|---|---|---|---|
| 1 | `briefing` | **Brief** | upward chevron with chimney | — |
| 2 | `email` | **Mail** | envelope | unread count |
| 3 | `calendar` | **Calendar** | grid with date markers | today's event count |
| 4 | `matrix` | **Tasks** | 2×2 grid | Q1 task count |
| 5 | `clients` | **Clients** | person silhouette | — |
| 6 | `chat` | **Chat** | speech bubble | — |
| 7 | `settings` | **Settings** | gear | — |

Badges are red pills, max display "99+", hidden when count is 0.

**Cross-tab journeys** that exist today:
- Brief → (visual reference only; no link out)
- Mail → tap an email opens detail drawer with Reply / Archive
- Calendar → tap event opens detail modal (read-only)
- Tasks → drag between quadrants; tap to edit; FAB to add
- Clients → read-only summary of email + task counts per VIP
- Chat → quick-action chips on first load ("Morning briefing", "Q1 tasks", etc.)
- Settings → sub-flows for VIP add/remove + SharePoint sync

**Modal style by viewport.** Bottom sheet @ <768 px (drag handle, 20 px top radius). Centred dialog @ ≥768 px (16 px radius). Click-outside or Esc closes.

---

## 4. Per-screen UX spec

Every spec uses the same template:
**Purpose · Primary user goal · Information shown · Primary actions · Secondary actions · States (empty / loading / error / disconnected) · Known limitations.**

### 4.1 Brief tab (`BriefingTab`, `app/dashboard/page.tsx:206`)

**Purpose.** A one-screen morning glance: who I'm seeing, what I must do.

**Primary user goal.** "What matters most right now?"

**Information shown.**
- Time-aware greeting: "Good morning / afternoon / evening, Richard"
- Today's date in long form
- Alert strip: "X Q1 tasks need action today · Y unread total"
- Two-column block @ ≥768 px (one column on mobile): **Calendar** (today's events with time, organiser, location) | **Q1 Tasks** (top urgent tasks)
- AI-generated brief markdown body (renders headings, lists, tables) once "Generate Brief" has been pressed today

**Primary actions.**
- Tap **Generate Brief** → calls `/morning-brief` Edge Function with frontend context (today's events, Q1/Q2 tasks, unread count, VIP list). Function persists to `ai_daily_briefs` for today's date. UI shows brief inline.

**Secondary actions.**
- (None — read-only otherwise)

**States.**
- Loading: spinner + "Loading…"
- Empty calendar: "No meetings today — clear day ahead."
- Empty Q1: "No urgent tasks — great start."
- Generating: button disabled + spinner overlay
- Error: brief panel shows "Error generating brief — please try again."

**Known limitations.**
- Brief is not auto-loaded — user must hit Generate to refresh today's brief in-app (the cron-sent email at 06:30 covers the auto path)
- Calendar source is the live Graph fetch from page mount, not the cached `calendar_events` table (which is empty — see §11)
- Sections are inline-styled with staggered fade-in (60 ms increments)

### 4.2 Mail tab (`EmailTab`)

**Purpose.** Triage and draft replies for high-volume inbox.

**Primary user goal.** "Get to inbox-zero fast — keep VIPs front of mind."

**Information shown.**
- Filter strip: **All / Q1 / VIP / Tools / Other** with per-filter counts
- Email list (50 most recent from Graph), each row: sender · subject · preview · received-time · category tag (VIP / partner / tools) · unread state (bold + dot)
- Detail drawer (slides in from right) on tap: full body · received metadata · action row

**Primary actions.**
- Tap email → opens detail drawer
- **Reply** (R key) → opens AI-drafted reply via `/draft-reply` Edge Function (Claude Sonnet 4.5). User edits before sending.
- **Archive** (E key) → calls `/delete-outlook-email`. Optimistic remove from list.
- **Compose** (FAB / button) → To, Subject, Body modal. Sends via Graph. Send confirmation modal.

**Secondary actions.**
- Filter by quadrant / category
- Refresh button (reloads from Graph)
- Mobile swipe-left on email row → archives at -15 px threshold (snaps back if released earlier)
- Esc closes detail drawer

**States.**
- Loading: spinner overlay during refresh
- Drafting reply: spinner mid-screen with "Drafting…"
- Sending: button disabled + spinner
- Empty (no emails): "No emails yet."
- Empty (filter): "No emails match this filter."

**Known limitations.**
- Categorisation is heuristic (subject + sender match against VIP list); the rich classification in `email_processing_history` (2,343 rows) is **not yet consumed** — Epic 1
- Read-state changes don't write back to Graph (UI-only)
- Drafted reply quality depends on Claude — user should always review before send

### 4.3 Calendar tab (`CalendarTab`)

**Purpose.** 14-day forward view of meetings + tasks-with-due-dates.

**Primary user goal.** "What's my week look like? Anything I'm forgetting?"

**Information shown.**
- View toggle: **Agenda** (default vertical list) | **Week** (7-column grid, ≥900 px only)
- Day groupings labelled "Today", "Tomorrow", or weekday + date
- Per-row: time · subject · organiser · location
- Tasks-with-due-dates overlaid on their due day, with quadrant badge (Q1/Q2/Q3/Q4)
- Tap row → detail modal (read-only): time · location · organiser · description · attendees if event; full description if task

**Primary actions.**
- Tap event/task → detail modal
- Switch view (Agenda ↔ Week)

**Secondary actions.**
- (None — read-only)

**States.**
- Loading: spinner during initial Graph fetch
- Empty: "No events coming up." / "No tasks due."
- Cancelled events (subject prefix "Cancelled" / "Canceled") shown with strikethrough + 40% opacity

**Known limitations.**
- Pulls live from Graph on every mount, not from cached `calendar_events` table (still empty — see §11)
- No event creation, no RSVP, no edit (intentional — out of scope per `EPICS.md`)
- Week view is horizontal-scrollable on mobile only because the 7-col grid doesn't fit < 900 px

### 4.4 Tasks tab (`MatrixTab`, the Eisenhower matrix)

**Purpose.** 2×2 prioritisation matrix for all tasks (manual + email-derived).

**Primary user goal.** "Prioritise, sequence, and delegate today's work."

**Information shown.**
- 4 quadrants in fixed order:
  - **Q1 Do** (urgent + important) — red tint
  - **Q2 Schedule** (not urgent + important) — gold tint
  - **Q3 Delegate** (urgent + not important) — beige tint
  - **Q4 Eliminate** (not urgent + not important) — gray tint
- Per-task card: title · client · due date · estimated minutes · overdue indicator (3 px red left border if overdue)
- Completed tasks hidden by default; toggle "Show completed" to reveal

**Primary actions.**
- **Add task** — FAB bottom-right (≥769 px) or modal (mobile). Form: Title (required) · Quadrant · Client · Due date · Estimated minutes · Description.
- **Drag** task to a different quadrant — opacity 0.35 while dragging; drop zone bg/border tint on hover. Updates `eisenhower_tasks.quadrant`.
- **Complete** → green button on card. Sets `status='done'`, removes from view (unless toggle is on).
- **Delete** → red button. Confirms then deletes row.
- **Edit** → opens task in modal pre-populated with current values.

**Secondary actions.**
- Toggle "Show completed tasks"

**States.**
- Saving / completing / deleting: button disabled + opacity reduced
- Drag-active: dragged card 0.35 opacity; quadrant bg tints on hover
- Loading completed tasks: async spinner
- Empty per quadrant: "No tasks" or drop-zone prompt

**Known limitations.**
- Email-derived tasks come from `ms-outlook-folders` cron (every 15 min) — they appear automatically, classified by which Outlook folder the user filed them into ("1. Urgent and Important (Do)" → Q1, etc.)
- No `quadrant_override` UI to mark "AI got this wrong" — Epic 1
- No recurring tasks (out of scope)

### 4.5 Clients tab (`ClientsTab`)

**Purpose.** VIP client at-a-glance dashboard.

**Primary user goal.** "Who am I at risk of forgetting? Who needs a touchpoint?"

**Information shown.**
- One card per VIP company (from `user_preferences.vip_companies` ∪ `vip_companies_auto`)
- Card body: total email count · task count · unread count (red if >0) · "X urgent" badge if any Q1 tasks for this client · top 3 active task titles ("+N more" if overflow) · last email preview (from + subject)
- 2-column grid @ ≥768 px, single column mobile

**Primary actions.**
- (None — read-only summary view today)

**Secondary actions.**
- (None)

**States.**
- Empty: "No recent activity." for clients with neither emails nor tasks
- Loading: inherits from parent (no per-tab spinner)

**Known limitations.**
- Card is read-only — no drill-through to filtered Mail/Tasks views yet
- VIP list is the merged set: manual entries + SharePoint-synced (`sync-vips` cron). User can see auto-synced names in Settings but can't unmerge them here.

### 4.6 Chat tab (`ChatTab`)

**Purpose.** Conversational AI assistant grounded in live EA + CRM context.

**Primary user goal.** "Ask in plain English, get a useful answer."

**Information shown.**
- Conversation history: user messages right-aligned (gold), assistant messages left-aligned (beige/gray)
- Markdown rendering in assistant replies (bold, italic, code blocks, tables)
- Input field + Send button (disabled if input empty or while loading)
- On first load: 6 quick-action chips — "Morning briefing", "Triage inbox", "Today's schedule", "Q1 tasks", "Weekly review", "Focus block"

**Primary actions.**
- Type query → Send (button or Enter key) → calls `/chat` Edge Function. Function injects ~4,000-word LIVE CONTEXT block (calendar, tasks, pipeline from Qurate CRM, email counts) into Claude Sonnet 4.5 system prompt before forwarding the user message.
- Tap quick-action chip → sends the chip's prompt verbatim
- Auto-scroll to latest message on new arrival

**Secondary actions.**
- (None — chat history not persisted across sessions in the UI today, although `chat_conversations` and `chat_messages` tables exist server-side)

**States.**
- Sending: "Thinking…" placeholder bubble until response arrives
- Error: "Sorry, I encountered an error. Please try again."

**Known limitations.**
- No conversation persistence in UI — refresh = fresh start
- Each call re-fetches CRM + EA context (~1-2 second overhead before AI starts)
- No streaming — full response shows at once

### 4.7 Settings tab (`SettingsTab`)

**Purpose.** Configure preferences, manage VIP list, control Microsoft connection.

**Primary user goal.** "Set my prefs once and have them survive devices."

**Information shown.**
- Time inputs: Briefing time · Focus start · Focus end
- Timezone dropdown (IANA list)
- Manual VIP companies — editable list (add input + per-row remove button)
- SharePoint-synced VIP companies — read-only list with "last synced" timestamp
- Auto-archive rules (informational, read-only)
- Microsoft connection status card — green if connected, button to **Disconnect** (red danger style)
- **Save Preferences** button at bottom

**Primary actions.**
- Edit any preference field → state held locally
- Add VIP — type name + Add button → appended to local list
- Remove VIP — × icon per row
- **Sync now** → triggers `sync-vips` Edge Function (reads SharePoint folders, dedupes, writes `vip_companies_auto`). Shows progress message.
- **Save Preferences** → upserts all changes to `user_preferences` table
- **Disconnect** → calls `/api/auth/logout` → clears MS token, redirects to login

**Secondary actions.**
- (None)

**States.**
- Loading: brief flash on mount while pulling from `user_preferences`
- Saving: button disabled + "Saving…"
- Saved: temporary "Saved ✓" confirmation
- Syncing: button disabled + progress message
- Sync result: success ("Synced X clients from SharePoint. Reload to see them.") or failure ("Sync failed: …")
- Empty SharePoint VIP list: "No SharePoint clients yet. Hit Sync now to fetch them."

**Known limitations.**
- Save is all-or-nothing for the form (no per-field auto-save)
- Auto-archive rules are display-only — there's no rule engine yet
- Disconnect is destructive and should arguably ask for confirmation (currently doesn't)

---

## 5. Design system

All tokens from `app/globals.css:8-39`. No component library — every primitive is hand-rolled.

### 5.1 Colour palette

| Token | Hex / RGBA | Primary use |
|---|---|---|
| `--color-navy` | `#2E3D49` | App background |
| `--color-navy-light` | `#374857` | Card / surface background |
| `--color-navy-border` | `rgba(217,210,190,0.15)` | Subtle dividers, card borders |
| `--color-gold` | `#C19131` | Primary action, accents, active nav, brief headings |
| `--color-beige` | `#D9D2BE` | Secondary text, muted, third-tier UI |
| `--color-white` | `#FFFFFF` | Primary text |
| `--color-red` | `#C0392B` | Urgent, errors, danger, badges |
| `--color-black` | `#000000` | Modal scrim (with 72% alpha) |

Semantic mappings: `--bg`, `--surface`, `--surface2: #3f5262`, `--border`, `--text`, `--muted` are aliases of the above.

### 5.1b Quadrant colour scheme (`app/dashboard/page.tsx:111-116`)

Each quadrant has a tinted card background and border:

| Quadrant | Tint colour | Background | Border |
|---|---|---|---|
| Q1 Do | Red `#C0392B` | `rgba(192,57,43,0.08)` | `rgba(192,57,43,0.2)` |
| Q2 Schedule | Gold `#C19131` | `rgba(193,145,49,0.08)` | `rgba(193,145,49,0.2)` |
| Q3 Delegate | Beige `#D9D2BE` | `rgba(217,210,190,0.08)` | `rgba(217,210,190,0.2)` |
| Q4 Eliminate | Gray `#6B7280` | `rgba(107,114,128,0.08)` | `rgba(107,114,128,0.2)` |

### 5.2 Typography

- **Heading stack:** `'Gujarati Sangam MN', 'DM Sans', serif` (`--font-heading`)
- **Body / sub stack:** `'Helvetica Neue', 'DM Sans', system-ui, sans-serif` (`--font-body`, `--font-sub`)
- **Weights in use:** 300 (body default) · 400 (normal) · 500 (semi-bold buttons) · 600 (card titles) · 700 (display headings)
- Body smoothing on: `-webkit-font-smoothing: antialiased`

### 5.3 Spacing & radius

| Token | Value | Use |
|---|---|---|
| `--space-section` | 24 px | Gap between major page sections |
| `--space-card` | 16 px | Internal card padding |
| `--touch-min` | 44 px | Minimum tappable target |
| `--radius-card` | 8 px | Cards, panels |
| `--radius-button` | 8 px | Buttons, inputs |
| `--radius-tag` | 4 px | Badges, pills, category tags |
| `--nav-height` | 64 px | Bottom-nav item height |

Header height (separately): 56 px.

### 5.4 Motion & transitions

- Buttons / nav: `transition: all 0.15s` (colour + bg)
- Detail drawer: `transition: transform 0.3s cubic-bezier(0.4,0,0.2,1)` (iOS easing)
- Drag-over quadrant: `transition: 0.12s` (border + bg colour)
- Spinner: `@keyframes spin` 0.8 s linear infinite
- Brief sections: `@keyframes fadeIn` 0.35 s, staggered 60 ms increments
- Drawer slide-in: `@keyframes slideInRight` for mobile email detail
- No `prefers-reduced-motion` handling today

### 5.5 Component primitives

All defined inline in `app/dashboard/page.tsx`. No component library. A future Epic 5 will extract these into `app/dashboard/_components/`.

| Primitive | File:line | Notes |
|---|---|---|
| `TabBtn` | 145–155 | Inactive: transparent. Active: gold bg + text. 0.15 s transition. |
| `Card` | 157–159 | Navy-light bg, subtle border, 8 px radius, 20 px padding. |
| `Badge` | 161–163 | 11 px font, uppercase, 2 px vertical padding, letter-spacing 0.5 px. |
| `QuadrantBadge` | 165–168 | `Badge` keyed to "Q1/Q2/Q3/Q4" with quadrant tint. |
| `Spinner` | 170–177 | Rotating gold border + "Loading…" text. |
| `Modal` | 179–192 | Bottom sheet (mobile) ↔ centred dialog (desktop). 72 % black scrim. Drag handle + Esc/click-outside close. |
| `SectionHeading` | 195–203 | 13 px, uppercase, 1 px letter-spacing, gold, serif font. |

**Constraint callout for designers.** No shadow elevation system — depth is communicated via colour + border + opacity. Designers should avoid introducing drop shadows unless explicitly intended as a new design direction.

---

## 6. Interaction patterns

| Pattern | Where | Detail |
|---|---|---|
| **Drag-drop** | Tasks tab | Cards drag between Q1/Q2/Q3/Q4. Drag preview at opacity 0.35. Drop-zone bg/border tints on hover (0.12 s transition). |
| **Swipe-to-archive** | Mail tab (mobile) | -15 px horizontal threshold triggers archive. Released before threshold = snap back. |
| **Bottom-sheet modal** | < 768 px viewport | Drag handle at top. 20 px top radius. Click-outside or Esc closes. |
| **Centred dialog** | ≥ 768 px viewport | 16 px radius. 72 % black scrim. Same close behaviours. |
| **Side drawer (right-slide)** | Mail detail | `translateX` 0.3 s cubic-bezier. Same on mobile and desktop. |
| **Optimistic update** | Mail archive, task drag | UI updates immediately; server reconciles in background. Failure = revert + toast (toast not implemented today). |
| **Auto-scroll** | Chat | Scrolls to latest message on new arrival. |
| **Keyboard shortcuts** | Mail | `R` = reply · `E` = archive · `Esc` = close detail. |
| **Quick-action chips** | Chat (first load only) | 6 prompt-shortcut buttons that send a canned query. |
| **Inline edit modal** | Tasks | Tap edit → modal pre-populated with task fields. Same modal as Add. |
| **FAB (desktop only)** | Tasks | Bottom-right floating "+" button @ ≥769 px. Mobile uses a header button + modal. |

**Patterns not yet in the product** (open for design decisions):
- In-app toast / snackbar for transient feedback
- Pull-to-refresh
- Long-press menus
- Multi-select bulk actions
- Undo affordance after destructive ops

---

## 7. Responsive behavior

Breakpoints in CSS:

| Breakpoint | Triggered changes |
|---|---|
| `< 640 px` | Main content padding 16 px (vs 24 px); chat container uses `100svh` for keyboard safety |
| `< 768 px` | Briefing grid 2-col → 1-col; modals become bottom sheets; FAB in Tasks hidden (replaced by header button + modal) |
| `< 900 px` | Calendar Week view falls back to horizontal scroll instead of 7-col grid |

**Always-on mobile considerations:**
- `touch-action: manipulation` (disables 300 ms double-tap zoom delay)
- `-webkit-tap-highlight-color: transparent` (no flash on tap)
- Safe-area insets respected via `env(safe-area-inset-top)` / `…-bottom` on header + nav
- `-webkit-overflow-scrolling: touch` on horizontally scrollable areas

**Currently fixed regardless of width:** colour scheme (no light mode), font stack, typography weights.

---

## 8. Voice & tone

Tone source: `chat` system prompt in `ai_prompts` table + the `SYSTEM_PROMPT` const baked into `morning-brief/index.ts`.

**Voice attributes.**
- Direct, sparse — treats user's time as scarce
- "World-class Chief of Staff" persona
- No hedging, no fluff, no padding
- Never says "I don't have access to…" — context is always injected; missing data is reported as "None" or "No X today"
- Prioritises one clear next action over comprehensive coverage

**Brief structure** (the rules the AI follows when generating the morning email):
1. One-paragraph situation summary
2. Today's schedule
3. Revenue and pipeline status
4. Q1 priorities
5. Q2 focus recommendation (one specific block + time estimate)
6. Risk flags (overdue follow-ups, stalled deals, no-contact-in-14-days)
7. Single recommended first action
8. Markdown formatting throughout

**UI copy implications.** Empty-state strings, button labels, error messages should match this voice. Examples already in product:
- "No urgent tasks — great start."
- "No meetings today — clear day ahead."
- "Generate Brief" (verb-first action, no "Click to…")
- "Sorry, I encountered an error. Please try again." (apology + clear next step)

**Implication for designer.** Copy is part of the design. Generic strings ("Submit", "Continue", "Loading data…") would feel off-brand.

---

## 9. Accessibility baseline

**What's in place today.**
- Touch min 44 × 44 px (`--touch-min` CSS var)
- Dark theme — gold (`#C19131`) on navy (`#2E3D49`) clears WCAG AA at body sizes
- Keyboard shortcuts on Mail tab (R / E / Esc)
- Form inputs have `<label>` elements (most fields)

**Open questions for design refinement.**
- **Tab order / focus indicators** — none explicit today; default browser focus rings only
- **Screen reader labels** — no `aria-*` attributes seen in the dashboard
- **Color contrast for badges** — quadrant tints at 0.08 alpha bg with text on top likely fail at < 14 px font
- **Reduced-motion** — no `@media (prefers-reduced-motion: reduce)` handling for spinners or staggered fades
- **Form field labels vs placeholder** — some inputs use placeholder only; design refinement should set a standard
- **Error messages** — currently inline; no `aria-live` regions

A design refinement pass that targets WCAG 2.1 AA would mostly be additive — the dark theme and 44 px touch targets are already in good shape.

---

## 10. Edge Functions (15 total — 13 active + 2 deprecated stubs)

All AI is Anthropic Claude. Lovable AI Gateway has been fully removed.

| Slug | verify_jwt | Triggered by | Notes |
|---|---|---|---|
| `ms-auth` | no | dashboard, other Edge Fns | OAuth orchestration. Refresh token in **Supabase Vault** (`microsoft_refresh_token`). Access tokens never persisted. Source: `supabase/functions/ms-auth/`. |
| `ms-calendar` | no | (no callers) | Pulls Graph calendarview, upserts `calendar_events`. Currently dormant — dashboard reads Graph live. |
| `ms-outlook-folders` | no | **pg_cron `sync-outlook-matrix` (every 15 min)** | Reads 4 mapped Outlook folders → AI-extracts SMART tasks (Claude Haiku 4.5) → consolidates per-sender → inserts `eisenhower_tasks`. Source: `supabase/functions/ms-outlook-folders/`. |
| `delete-outlook-email` | no | dashboard | Graph DELETE message |
| `fetch-email` | no | dashboard | Graph GET message by id |
| `reimport-emails` | no | manual | Re-classification pass |
| `chat` | yes | dashboard | Conversational EA assistant. Claude Sonnet 4.5. Source: `supabase/functions/chat/`. |
| `draft-reply` | yes | dashboard | AI email reply generation. Claude Sonnet 4.5. |
| `improve-prompt` | no | manual | Prompt iteration tool |
| `active-prompt` | no | unknown | Returns active prompt from `ai_prompts` |
| `sender-history` | no | unknown | Sender history lookup |
| `follow-ups` | no | unknown | Populates `follow_ups` table |
| `sync-vips` | no | **pg_cron `sync-vips-daily` (19:00 UTC)** + Settings "Sync now" | Reads SharePoint Qurate Client folders + personal OneDrive engagements. Writes `user_preferences.vip_companies_auto`. Source: `supabase/functions/sync-vips/`. |
| `morning-brief` | no | **pg_cron `morning-brief-daily` (20:30 UTC weekdays = 06:30 AEST)** + dashboard Briefing tab | Single source of truth for the daily brief. Body `{force?, send?, context?}`. Generates via Claude Sonnet 4.5, persists to `ai_daily_briefs`, optionally renders markdown→HTML and emails via Graph `/me/sendMail`. Self-emails on failure. Source: `supabase/functions/morning-brief/`. |
| `daily-brief` | no | none | **DEPRECATED.** 410 stub — original Lovable Gemini implementation removed. Replaced by `morning-brief`. |
| `send-brief` | no | none | **DEPRECATED.** 410 stub. Replaced by `morning-brief` `{send:true}`. |

Source-controlled today: `chat`, `morning-brief`, `ms-auth`, `ms-outlook-folders`, `sync-vips`. Remaining functions still live only in Supabase — Epic 3.

---

## 11. Data model

`public` schema, 21 tables. Selected key state:

| Table | Rows (approx) | Read by dashboard? | Written by | Status |
|---|---|---|---|---|
| `eisenhower_tasks` | ~57 email-derived (daily refresh) + 35 manual | ✅ CRUD | `ms-outlook-folders`, dashboard | Healthy. Cleaned from 227,407 dups. Unique partial index `ux_eisenhower_tasks_source_email_id` enforces dedup at DB level. |
| `email_processing_history` | 2,343 | ❌ | external (n8n likely) | Rich AI classification — still untapped (Epic 1). |
| `ai_daily_briefs` | growing daily | ✅ read | `morning-brief` | Working. Today's row populated by 06:30 AEST cron. `sent_at` timestamp tracks email delivery. |
| `user_preferences` | small | ✅ R/W | dashboard, `sync-vips` | Working. Holds briefing time / focus hours / timezone / `vip_companies` (manual) / `vip_companies_auto` (synced). |
| `ai_prompts` | 4 | ❌ (read by Edge Fns) | `improve-prompt` | Versioned system prompts. `chat` row read by `chat` Edge Function. |
| `api_cost_log` | grows per call | ❌ | every AI Edge Fn | Per-call AI spend tracking. Operations: `morning_brief`, `chat`, `email_task_extraction`, `email_task_reprocess`, `draft_reply`. |
| `chat_conversations`, `chat_messages` | ~12 / ~32 | ❌ | `chat` | Server-side chat history exists but UI doesn't load it on mount. |
| `calendar_events` | 0 | ❌ | `ms-calendar` | Function exists, no caller — dashboard reads Graph live instead. |
| `vip_contacts` | 0 | ❌ | unused | Designed for VIP UI, superseded by `user_preferences.vip_companies*`. |
| `briefing_sections`, `email_drafts`, `personal_items`, `core_*` | 0 | ❌ | manual / unused | Reserved for future modules (EOS Rocks, decisions, drafts approval). |
| `strategy_rocks` | 7 | ❌ | manual | Q1 rocks. Awaits a UI. |
| `eos_annual_goals` | 6 | ❌ | manual | FY26 goals. Awaits a UI. |
| `microsoft_oauth_tokens` | — | — | — | **DROPPED 2026-05-02.** Refresh token now in `vault.secrets`. Access tokens never persisted. |
| `teams_messages`, `follow_ups` | 0 | ❌ | designed | Unused. |

**Headline:** the dashboard reads/writes 3 tables (`eisenhower_tasks`, `ai_daily_briefs`, `user_preferences`) of the 21 in schema. Bridging the orphans is Epic 1.

---

## 12. Authentication

OAuth via Microsoft Identity Platform → Edge Function `ms-auth` orchestrates the flow.

- User clicks "Sign in with Microsoft" on `/` → `ms-auth?action=login` returns auth URL → user consents at Microsoft → Microsoft redirects to `/api/auth/callback` → callback POSTs code to `ms-auth?action=callback`
- `ms-auth` exchanges the code for tokens, **stores the refresh token encrypted in `vault.secrets` as `microsoft_refresh_token`** (Vault refactor, 2026-05-02), drops the access token (never persisted), sets the `ms_auth_connected=1` cookie (httpOnly, sameSite=lax)
- Every subsequent Edge Function call that needs Graph hits `ms-auth` (default action), which reads the Vault secret, exchanges it with Microsoft for a fresh access token, and returns it to the caller. **Access tokens have a request-scoped lifetime** — they exist only for the duration of the call.
- Disconnect: `ms-auth?action=disconnect` deletes the Vault secret + clears cookie

**Scopes requested:** `Calendars.Read · Mail.ReadWrite · Sites.Read.All · Files.Read.All · offline_access`.

**Implication for design.** No explicit "session expired" UI today — if `ms-auth` fails to get a token, the dashboard silently falls through (calendar/email empty, no error toast). Future hardening should surface this.

---

## 13. Security findings

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | RLS open on most tables (`USING (true) WITH CHECK (true)`) | 🟢 low (single user) | Acceptable today; blocker for multi-tenant Epic 7 |
| 2 | Anon key embedded in client | 🟢 low | Standard for Supabase + single user. Re-evaluate at Epic 7. |
| 3 | pg_cron commands embed JWT as plaintext | 🟢 low | Public anon key only; no secret leakage but ugly |
| 4 | No CSP, no security headers | 🟡 medium | Vercel default headers only. Worth a follow-up. |
| 5 | Edge Functions log error messages to console (visible to anyone with project access) | 🟢 low | Acceptable for solo project |

**Resolved since v2:** Microsoft refresh token moved from `microsoft_oauth_tokens` table → Vault. Access tokens no longer persisted at all.

---

## 14. Strengths (carried forward)

- **Solid Edge Function ecosystem** — `ms-auth` correctly handles refresh-token rotation via Vault; `ms-outlook-folders` has smart per-sender consolidation logic; `morning-brief` consolidates the entire brief pipeline behind one idempotent endpoint
- **AI cost is tracked per call** in `api_cost_log` (~3,500 rows + growing). Easy to graph spend by operation or model
- **EOS / Chief-of-Staff schema is in place** even though UI hasn't caught up — Rocks, decisions, deliverables, clients tables are ready
- **Failure alerts** — `morning-brief` self-emails on error (Epic 6), so silent cron failures become loud emails
- **Schema is well-designed** with sensible enums, checks, FKs, generated columns

---

## 15. Open issues

| # | Issue | Severity | Tracking |
|---|---|---|---|
| 1 | Dashboard ignores `email_processing_history` — already-classified emails not surfaced in UI | 🟡 medium | Epic 1 |
| 2 | `calendar_events` empty — `ms-calendar` exists but no caller | 🟡 medium | Epic 1 |
| 3 | 8 Edge Functions still live only in Supabase, not source-controlled | 🟡 medium | Epic 3 (~33% complete) |
| 4 | Dashboard is one ~2,300-line monolith file | 🟡 medium | Epic 5 |
| 5 | No Sentry / error tracking for the Next.js app | 🟢 low | Epic 6 (DSN pending from user) |
| 6 | No Playwright / E2E tests | 🟢 low | Epic 6 |
| 7 | Permissive RLS policies | 🟢 low (single user) | Epic 7 |
| 8 | "Richard" hardcoded into prompts and frontend | 🟢 low | Epic 7 |
| 9 | No in-app toast / snackbar for transient feedback | 🟢 low | (design decision needed) |
| 10 | No undo affordance after destructive ops | 🟢 low | (design decision needed) |

**Resolved since v2** (see `docs/CHANGELOG.md`): runaway pg_cron, broken brief delivery, settings non-persistence, silent failure mode, Lovable API dependency, missing Vault for refresh token.

---

## 16. Roadmap

See `docs/EPICS.md` for the full ordered roadmap. Headline status as of 2026-05-03:

| Epic | Status |
|---|---|
| 0 — Stop the runaway, clean data | ✅ shipped 2026-05-03 |
| 1 — Bridge dashboard ↔ back-of-house | ⬜ not started |
| 2 — Daily brief, generated and emailed by Claude | ✅ shipped 2026-05-03 |
| 3 — Version-control the back-of-house | 🟡 ~33% (5/15 functions in repo) |
| 4 — Settings to Supabase + VIP propagation | ✅ shipped |
| 5 — Dashboard decomposition | ⬜ not started |
| 6 — Quality & observability | 🟡 partial — failure alerts + `/api/health` shipped; Sentry + Playwright pending |
| 7 — Multi-tenant | ⏸ deferred |

Critical path complete. Highest-leverage next move from a UX perspective is **Epic 5** (decomposition) so this BRD's per-screen specs can be turned into reusable components a designer can map 1:1.

---

## Appendix — How we got here

This product started as a Next.js dashboard against Microsoft 365. A back-of-house Supabase pipeline (Edge Functions + pg_cron + Lovable AI Gateway) was added separately, classifying emails into `email_processing_history` and writing tasks to `eisenhower_tasks`. The two surfaces never quite met — the dashboard kept reading Graph live and ignored the populated tables.

A 2026-05-02 audit surfaced the gap plus several urgent issues: a runaway pg_cron job had ballooned `eisenhower_tasks` to 227,407 rows (~160× duplicated) and was bleeding AI credits every 15 minutes; the daily brief existed but had no email delivery and was broken because the Lovable API key wasn't set; settings lived in `localStorage` and didn't survive a device switch; the `microsoft_oauth_tokens` table was empty (token storage was silently failing).

Work on 2026-05-02 → 2026-05-03 closed the critical path:
- **Epic 0**: paused the cron, fixed the dedup root cause, added a unique partial index, cleaned the duplicates, migrated the AI provider to Anthropic Haiku, resumed the cron.
- **Epic 2**: built `morning-brief` Edge Function on Anthropic Sonnet 4.5, consolidating generation + persistence + Graph email delivery into one idempotent endpoint. Scheduled via pg_cron at 06:30 AEST weekdays.
- **Epic 4**: settings persisted to `user_preferences`; VIP list synced from SharePoint via `sync-vips`; merged `vipCompaniesMerged` propagated through every VIP-aware tab; localStorage migrated.
- **Epic 6 (partial)**: `morning-brief` self-emails on failure; `/api/health` JSON status endpoint added.
- **Vault refactor**: Microsoft refresh token moved to Supabase Vault; access tokens never persisted.

For the day-by-day operational record see `docs/CHANGELOG.md`. For active work see `docs/EPICS.md`.
