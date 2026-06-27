# Qurate EA — Codebase Refactor Plan

## Goal
Extract canonical UI primitives, types, and layout components out of `app/dashboard/page.tsx` into a maintainable folder structure. No new functionality. No visual changes. No behaviour changes.

## Golden Rule
This refactor must be invisible to the user. The app must look and behave identically before and after.

---

## Target Structure

```
app/
  layout.tsx                    — unchanged
  page.tsx                      — unchanged (login)
  dashboard/
    page.tsx                    — SIMPLIFIED: imports components, contains tab logic only
    layout.tsx                  — unchanged

components/
  ui/
    Card.tsx                    — canonical Card primitive
    Badge.tsx                   — canonical Badge primitive
    QuadrantBadge.tsx           — canonical QuadrantBadge primitive
    Modal.tsx                   — canonical Modal primitive
    Spinner.tsx                 — canonical Spinner primitive
    Button.tsx                  — canonical Button primitive (if exists)
    TabBtn.tsx                  — canonical TabBtn primitive
  layout/
    Header.tsx                  — fixed top header with logo, theme toggle, sign out
    BottomNav.tsx               — fixed bottom tab navigation bar

lib/
  types.ts                      — ALL TypeScript interfaces (Email, CalendarEvent, EisenhowerTask, FollowUp, etc)
  constants.ts                  — brand tokens, quadrant config (Q_CONFIG), helper functions
  supabase.ts                   — unchanged (already correct)
  utils.ts                      — shared utility functions (formatDate, timeAgo, renderMarkdown, authFetch, etc)
```

---

## Step-by-Step Instructions

### Step 1 — Create folder structure
Create these folders if they don't exist:
- `components/ui/`
- `components/layout/`
- `lib/` (already exists)

Do not create any files yet.

### Step 2 — Extract lib/types.ts
Move ALL TypeScript interfaces from `app/dashboard/page.tsx` into `lib/types.ts`.

Interfaces to extract:
- `Email`
- `CalendarEvent`
- `EisenhowerTask`
- `FollowUp` (new, from Task 1)
- Any other interfaces defined at the top of page.tsx

Export all of them. Import them back into `app/dashboard/page.tsx`.

Verify: `app/dashboard/page.tsx` should have zero interface definitions after this step.

### Step 3 — Extract lib/constants.ts
Move these from `app/dashboard/page.tsx` into `lib/constants.ts`:
- `Q_CONFIG` object (quadrant labels, colours, descriptions)
- Any other top-level constants

Export all. Import back into `app/dashboard/page.tsx`.

### Step 4 — Extract lib/utils.ts
Move these utility functions from `app/dashboard/page.tsx` into `lib/utils.ts`:
- `formatDate()`
- `timeAgo()`
- `renderMarkdown()`
- `authFetch()`
- Any other pure utility functions

Export all. Import back into `app/dashboard/page.tsx`.

Do NOT move functions that use React state or hooks — those stay in page.tsx.

### Step 5 — Extract components/ui/Card.tsx
Find the canonical `Card` component in `app/dashboard/page.tsx`.
Move it to `components/ui/Card.tsx`.
Export as default.
Import back into `app/dashboard/page.tsx`.

Rules:
- Do not change the component's props, styling, or behaviour
- Do not create variants
- One file, one component

### Step 6 — Extract components/ui/Badge.tsx
Same process as Step 5 for the `Badge` component.

### Step 7 — Extract components/ui/QuadrantBadge.tsx
Same process as Step 5 for the `QuadrantBadge` component.
This component depends on Q_CONFIG — import from `lib/constants.ts`.

### Step 8 — Extract components/ui/Modal.tsx
Same process as Step 5 for the `Modal` component.

### Step 9 — Extract components/ui/Spinner.tsx
Same process as Step 5 for the `Spinner` component.

### Step 10 — Extract components/ui/TabBtn.tsx
Same process as Step 5 for the `TabBtn` component.

### Step 11 — Extract components/layout/Header.tsx
Find the fixed top header JSX in `app/dashboard/page.tsx`.
Move it to `components/layout/Header.tsx` as a proper React component.
Props it needs: `activeTab`, `onSignOut`, `onThemeToggle`, `isDarkMode` (or whatever it currently uses).
Import back into `app/dashboard/page.tsx`.

### Step 12 — Extract components/layout/BottomNav.tsx
Find the fixed bottom navigation bar JSX in `app/dashboard/page.tsx`.
Move it to `components/layout/BottomNav.tsx` as a proper React component.
Props it needs: `activeTab`, `onTabChange`, badge counts (unread, events, q1tasks).
Import back into `app/dashboard/page.tsx`.

### Step 13 — Clean up app/dashboard/page.tsx
After all extractions, `app/dashboard/page.tsx` should contain:
- Imports only (no inline definitions of primitives)
- Top-level state and data fetching
- Tab component functions: BriefingTab, EmailTab, MatrixTab, CalendarTab, ClientsTab, ChatTab, SettingsTab
- The main Dashboard component that assembles everything

It should NOT contain:
- Interface definitions (moved to lib/types.ts)
- Constant objects (moved to lib/constants.ts)
- Utility functions (moved to lib/utils.ts)
- Primitive component definitions (moved to components/ui/)
- Layout component definitions (moved to components/layout/)

### Step 14 — Verify
Run `npm run build` and confirm zero errors.
Run the app locally and confirm it looks and behaves identically to before.
Check every tab: Brief, Mail, Tasks, Calendar, Clients, Chat, Settings.

---

## Rules for This Refactor

- NO visual changes
- NO behaviour changes  
- NO new features
- NO new styling
- NO component variants
- ONLY moving code to better locations
- Every moved piece must be immediately imported back so nothing breaks
- Do one step at a time, verify after each step
- If unsure about a step, stop and ask

---

## What This Achieves

After this refactor:
- Every new feature adds a component to `components/ui/` — never inline in a page
- Every new type goes in `lib/types.ts` — one place to look
- Every utility function goes in `lib/utils.ts` — no duplication
- `app/dashboard/page.tsx` stays manageable as features are added
- Cursor Agent has clear canonical locations for everything
- Your coding rules become enforceable
