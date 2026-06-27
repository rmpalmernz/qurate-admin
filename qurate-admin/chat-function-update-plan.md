# Qurate EA — Chat Edge Function Update Plan

## Goal
Transform the `chat` Edge Function from a generic AI assistant into a world-class EA that knows Richard's business, clients, pipeline, tasks, calendar, and risks in real time.

---

## Step 1 — Add CRM credentials to Supabase Secrets

In Supabase Dashboard → Edge Functions → Secrets, add:

- `CRM_SUPABASE_URL` = `https://wzzucfuixqbjowztqzbr.supabase.co`
- `CRM_SUPABASE_ANON_KEY` = (get from CRM project → Settings → API → anon key)

These allow the chat Edge Function to query the CRM at brief-generation time.

---

## Step 2 — Update supabase/functions/chat/index.ts

Replace the entire file with the following logic:

### What the function does on a Generate Brief call:

1. Queries **EA Supabase** for:
   - Active Q1 tasks (`eisenhower_tasks` where quadrant = 'do' and status != 'done')
   - Active Q2 tasks (`eisenhower_tasks` where quadrant = 'schedule' and status != 'done')
   - Active Q3 tasks (`eisenhower_tasks` where quadrant = 'delegate' and status != 'done')
   - Overdue tasks (due_date < today and status != 'done')
   - Active follow-ups (`follow_ups` where resolved_at is null, ordered by days_overdue desc)
   - Latest brief (`ai_daily_briefs` ordered by created_at desc, limit 1)

2. Queries **CRM Supabase** for:
   - Active client companies (`companies` where company_type = 'Client' and archived_at is null)
   - Active prospect companies (`companies` where company_type = 'Prospect' and archived_at is null)
   - Open pipeline deals (`pipeline_deals` where closed_at is null, ordered by value desc)
   - Primary contacts for active companies

3. Assembles all data into a structured context object

4. Calls Claude with a rich system prompt + structured context

5. Saves the generated brief to `ai_daily_briefs` table

---

## Step 3 — New System Prompt

```
You are Richard Palmer's world-class Chief of Staff and Executive Assistant.

RICHARD'S IDENTITY
- Partner at Qurate Advisory — strategic M&A advisory for business exits and transitions, lower mid-market ($2M–$50M enterprise value)
- Also runs Alstonville Plants — horticulture business targeting $500k+ free cash
- Independent Director: Think Water Group
- Framework: EOS (Entrepreneurial Operating System) — Quarterly Rocks, L10 meetings, Scorecard
- Timezone: AEST (Brisbane, Australia)
- Revenue target: $500k retainer revenue (Qurate Advisory)

YOUR ROLE
Act as a world-class EA and Chief of Staff. You know Richard's business deeply. You are proactive, direct, and prioritised. You surface what matters most, flag risks early, and give Richard one clear next action. You never waffle. You never pad. You treat Richard's time as the scarcest resource.

EISENHOWER FRAMEWORK
Every item in Richard's world is classified:
- Q1 (Do): Urgent + Important — act within 24–48 hours
- Q2 (Plan): Not urgent + Important — highest value work, protect this time
- Q3 (Delegate): Urgent + Not important — someone else handles this
- Q4 (Eliminate): Not urgent + Not important — ignore

CLIENTS AND PIPELINE CONTEXT
[INJECTED AT RUNTIME — see context object below]

TODAY'S CONTEXT
[INJECTED AT RUNTIME — see context object below]

RESPONSE RULES
1. Start with a one-paragraph situation summary — what matters most today, in plain English
2. Today's schedule — list meetings with any prep flags
3. Q1 priorities — tasks that need action today, with client context
4. Q2 focus recommendation — one specific block with time estimate
5. Risk flags — overdue follow-ups, overdue tasks, stalled deals, unread urgent emails
6. One recommended first action — the single most important thing Richard should do right now
7. Use markdown. Be concise. No fluff. No generic advice.
8. Never say "I don't have access to..." — you have full context via the injected data.
```

---

## Step 4 — Context object structure (assembled by Edge Function)

```typescript
const context = {
  // Identity
  today: new Date().toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Australia/Brisbane' }),
  
  // From frontend (passed in POST body)
  calendar: {
    todayEvents: [], // CalendarEvent[] for today
    upcomingEvents: [] // CalendarEvent[] next 7 days
  },
  email: {
    unreadCount: 0,
    q1Emails: [], // top 3 urgent emails: subject, from
    vipContacts: [] // from localStorage
  },
  
  // From EA Supabase
  tasks: {
    q1: [], // { title, client_name, due_date, estimated_minutes }
    q2: [], // { title, client_name, estimated_minutes }
    q3: [], // { title, client_name, delegated_to }
    overdue: [] // { title, client_name, due_date }
  },
  followUps: [], // { subject, recipient, days_overdue }
  previousBrief: null, // brief_text from yesterday
  
  // From CRM Supabase
  clients: [], // { name, company_type, primary_contact_name, contact_email }
  prospects: [], // { name, primary_contact_name }
  pipeline: {
    openDeals: [], // { title, company_name, value, stage, probability, expected_close_date, days_in_current_stage }
    totalPipelineValue: 0,
    weightedPipelineValue: 0 // value * probability / 100
  }
}
```

---

## Step 5 — How context is injected into the prompt

The Edge Function converts the context object into a structured text block appended to the system prompt:

```
=== LIVE CONTEXT: TODAY IS [DATE] ===

ACTIVE CLIENTS:
- Think Water Group | Contact: [name] | [email]
- Therefore Group | Contact: [name] | [email]
- Providence Wealth | Contact: [name] | [email]

ACTIVE PROSPECTS:
- [Name] | Contact: [name]

OPEN PIPELINE:
- [Deal title] | [Company] | $[value] | Stage: [stage] | Probability: [%] | Close: [date] | Days in stage: [n]
Total pipeline: $[X] | Weighted: $[X]

TODAY'S CALENDAR:
- [Time] [Subject] with [Organizer] at [Location]

Q1 TASKS (act today):
- [Title] | Client: [client] | Due: [date] | Est: [mins]min

Q2 TASKS (schedule this week):
- [Title] | Client: [client] | Est: [mins]min

OVERDUE TASKS:
- [Title] | Client: [client] | Was due: [date]

OVERDUE FOLLOW-UPS ([n] total):
- "[Subject]" to [recipient] — [n] days overdue

EMAIL STATUS:
- [n] unread emails | [n] urgent (Q1)
- Top urgent: [subject] from [name]

PREVIOUS BRIEF SUMMARY:
[brief_text from yesterday, truncated to 500 chars]
```

---

## Step 6 — Also save brief to ai_daily_briefs

After Claude responds, the Edge Function inserts the response into `ai_daily_briefs`:

```typescript
await eaSupabase
  .from('ai_daily_briefs')
  .insert({ brief_text: claudeResponse })
```

---

## Step 7 — Frontend changes (BriefingTab)

Update the Generate Brief POST body to include:

```typescript
{
  message: "Generate my morning briefing",
  messages: [{ role: 'user', content: "Generate my morning briefing" }],
  context: {
    todayEvents: todayEvts,
    upcomingEvents: events.slice(0, 20),
    unreadCount: emails.filter(e => !e.isRead).length,
    q1Emails: q1Emails.slice(0, 3).map(e => ({ subject: e.subject, from: e.from?.emailAddress?.name })),
    vipContacts: JSON.parse(localStorage.getItem('vipContacts') || '[]')
  }
}
```

The Edge Function handles the rest (tasks, follow-ups, CRM data) server-side.

---

## Implementation Order

1. Add CRM secrets to Supabase Edge Function secrets
2. Update `supabase/functions/chat/index.ts` with new logic
3. Deploy: `supabase functions deploy chat`
4. Update BriefingTab POST body in `app/dashboard/page.tsx`
5. Test Generate Brief
6. Verify brief is saved to `ai_daily_briefs`
7. Commit

---

## Notes

- CRM queries use the anon key — ensure RLS on CRM allows read access for the anon role on companies, contacts, pipeline_deals
- If CRM query fails, the function should degrade gracefully and generate the brief with EA data only
- Pipeline values are in USD per the schema default — may need to change to AUD
- The `currency` field on pipeline_deals should be set to 'AUD' for Richard's deals
