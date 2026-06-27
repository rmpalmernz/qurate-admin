'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { SUPABASE_FUNCTIONS_URL } from '@/lib/supabase'
import { useUserSettings, DEFAULT_SETTINGS } from './_hooks/useUserSettings'

const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!

const authFetch = (url: string, opts: RequestInit = {}) =>
  fetch(url, { ...opts, headers: { ...(opts.headers || {}), apikey: ANON_KEY, 'Content-Type': 'application/json' } })

// ─── Types ────────────────────────────────────────────────────────────────────
interface Email {
  id: string
  subject: string
  from: { name: string; address: string }
  receivedDateTime: string
  bodyPreview: string
  isRead: boolean
  ai_category?: string
  ai_priority_level?: string
  ai_client_name?: string
  ai_original_email_summary?: string
  ai_quadrant?: 'do' | 'schedule' | 'delegate' | 'eliminate'
}

interface CalendarEvent {
  id: string
  subject: string
  start: { dateTime?: string; date?: string }
  end: { dateTime?: string; date?: string }
  isAllDay?: boolean
  location?: { displayName: string }
  organizer?: { emailAddress: { name: string } }
  bodyPreview?: string
}

interface EisenhowerTask {
  id: string
  title: string
  description?: string
  quadrant: 'do' | 'schedule' | 'delegate' | 'eliminate'
  ai_suggested_quadrant?: 'do' | 'schedule' | 'delegate' | 'eliminate' | null
  quadrant_override?: boolean
  client_name?: string
  due_date?: string
  status: string
  estimated_minutes?: number
  notes?: string
  source_email_ids?: string[]
  delegated_to?: string
  delegation_channel?: string
  source_type?: string
  tags?: string[]
  priority_score?: number
  created_at?: string
  updated_at?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// MS Graph returns dateTime strings without a timezone suffix (e.g. "2026-02-24T09:00:00.0000000").
// Without 'Z', JS parses them as LOCAL time — wrong. Force UTC by appending 'Z' when no offset is present.
const msToDate = (d: string) => new Date(/Z$|[+\-]\d{2}:\d{2}$/.test(d) ? d : d + 'Z')
const fmt = (d: string) => msToDate(d).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })
const fmtDate = (d: string) => msToDate(d).toLocaleDateString('en-AU', { weekday: 'short', month: 'short', day: 'numeric' })
const timeAgo = (d: string) => {
  const diff = Date.now() - new Date(d).getTime()
  const h = Math.floor(diff / 3600000)
  if (h < 1) return `${Math.floor(diff / 60000)}m ago`
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// Distinguishes the two failure modes that used to be collapsed into a bare null:
//   - 'disconnected': ms-auth answered but there's no usable token (no refresh token stored)
//   - 'auth_failed' : ms-auth errored (refresh exchange failed) or was unreachable
// Callers use this to tell "nothing to show" apart from "couldn't look".
type MsTokenResult = { token: string | null; error?: 'disconnected' | 'auth_failed' }
async function getMsToken(): Promise<MsTokenResult> {
  try {
    const res = await authFetch(`${SUPABASE_FUNCTIONS_URL}/ms-auth`)
    if (!res.ok) {
      // ms-auth returns 500 + {error} when the stored refresh token is invalid/expired.
      return { token: null, error: 'auth_failed' }
    }
    const data = await res.json()
    if (data.access_token) return { token: data.access_token }
    return { token: null, error: 'disconnected' }
  } catch {
    return { token: null, error: 'auth_failed' }
  }
}

// Lowercase + strip non-alphanumerics → matches against email domain substrings.
// "Think Water" → "thinkwater"
function vipDomainMatcher(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function emailToQuadrant(email: Email): 'do' | 'schedule' | 'delegate' | 'eliminate' {
  if (email.ai_quadrant) return email.ai_quadrant
  const pri = email.ai_priority_level?.toLowerCase() || ''
  const cat = email.ai_category?.toLowerCase() || ''
  if (pri === 'high') return 'do'
  if (cat.includes('marketing') || cat.includes('newsletter') || cat.includes('notification')) return 'eliminate'
  if (pri === 'medium') return 'schedule'
  if (pri === 'low') return 'delegate'
  return 'schedule'
}

function emailCategory(email: Email, vipCompanies: string[]): 'vip' | 'partner' | 'tools' | 'other' {
  const addr = (email.from?.address || '').toLowerCase()
  const cn   = email.ai_client_name || ''
  const vipNameHit   = vipCompanies.some(c => cn.toLowerCase().includes(c.toLowerCase()))
  const vipDomainHit = vipCompanies.some(c => addr.includes(vipDomainMatcher(c)))
  if (vipNameHit || vipDomainHit) return 'vip'
  if (addr.includes('noreply') || addr.includes('no-reply') || addr.includes('notifications') ||
      addr.includes('sharepoint') || addr.includes('teams') || addr.includes('n8n') || addr.includes('microsoft')) return 'tools'
  return 'other'
}

const quadrantConfig = {
  do:        { label: 'Do First',  color: '#C0392B', bg: 'rgba(192,57,43,0.08)',   border: 'rgba(192,57,43,0.2)' },
  schedule:  { label: 'Schedule',  color: '#C19131', bg: 'rgba(193,145,49,0.08)',  border: 'rgba(193,145,49,0.2)' },
  delegate:  { label: 'Delegate',  color: '#D9D2BE', bg: 'rgba(217,210,190,0.08)', border: 'rgba(217,210,190,0.2)' },
  eliminate: { label: 'Eliminate', color: '#D9D2BE', bg: 'rgba(107,114,128,0.08)', border: 'rgba(107,114,128,0.2)' },
}

// ─── Brand constants ─────────────────────────────────────────────────────────
const NAVY        = '#2E3D49'
const NAVY_LIGHT  = '#374857'
const NAVY_BORDER = 'rgba(217,210,190,0.15)'
const GOLD        = '#C19131'
const BEIGE       = '#D9D2BE'
const WHITE       = '#FFFFFF'
const RED         = '#C0392B'

// ─── Shared styles ────────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 14px', background: NAVY, border: `1px solid ${NAVY_BORDER}`,
  borderRadius: 8, color: WHITE, fontSize: 13, outline: 'none',
  fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif", fontWeight: 300, boxSizing: 'border-box',
}
const primaryBtnStyle: React.CSSProperties = {
  padding: '10px 20px', background: GOLD,
  color: NAVY, border: 'none', borderRadius: 8, fontSize: 13,
  fontWeight: 500, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif",
}
const secondaryBtnStyle: React.CSSProperties = {
  padding: '10px 20px', background: 'transparent', color: BEIGE,
  border: `1px solid ${NAVY_BORDER}`, borderRadius: 8, fontSize: 13,
  cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif",
}

// ─── UI Primitives ────────────────────────────────────────────────────────────
function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: '8px 14px', borderRadius: 8, border: 'none',
      background: active ? 'rgba(193,145,49,0.12)' : 'transparent',
      color: active ? GOLD : BEIGE, fontWeight: active ? 500 : 300,
      fontSize: 13, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif",
      transition: 'all 0.15s', whiteSpace: 'nowrap',
    }}>{children}</button>
  )
}

function Card({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background: NAVY_LIGHT, border: `1px solid ${NAVY_BORDER}`, borderRadius: 8, padding: 20, ...style }}>{children}</div>
}

function Badge({ text, color }: { text: string; color: string }) {
  return <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, background: `${color}20`, color, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{text}</span>
}

function QuadrantBadge({ quadrant }: { quadrant: 'do' | 'schedule' | 'delegate' | 'eliminate' }) {
  const labels = { do: 'Q1', schedule: 'Q2', delegate: 'Q3', eliminate: 'Q4' }
  return <Badge text={labels[quadrant]} color={quadrantConfig[quadrant].color} />
}

function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, color: GOLD, gap: 10 }}>
      <span style={{ display: 'inline-block', width: 20, height: 20, border: `2px solid rgba(193,145,49,0.2)`, borderTopColor: GOLD, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <span style={{ fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif", fontWeight: 300, color: BEIGE }}>Loading...</span>
    </div>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet" onClick={e => e.stopPropagation()}>
        <div className="modal-handle" />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: WHITE, fontFamily: "'Gujarati Sangam MN', 'DM Sans', serif" }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: BEIGE, cursor: 'pointer', fontSize: 22, lineHeight: 1, padding: 0, touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}>&#x2715;</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// Honest failure banner — shown when a data source couldn't be loaded, so an
// empty screen is never mistaken for a genuinely quiet day. Depth via colour +
// border only (no drop shadow), per the design system.
function ErrorBanner({ messages, onRetry }: { messages: string[]; onRetry?: () => void }) {
  if (messages.length === 0) return null
  return (
    <div role="alert" style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', marginBottom: 12,
      background: 'rgba(192,57,43,0.1)', border: '1px solid rgba(192,57,43,0.3)', borderRadius: 8,
    }}>
      <span style={{ color: RED, fontSize: 16, lineHeight: 1, flexShrink: 0 }}>&#9888;</span>
      <span style={{ flex: 1, fontSize: 13, color: BEIGE, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>{messages.join(' · ')}</span>
      {onRetry && (
        <button onClick={onRetry} style={{ ...secondaryBtnStyle, padding: '5px 12px', fontSize: 12, flexShrink: 0 }}>Retry</button>
      )}
    </div>
  )
}

// ─── Health banner ──────────────────────────────────────────────────────────
// Surfaces SERVER-SIDE silent failures (today's brief never generated/emailed,
// the database unreachable) by polling /api/health. Distinct from ErrorBanner,
// which only reports this browser session's live data-load failures.
//
// Epic A / BRD §13 "Trust requires recall": an ambient EA must fail LOUDLY. Once
// the user stops checking a Mail tab, a brief that silently didn't send is
// invisible — so the most likely root cause (an invalidated Microsoft token)
// gets a plain-language explanation and a one-tap Reconnect.
type HealthCheck = { ok: boolean; detail?: string }
type HealthResponse = { status: 'ok' | 'degraded'; checks?: Record<string, HealthCheck> }

function HealthBanner() {
  const [health, setHealth] = useState<HealthResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' })
        const data = (await res.json()) as HealthResponse
        if (!cancelled) setHealth(data)
      } catch {
        // The health endpoint itself being unreachable is usually a flaky
        // network, not a real outage — stay quiet rather than crying wolf.
        // Genuine live-data failures are already covered by ErrorBanner.
      }
    }
    check()
    const id = setInterval(check, 5 * 60 * 1000) // re-check every 5 min
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (!health || health.status !== 'degraded') return null

  const checks = health.checks ?? {}
  const dbBroken = checks.supabase?.ok === false
  // A missing OR un-emailed brief almost always traces back to a dropped
  // Microsoft connection (the cron can't get a Graph token).
  const briefBroken = checks.todays_brief?.ok === false || checks.brief_sent?.ok === false

  const messages: string[] = []
  if (dbBroken) messages.push("Can't reach the database")
  if (checks.todays_brief?.ok === false) messages.push("Today's brief wasn't generated")
  else if (checks.brief_sent?.ok === false) messages.push("Today's brief wasn't emailed")

  return (
    <div role="alert" style={{
      display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 14px', marginBottom: 12,
      background: 'rgba(192,57,43,0.16)', border: '1px solid rgba(192,57,43,0.45)', borderRadius: 8,
    }}>
      <span style={{ color: RED, fontSize: 18, lineHeight: 1.2, flexShrink: 0 }}>&#9888;</span>
      <div style={{ flex: 1 }}>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: WHITE, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>
          {messages.join(' · ') || 'Something needs attention'}
        </p>
        {briefBroken && (
          <p style={{ margin: '3px 0 0', fontSize: 12, color: BEIGE, lineHeight: 1.5, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>
            This usually means your Microsoft connection has dropped. Reconnect to restore your daily brief.
          </p>
        )}
      </div>
      {briefBroken && (
        <a href="/" style={{ ...primaryBtnStyle, background: RED, color: WHITE, padding: '7px 14px', fontSize: 12, textDecoration: 'none', flexShrink: 0, whiteSpace: 'nowrap' }}>Reconnect</a>
      )}
    </div>
  )
}

// ─── Section heading (Gujarati Sangam Bold) ─────────────────────────────────
function SectionHeading({ children, color = GOLD }: { children: React.ReactNode; color?: string }) {
  return (
    <h3 style={{
      margin: 0, fontSize: 13, fontWeight: 700, color,
      textTransform: 'uppercase', letterSpacing: '1px',
      fontFamily: "'Gujarati Sangam MN', 'DM Sans', serif",
    }}>{children}</h3>
  )
}

// ─── BRIEFING TAB ─────────────────────────────────────────────────────────────
type BriefSnapshot = {
  q1Tasks?: number; q2Tasks?: number; q3Tasks?: number; overdueTasks?: number;
  followUps?: number; clients?: number; prospects?: number; openDeals?: number; calendarEvents?: number;
}
type StrategyRock = {
  id: string; rock_name: string; owner: string | null;
  status: 'on_track' | 'at_risk' | 'off_track' | string;
  percent_complete: number | null; quarter: string | null;
}

function BriefingTab({ events, tasks, emails, vipCompanies, calendarError, tasksError }: { events: CalendarEvent[]; tasks: EisenhowerTask[]; emails: Email[]; vipCompanies: string[]; calendarError?: boolean; tasksError?: boolean }) {
  const [brief, setBrief] = useState('')
  const [briefError, setBriefError] = useState<string | null>(null)
  const [briefSnapshot, setBriefSnapshot] = useState<BriefSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [rocks, setRocks] = useState<StrategyRock[]>([])

  useEffect(() => {
    fetch(`${SUPABASE_URL}/rest/v1/ai_daily_briefs?select=brief_text&order=created_at.desc&limit=1`, { headers: { apikey: ANON_KEY } })
      .then(r => r.json())
      .then(data => { if (data?.[0]) setBrief(data[0].brief_text); setLoading(false) })
      .catch(() => setLoading(false))

    // Load Q1 strategy rocks (EOS framework). Limited to current quarter when one is set;
    // falls back to all rocks otherwise. Read-only here — editing is out of scope for now.
    fetch(`${SUPABASE_URL}/rest/v1/strategy_rocks?select=id,rock_name,owner,status,percent_complete,quarter&order=status.asc,percent_complete.desc`, { headers: { apikey: ANON_KEY } })
      .then(r => r.ok ? r.json() : [])
      .then((data: StrategyRock[]) => Array.isArray(data) && setRocks(data))
      .catch(() => {})
  }, [])

  async function generateBrief() {
    setGenerating(true)
    setBriefError(null)
    try {
      const today = new Date()
      const todayKey = localDateKey(today)

      // Build a context object matching the FrontendContext shape morning-brief expects.
      const todayEvents = events
        .filter(e => (e.start?.dateTime || e.start?.date) && localDateKey(evtStart(e)) === todayKey)
        .sort((a, b) => evtStart(a).getTime() - evtStart(b).getTime())
        .map(e => ({
          subject: e.subject,
          start: e.start,
          location: e.location ? { displayName: e.location.displayName } : undefined,
          organizer: e.organizer?.emailAddress?.name
            ? { emailAddress: { name: e.organizer.emailAddress.name } }
            : undefined,
        }))

      const q1Tasks = tasks.filter(t => t.quadrant === 'do' && t.status !== 'done' && t.status !== 'cancelled')
      const q2Tasks = tasks.filter(t => t.quadrant === 'schedule' && t.status !== 'done' && t.status !== 'cancelled')
      const urgentEmails = emails.filter(e => emailToQuadrant(e) === 'do' && !e.isRead)

      const context = {
        todayEvents,
        unreadCount: emails.filter(e => !e.isRead).length,
        q1Emails: urgentEmails.slice(0, 10).map(e => ({ subject: e.subject, from: e.from?.name || e.from?.address })),
        vipContacts: vipCompanies,
        tasks: {
          q1: q1Tasks.slice(0, 15).map(t => ({ title: t.title, client_name: t.client_name, due_date: t.due_date, estimated_minutes: t.estimated_minutes })),
          q2: q2Tasks.slice(0, 10).map(t => ({ title: t.title, client_name: t.client_name, estimated_minutes: t.estimated_minutes })),
        },
      }

      const res = await authFetch(`${SUPABASE_FUNCTIONS_URL}/morning-brief`, {
        method: 'POST',
        body: JSON.stringify({ force: true, context }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      const briefText = data.brief || ''
      if (!briefText) throw new Error(`Unexpected response shape: ${JSON.stringify(data)}`)
      // Store the data snapshot returned by morning-brief so we can render the
      // "Brief built from…" footer below the brief body. Cached-brief reads
      // from the DB don't include this — the footer just hides in that case.
      if (data?.data_snapshot && typeof data.data_snapshot === 'object') {
        setBriefSnapshot(data.data_snapshot as BriefSnapshot)
      }

      setBrief(briefText)
      // morning-brief persists the row itself; no separate write needed.
    } catch (err) {
      console.error('Brief generation failed:', err)
      setBriefError(err instanceof Error ? err.message : 'Unknown error')
    }
    setGenerating(false)
  }

  const today      = new Date()
  const hour       = today.getHours()
  const greeting   = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const todayStr   = today.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })
  const todayEvts  = events
                           .filter(e => (e.start?.dateTime || e.start?.date) && localDateKey(evtStart(e)) === localDateKey(today))
                           .sort((a, b) => evtStart(a).getTime() - evtStart(b).getTime())
  const q1Tasks    = tasks.filter(t => t.quadrant === 'do')
  const q2Tasks    = tasks.filter(t => t.quadrant === 'schedule')
  const q1Emails   = emails.filter(e => emailToQuadrant(e) === 'do')
  const unread     = emails.filter(e => !e.isRead).length

  // Cancelled event detection
  const isCancelled = (e: CalendarEvent) =>
    e.subject?.toLowerCase().startsWith('cancelled') || e.subject?.toLowerCase().startsWith('canceled')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* ── Header: Greeting + Date ── */}
      <div className="briefing-section">
        <h2 style={{
          margin: 0, fontSize: 28, fontWeight: 700, color: WHITE, letterSpacing: '-0.5px',
          fontFamily: "'Gujarati Sangam MN', 'DM Sans', serif",
          lineHeight: 1.2,
        }}>
          {greeting}, Richard
        </h2>
        <p style={{
          margin: '6px 0 0', fontSize: 15, fontWeight: 300, color: BEIGE,
          fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif",
        }}>
          {todayStr}
        </p>
      </div>

      {/* ── Alert strip ── */}
      {(q1Tasks.length > 0 || unread > 0) && (
        <div className="briefing-section" style={{
          borderLeft: `3px solid ${GOLD}`,
          background: NAVY_LIGHT,
          padding: '12px 16px',
          borderRadius: `0 ${8}px ${8}px 0`,
          display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center',
        }}>
          {q1Tasks.length > 0 && (
            <span style={{ fontSize: 14, color: WHITE, fontWeight: 400, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>
              <strong style={{ color: GOLD, fontWeight: 600 }}>{q1Tasks.length}</strong> Q1 task{q1Tasks.length !== 1 ? 's' : ''} need action today
            </span>
          )}
          {unread > 0 && (
            <span style={{ fontSize: 13, color: BEIGE, fontWeight: 300 }}>
              {unread} unread total
            </span>
          )}
        </div>
      )}

      {/* ── Two-column: Calendar + Q1 Tasks ── */}
      <div className="briefing-grid">

        {/* TODAY'S CALENDAR */}
        <div className="briefing-section">
          <SectionHeading color={GOLD}>Today&apos;s Calendar</SectionHeading>
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column' }}>
            {todayEvts.length === 0 ? (
              calendarError
                ? <p style={{ color: RED, fontSize: 15, margin: 0, fontWeight: 300 }}>Couldn&apos;t load your calendar — tap Retry above.</p>
                : <p style={{ color: BEIGE, fontSize: 15, margin: 0, fontWeight: 300 }}>No meetings today — clear day ahead.</p>
            ) : (
              todayEvts.map((e, i) => {
                const cancelled = isCancelled(e)
                return (
                  <div key={e.id} style={{
                    display: 'flex', gap: 16, padding: '12px 0', minHeight: 44,
                    borderBottom: i < todayEvts.length - 1 ? `1px solid ${NAVY_BORDER}` : 'none',
                    opacity: cancelled ? 0.4 : 1,
                  }}>
                    <div style={{
                      minWidth: 72, color: GOLD, fontSize: 13, fontWeight: 600,
                      fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif",
                      paddingTop: 1,
                    }}>
                      {(e.isAllDay || !e.start?.dateTime) ? 'All day' : fmt(e.start.dateTime!)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontWeight: 400, color: WHITE, fontSize: 15,
                        fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif",
                        marginBottom: 2,
                        textDecoration: cancelled ? 'line-through' : 'none',
                      }}>
                        {e.subject}
                      </div>
                      {e.location?.displayName && (
                        <div style={{ color: BEIGE, fontSize: 13, fontWeight: 300 }}>@ {e.location.displayName}</div>
                      )}
                      {e.organizer?.emailAddress?.name && (
                        <div style={{ color: BEIGE, fontSize: 13, fontWeight: 300 }}>with {e.organizer.emailAddress.name}</div>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Q1 — DO FIRST */}
        <div className="briefing-section">
          <SectionHeading color={RED}>Q1 — Do First</SectionHeading>
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column' }}>
            {q1Tasks.length === 0 ? (
              tasksError
                ? <p style={{ color: RED, fontSize: 15, margin: 0, fontWeight: 300 }}>Couldn&apos;t load your tasks — tap Retry above.</p>
                : <p style={{ color: BEIGE, fontSize: 15, margin: 0, fontWeight: 300 }}>No urgent tasks — great start.</p>
            ) : (
              q1Tasks.slice(0, 6).map((t, i) => {
                const isOverdue = t.due_date && new Date(t.due_date + 'T23:59:59') < new Date()
                return (
                  <div key={t.id} style={{
                    padding: '10px 0 10px 12px', minHeight: 44,
                    borderLeft: isOverdue ? `3px solid ${RED}` : '3px solid transparent',
                    borderBottom: i < Math.min(q1Tasks.length, 6) - 1 ? `1px solid ${NAVY_BORDER}` : 'none',
                  }}>
                    <p style={{
                      margin: '0 0 2px', fontSize: 15, color: WHITE, fontWeight: 400,
                      fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif",
                    }}>
                      {t.title}
                    </p>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      {t.client_name && (
                        <span style={{ fontSize: 12, color: BEIGE, fontWeight: 300 }}>{t.client_name}</span>
                      )}
                      {t.due_date && (
                        <span style={{ fontSize: 12, color: isOverdue ? RED : BEIGE, fontWeight: isOverdue ? 500 : 300 }}>
                          {fmtDate(t.due_date)}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })
            )}
            {q1Tasks.length > 6 && (
              <p style={{ fontSize: 13, color: BEIGE, margin: '8px 0 0', fontWeight: 300 }}>
                +{q1Tasks.length - 6} more in Tasks
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── RECOMMENDED FOCUS BLOCKS — Q2 ── */}
      {q2Tasks.length > 0 && (
        <div className="briefing-section">
          <SectionHeading color={GOLD}>Recommended Focus Blocks — Q2 Work</SectionHeading>
          <p style={{
            margin: '8px 0 14px', fontSize: 14, color: BEIGE, fontWeight: 300,
            fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif",
          }}>
            {q2Tasks.length} scheduled item{q2Tasks.length !== 1 ? 's' : ''} — protect 2-3 hours today for deep advisory work.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {q2Tasks.slice(0, 3).map((t, i) => (
              <div key={t.id} style={{
                padding: '10px 0 10px 12px',
                borderLeft: `2px solid ${GOLD}`,
                borderBottom: i < Math.min(q2Tasks.length, 3) - 1 ? `1px solid ${NAVY_BORDER}` : 'none',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                minHeight: 44,
              }}>
                <div>
                  <span style={{ fontSize: 15, color: WHITE, fontWeight: 400, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>{t.title}</span>
                  {t.client_name && <span style={{ fontSize: 12, color: BEIGE, marginLeft: 12, fontWeight: 300 }}>{t.client_name}</span>}
                </div>
                {t.estimated_minutes && <span style={{ fontSize: 12, color: BEIGE, fontWeight: 300 }}>{t.estimated_minutes}m</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── QUARTERLY ROCKS (EOS) ── */}
      {rocks.length > 0 && (
        <div className="briefing-section">
          <SectionHeading color={GOLD}>Quarterly Rocks</SectionHeading>
          <p style={{ margin: '8px 0 14px', fontSize: 14, color: BEIGE, fontWeight: 300, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>
            {rocks.length} rock{rocks.length !== 1 ? 's' : ''} — {rocks.filter(r => r.status === 'on_track').length} on track, {rocks.filter(r => r.status === 'at_risk').length} at risk, {rocks.filter(r => r.status === 'off_track').length} off track.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {rocks.map((r, i) => {
              const statusColor = r.status === 'on_track' ? GOLD : r.status === 'at_risk' ? '#E67E22' : RED
              const statusLabel = r.status === 'on_track' ? 'On track' : r.status === 'at_risk' ? 'At risk' : r.status === 'off_track' ? 'Off track' : r.status
              return (
                <div key={r.id} style={{
                  padding: '10px 0 10px 12px',
                  borderLeft: `2px solid ${statusColor}`,
                  borderBottom: i < rocks.length - 1 ? `1px solid ${NAVY_BORDER}` : 'none',
                  minHeight: 44,
                }}>
                  <p style={{ margin: '0 0 4px', fontSize: 14, color: WHITE, fontWeight: 400, lineHeight: 1.4 }}>{r.rock_name}</p>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, color: statusColor, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.4 }}>{statusLabel}</span>
                    {r.owner && <span style={{ fontSize: 12, color: BEIGE, fontWeight: 300 }}>{r.owner}</span>}
                    {typeof r.percent_complete === 'number' && <span style={{ fontSize: 12, color: BEIGE, fontWeight: 300 }}>{r.percent_complete}%</span>}
                    {r.quarter && <span style={{ fontSize: 11, color: `${BEIGE}80`, fontWeight: 300 }}>{r.quarter}</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── FOLLOW-UPS OVERDUE ── */}
      <div className="briefing-section">
        <SectionHeading color={RED}>Follow-ups Overdue</SectionHeading>
        <p style={{
          margin: '10px 0 0', fontSize: 14, color: BEIGE, fontWeight: 300,
          fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif",
        }}>
          No overdue follow-ups. Click Refresh to check sent emails (no reply after 48h).
        </p>
      </div>

      {/* ── AI DAILY BRIEF ── */}
      <div className="briefing-section" style={{
        background: NAVY_LIGHT, border: `1px solid ${NAVY_BORDER}`, borderRadius: 8, padding: 20,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <SectionHeading>AI Daily Brief</SectionHeading>
          <button
            onClick={generateBrief}
            disabled={generating}
            style={{
              padding: '8px 18px', background: GOLD, color: NAVY,
              border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 500,
              cursor: generating ? 'not-allowed' : 'pointer',
              fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif",
              opacity: generating ? 0.7 : 1,
              minHeight: 44,
            }}
          >
            {generating ? 'Generating...' : 'Generate Brief'}
          </button>
        </div>
        {briefError && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', marginBottom: 12, background: 'rgba(192,57,43,0.1)', border: '1px solid rgba(192,57,43,0.3)', borderRadius: 8 }}>
            <span style={{ color: RED, fontSize: 15, lineHeight: 1 }}>&#9888;</span>
            <span style={{ fontSize: 13, color: BEIGE }}>Couldn&apos;t generate the brief ({briefError}). Showing the last saved brief, if any.</span>
          </div>
        )}
        {loading ? <Spinner /> : brief ? (
          <div style={{
            color: WHITE, fontSize: 15, lineHeight: 1.7, whiteSpace: 'pre-wrap',
            fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif",
            fontWeight: 300,
          }}>
            {brief.split('\n').map((line, i) => {
              // Bold section headings in the brief
              if (line.match(/^#+\s/) || line.match(/^\*\*[A-Z]/)) {
                const cleaned = line.replace(/^#+\s*/, '').replace(/\*\*/g, '')
                return <p key={i} style={{ margin: '16px 0 6px', fontSize: 14, fontWeight: 700, color: WHITE, fontFamily: "'Gujarati Sangam MN', 'DM Sans', serif", textTransform: 'uppercase', letterSpacing: '0.5px' }}>{cleaned}</p>
              }
              if (line.startsWith('* ') || line.startsWith('- ')) {
                return <p key={i} style={{ margin: '4px 0', paddingLeft: 12, color: BEIGE }}>{line.replace(/^[*-]\s/, '')}</p>
              }
              if (line.trim() === '') return <div key={i} style={{ height: 8 }} />
              return <p key={i} style={{ margin: '4px 0', color: BEIGE }}>{line}</p>
            })}
          </div>
        ) : (
          <div>
            <p style={{ color: BEIGE, fontSize: 14, margin: '0 0 8px', fontWeight: 300 }}>No brief generated yet for today.</p>
            <p style={{ color: `${BEIGE}80`, fontSize: 13, margin: 0, fontWeight: 300 }}>Click Generate Brief to create your morning briefing.</p>
          </div>
        )}
        {briefSnapshot && (
          <p style={{ color: `${BEIGE}99`, fontSize: 11, margin: '16px 0 0', fontWeight: 300, letterSpacing: 0.3 }} title="Counts at the moment the brief was generated">
            Brief built from:{' '}
            {[
              typeof briefSnapshot.q1Tasks === 'number' && `${briefSnapshot.q1Tasks} Q1`,
              typeof briefSnapshot.q2Tasks === 'number' && `${briefSnapshot.q2Tasks} Q2`,
              typeof briefSnapshot.q3Tasks === 'number' && `${briefSnapshot.q3Tasks} Q3`,
              typeof briefSnapshot.overdueTasks === 'number' && `${briefSnapshot.overdueTasks} overdue`,
              typeof briefSnapshot.followUps === 'number' && `${briefSnapshot.followUps} follow-ups`,
              typeof briefSnapshot.calendarEvents === 'number' && `${briefSnapshot.calendarEvents} events`,
              typeof briefSnapshot.openDeals === 'number' && briefSnapshot.openDeals > 0 && `${briefSnapshot.openDeals} deals`,
            ].filter(Boolean).join(' · ')}
          </p>
        )}
        {emails.length > 0 && (
          <p style={{ color: `${BEIGE}99`, fontSize: 11, margin: '6px 0 0', fontWeight: 300, letterSpacing: 0.3 }}>
            {emails.filter(e => e.ai_quadrant).length} of {emails.length} emails AI-classified · {emails.filter(e => !e.ai_quadrant).length} heuristic
          </p>
        )}
      </div>
    </div>
  )
}

// ─── SWIPEABLE EMAIL ROW (Outlook-style) ─────────────────────────────────────
function SwipeableEmailRow({ email, selected, onSelect, onArchive }: {
  email: Email; selected: boolean; onSelect: () => void; onArchive: () => void
}) {
  const [swipeX, setSwipeX] = useState(0)
  const [snap, setSnap]     = useState(false)
  const startX  = useRef(0)
  const startY  = useRef(0)
  const lastDx  = useRef(0)
  const isHoriz = useRef<boolean | null>(null)

  const q      = emailToQuadrant(email)
  const qCfg   = quadrantConfig[q]
  const letter = (email.from?.name || email.from?.address || '?')[0].toUpperCase()
  const COLORS  = ['#C0392B','#C19131','#C19131','#8b5cf6','#f59e0b','#06b6d4']
  const aColor  = COLORS[(email.from?.address?.charCodeAt(0) ?? 65) % COLORS.length]

  function handleTouchStart(e: React.TouchEvent) {
    startX.current  = e.touches[0].clientX
    startY.current  = e.touches[0].clientY
    lastDx.current  = 0
    isHoriz.current = null
    setSnap(false)
  }

  function handleTouchMove(e: React.TouchEvent) {
    const dx = e.touches[0].clientX - startX.current
    const dy = e.touches[0].clientY - startY.current
    if (isHoriz.current === null && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
      isHoriz.current = Math.abs(dx) > Math.abs(dy)
    }
    if (!isHoriz.current) return
    lastDx.current = dx
    setSwipeX(Math.max(-130, Math.min(60, dx)))
  }

  function handleTouchEnd() {
    setSnap(true)
    if (lastDx.current < -90) {
      setSwipeX(-500)
      setTimeout(() => { onArchive() }, 280)
    } else {
      setSwipeX(0)
    }
    isHoriz.current = null
  }

  return (
    <div style={{ position: 'relative', overflow: 'hidden', marginBottom: 1 }}>
      {/* Archive reveal — shown as row slides left */}
      <div style={{
        position: 'absolute', inset: 0, background: '#C0392B',
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 24,
        opacity: swipeX < -15 ? Math.min(1, (-swipeX - 15) / 50) : 0,
      }}>
        <span style={{ color: '#fff', fontSize: 13, fontWeight: 700 }}>Archive</span>
      </div>

      {/* Row */}
      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={() => { if (Math.abs(lastDx.current) < 8) onSelect() }}
        style={{
          background: selected ? '#3f5262' : '#374857',
          borderBottom: '1px solid rgba(217,210,190,0.1)',
          borderLeft: `3px solid ${qCfg.color}`,
          padding: '12px 14px',
          display: 'flex', gap: 12, alignItems: 'flex-start',
          cursor: 'pointer',
          transform: `translateX(${swipeX}px)`,
          transition: snap ? 'transform 0.26s cubic-bezier(0.4,0,0.2,1)' : 'none',
          willChange: 'transform',
          touchAction: 'pan-y',
          WebkitTapHighlightColor: 'transparent',
          userSelect: 'none',
        }}
      >
        {/* Avatar */}
        <div style={{ width: 40, height: 40, borderRadius: '50%', background: aColor, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 16, color: '#fff', flexShrink: 0, position: 'relative' }}>
          {letter}
          {!email.isRead && <span style={{ position: 'absolute', top: 0, right: 0, width: 10, height: 10, borderRadius: '50%', background: '#C19131', border: '2px solid #374857' }} />}
        </div>
        {/* Content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
            <span style={{ fontWeight: email.isRead ? 400 : 700, fontSize: 14, color: '#FFFFFF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, marginRight: 8 }}>
              {email.from?.name || email.from?.address || 'Unknown'}
            </span>
            <span style={{ color: '#D9D2BE', fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0 }}>{timeAgo(email.receivedDateTime)}</span>
          </div>
          <div style={{ fontSize: 13, color: email.isRead ? '#D9D2BE' : '#FFFFFF', fontWeight: email.isRead ? 400 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 3 }}>
            {email.subject}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#D9D2BE', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {email.ai_original_email_summary ? email.ai_original_email_summary.slice(0, 80) : email.bodyPreview?.slice(0, 80)}
            </span>
            <QuadrantBadge quadrant={q} />
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── EMAIL TAB ────────────────────────────────────────────────────────────────
function EmailTab({ emails, loading, onRefresh, vipCompanies, loadError }: { emails: Email[]; loading: boolean; onRefresh: () => void; vipCompanies: string[]; loadError?: boolean }) {
  const [selected, setSelected]       = useState<Email | null>(null)
  const [drafting, setDrafting]       = useState(false)
  const [draft, setDraft]             = useState('')
  const [filter, setFilter]           = useState<'all'|'q1'|'vip'|'tools'|'other'>('all')
  const [archived, setArchived]       = useState<Set<string>>(new Set())
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeTo, setComposeTo]     = useState('')
  const [composeSubj, setComposeSubj] = useState('')
  const [composeBody, setComposeBody] = useState('')
  const [sendConfirm, setSendConfirm] = useState(false)
  const [sending, setSending]         = useState(false)
  const [msToken, setMsToken]         = useState<string | null>(null)
  const [isMobile, setIsMobile]       = useState(false)
  const [toast, setToast]             = useState<{ id: string; label: string } | null>(null)
  const draftFnRef = useRef<(e: Email) => void>(() => {})
  // Pending archive timers keyed by email id. While a timer is live the row is
  // hidden optimistically but NOT yet deleted in Outlook — Undo cancels it.
  const archiveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const ARCHIVE_UNDO_MS = 5000

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  useEffect(() => { getMsToken().then(({ token }) => setMsToken(token)) }, [])

  useEffect(() => {
    function handleKey(ev: KeyboardEvent) {
      const tag = (ev.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (!selected) return
      if (ev.key === 'e' || ev.key === 'E') archiveEmail(selected.id)
      else if (ev.key === 'r' || ev.key === 'R') draftFnRef.current(selected)
      else if (ev.key === 'Escape') { setSelected(null); setDraft('') }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [selected])

  // Actually archive in Outlook once the undo window lapses. Until this runs the
  // email is only hidden locally — so "archive" finally means archive, with a way back.
  async function commitArchive(id: string) {
    archiveTimers.current.delete(id)
    setToast(t => (t?.id === id ? null : t))
    try {
      const res = await authFetch(`${SUPABASE_FUNCTIONS_URL}/delete-outlook-email`, {
        method: 'POST',
        body: JSON.stringify({ messageId: id }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (e) {
      console.error('Archive failed:', e)
      // Roll the row back into view and say so — never silently drop the email.
      setArchived(prev => { const s = new Set(prev); s.delete(id); return s })
      setToast({ id, label: 'Archive failed — email restored' })
      setTimeout(() => setToast(t => (t?.id === id ? null : t)), 4000)
    }
  }

  function archiveEmail(id: string) {
    setArchived(prev => { const s = new Set(prev); s.add(id); return s })
    if (selected?.id === id) { setSelected(null); setDraft('') }
    const existing = archiveTimers.current.get(id)
    if (existing) clearTimeout(existing)
    archiveTimers.current.set(id, setTimeout(() => commitArchive(id), ARCHIVE_UNDO_MS))
    setToast({ id, label: 'Email archived' })
  }

  function undoArchive(id: string) {
    const timer = archiveTimers.current.get(id)
    if (timer) { clearTimeout(timer); archiveTimers.current.delete(id) }
    setArchived(prev => { const s = new Set(prev); s.delete(id); return s })
    setToast(null)
  }

  // On unmount, flush any pending archives straight to Outlook (no state updates).
  useEffect(() => {
    const timers = archiveTimers.current
    return () => {
      timers.forEach((timer, id) => {
        clearTimeout(timer)
        authFetch(`${SUPABASE_FUNCTIONS_URL}/delete-outlook-email`, {
          method: 'POST', body: JSON.stringify({ messageId: id }),
        }).catch(() => {})
      })
    }
  }, [])

  async function draftReply(email: Email) {
    setDrafting(true); setDraft('')
    try {
      const res = await authFetch(`${SUPABASE_FUNCTIONS_URL}/draft-reply`, {
        method: 'POST',
        body: JSON.stringify({ email_id: email.id, subject: email.subject, from_name: email.from.name, from_email: email.from.address, body_preview: email.bodyPreview }),
      })
      const data = await res.json()
      setDraft(data.draft || data.body_text || 'Could not generate draft.')
    } catch { setDraft('Error generating draft.') }
    setDrafting(false)
  }
  draftFnRef.current = draftReply

  async function sendEmail() {
    if (!msToken) { alert('No Microsoft token — please reconnect.'); return }
    setSending(true)
    const toAddr = selected ? (selected.from?.address || '') : composeTo
    const subj   = selected ? `Re: ${selected.subject}` : composeSubj
    const body   = draft || composeBody
    try {
      await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
        method: 'POST',
        headers: { Authorization: `Bearer ${msToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { subject: subj, body: { contentType: 'Text', content: body }, toRecipients: [{ emailAddress: { address: toAddr } }] } }),
      })
      setSendConfirm(false); setDraft('')
      setComposeOpen(false); setComposeTo(''); setComposeSubj(''); setComposeBody('')
    } catch { alert('Failed to send. Please try again.') }
    setSending(false)
  }

  const visible = emails.filter(e => {
    if (archived.has(e.id)) return false
    if (filter === 'all')   return true
    if (filter === 'q1')    return emailToQuadrant(e) === 'do'
    if (filter === 'vip')   return emailCategory(e, vipCompanies) === 'vip'
    if (filter === 'tools') return emailCategory(e, vipCompanies) === 'tools'
    if (filter === 'other') return emailCategory(e, vipCompanies) === 'other'
    return true
  })

  const counts = {
    all:   emails.filter(e => !archived.has(e.id)).length,
    q1:    emails.filter(e => !archived.has(e.id) && emailToQuadrant(e) === 'do').length,
    vip:   emails.filter(e => !archived.has(e.id) && emailCategory(e, vipCompanies) === 'vip').length,
    tools: emails.filter(e => !archived.has(e.id) && emailCategory(e, vipCompanies) === 'tools').length,
    other: emails.filter(e => !archived.has(e.id) && emailCategory(e, vipCompanies) === 'other').length,
  }

  const pc = (p?: string) => p === 'high' ? '#C0392B' : p === 'medium' ? '#C19131' : '#D9D2BE'

  // Shared detail body — called as a function (not JSX component) to avoid remount
  function renderDetail(email: Email) {
    const COLORS = ['#C0392B','#C19131','#C19131','#8b5cf6','#f59e0b','#06b6d4']
    const aColor = COLORS[(email.from?.address?.charCodeAt(0) ?? 65) % COLORS.length]
    const letter = (email.from?.name || email.from?.address || '?')[0].toUpperCase()
    return (
      <>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 16 }}>
          <div style={{ width: 44, height: 44, borderRadius: '50%', background: aColor, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 18, color: '#fff', flexShrink: 0 }}>
            {letter}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: '0 0 2px', fontSize: 14, fontWeight: 600, color: '#FFFFFF' }}>{email.from?.name || 'Unknown'}</p>
            <p style={{ margin: '0 0 2px', fontSize: 12, color: '#D9D2BE' }}>{email.from?.address}</p>
            <p style={{ margin: 0, fontSize: 11, color: 'rgba(217,210,190,0.4)' }}>
              {new Date(email.receivedDateTime).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
        </div>
        <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 600, color: '#FFFFFF', lineHeight: 1.4 }}>{email.subject}</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid rgba(217,210,190,0.15)' }}>
          <QuadrantBadge quadrant={emailToQuadrant(email)} />
          {email.ai_category && <Badge text={email.ai_category} color="#C19131" />}
          {email.ai_priority_level && <Badge text={email.ai_priority_level} color={pc(email.ai_priority_level)} />}
        </div>
        {email.ai_original_email_summary && (
          <div style={{ background: 'rgba(193,145,49,0.06)', border: '1px solid rgba(193,145,49,0.15)', borderRadius: 8, padding: '10px 12px', marginBottom: 16 }}>
            <p style={{ margin: '0 0 4px', fontSize: 11, fontWeight: 600, color: '#C19131', textTransform: 'uppercase', letterSpacing: '0.5px' }}>AI Summary</p>
            <p style={{ margin: 0, fontSize: 13, color: '#D9D2BE', lineHeight: 1.6 }}>{email.ai_original_email_summary}</p>
          </div>
        )}
        <p style={{ fontSize: 13, color: '#D9D2BE', lineHeight: 1.75, marginBottom: 16 }}>{email.bodyPreview}</p>
        {draft && (
          <div style={{ background: '#3f5262', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 8, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <p style={{ margin: 0, fontSize: 11, fontWeight: 600, color: '#C19131', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Draft Reply</p>
              <button onClick={() => setSendConfirm(true)} style={{ padding: '5px 12px', background: '#C19131', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>Send</button>
            </div>
            <textarea value={draft} onChange={e => setDraft(e.target.value)} style={{ width: '100%', minHeight: 130, background: 'transparent', border: 'none', color: '#D9D2BE', fontSize: 13, lineHeight: 1.6, resize: 'vertical', outline: 'none', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }} />
          </div>
        )}
      </>
    )
  }

  const filterBar = (
    <div style={{ display: 'flex', gap: 2, overflowX: 'auto', scrollbarWidth: 'none', paddingBottom: 2, touchAction: 'pan-x' }}>
      {(['all', 'q1', 'vip', 'tools', 'other'] as const).map(key => {
        const labels = { all: 'All', q1: 'Urgent', vip: 'VIP', tools: 'Tools', other: 'Other' }
        return (
          <button key={key} onClick={() => setFilter(key)} style={{ padding: '5px 12px', borderRadius: 20, border: 'none', fontSize: 12, background: filter === key ? 'rgba(193,145,49,0.15)' : 'transparent', color: filter === key ? '#C19131' : '#D9D2BE', fontWeight: filter === key ? 600 : 400, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif", whiteSpace: 'nowrap', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}>
            {labels[key]} <span style={{ opacity: 0.6 }}>({counts[key]})</span>
          </button>
        )
      })}
    </div>
  )

  return (
    <div style={{ position: 'relative' }}>
      <div className={selected && !isMobile ? 'email-grid email-grid--split' : 'email-grid'} style={{ gap: 16, alignItems: 'start' }}>

        {/* ── List column ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            {filterBar}
            {!isMobile && (
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button onClick={onRefresh} style={{ padding: '6px 12px', background: 'transparent', color: '#D9D2BE', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 8, fontSize: 12, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>Refresh</button>
                <button onClick={() => setComposeOpen(true)} style={{ padding: '6px 14px', background: 'rgba(193,145,49,0.12)', color: '#C19131', border: '1px solid rgba(193,145,49,0.3)', borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>+ Compose</button>
              </div>
            )}
          </div>

          {!isMobile && (
            <div style={{ fontSize: 11, color: 'rgba(217,210,190,0.4)', paddingLeft: 2 }}>
              Shortcuts:&nbsp;
              <kbd style={{ background: '#3f5262', padding: '1px 5px', borderRadius: 3, fontSize: 10, color: '#D9D2BE' }}>E</kbd> archive&nbsp;&nbsp;
              <kbd style={{ background: '#3f5262', padding: '1px 5px', borderRadius: 3, fontSize: 10, color: '#D9D2BE' }}>R</kbd> reply&nbsp;&nbsp;
              <kbd style={{ background: '#3f5262', padding: '1px 5px', borderRadius: 3, fontSize: 10, color: '#D9D2BE' }}>Esc</kbd> close
            </div>
          )}

          {isMobile && (
            <p style={{ margin: 0, fontSize: 11, color: 'rgba(217,210,190,0.4)', paddingLeft: 2 }}>Swipe left to archive</p>
          )}

          {loading ? <Spinner /> : visible.length === 0 ? (
            <Card><p style={{ color: loadError ? '#C0392B' : '#D9D2BE', margin: 0, fontSize: 13 }}>{loadError ? "Couldn't load your inbox — tap Retry at the top." : 'No emails in this view.'}</p></Card>
          ) : (
            <div style={{ touchAction: 'pan-y' }}>
              {visible.map(email => (
                <SwipeableEmailRow
                  key={email.id}
                  email={email}
                  selected={selected?.id === email.id}
                  onSelect={() => { setSelected(selected?.id === email.id ? null : email); setDraft('') }}
                  onArchive={() => archiveEmail(email.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Desktop detail panel ── */}
        {selected && !isMobile && (
          <Card style={{ position: 'sticky', top: 72, alignSelf: 'start', maxHeight: 'calc(100vh - 96px)', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
              <button onClick={() => { setSelected(null); setDraft('') }} style={{ background: 'none', border: 'none', color: '#D9D2BE', cursor: 'pointer', fontSize: 20 }}>&#x2715;</button>
            </div>
            {renderDetail(selected)}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={() => draftReply(selected)} disabled={drafting} style={{ flex: 1, padding: '9px 14px', background: 'rgba(193,145,49,0.12)', color: '#C19131', border: '1px solid rgba(193,145,49,0.3)', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: drafting ? 'not-allowed' : 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>
                {drafting ? 'Drafting...' : 'Draft AI Reply'}
              </button>
              <button onClick={() => archiveEmail(selected.id)} style={{ padding: '9px 14px', background: 'transparent', color: '#D9D2BE', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 8, fontSize: 13, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>Archive</button>
            </div>
          </Card>
        )}
      </div>

      {/* ── Mobile: full-screen detail (Outlook-style slide from right) ── */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 300,
        background: '#2E3D49',
        transform: (selected && isMobile) ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.3s cubic-bezier(0.4,0,0.2,1)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        touchAction: 'pan-y',
        pointerEvents: (selected && isMobile) ? 'auto' : 'none',
      }}>
        {/* Nav header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 56, padding: '0 16px', background: '#374857', borderBottom: '1px solid rgba(217,210,190,0.15)', flexShrink: 0 }}>
          <button
            onClick={() => { setSelected(null); setDraft('') }}
            style={{ background: 'none', border: 'none', color: '#C19131', fontSize: 17, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif", display: 'flex', alignItems: 'center', gap: 4, padding: '8px 0', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
          >
            ‹ Inbox
          </button>
          {selected && (
            <button
              onClick={() => archiveEmail(selected.id)}
              style={{ background: 'none', border: 'none', color: '#D9D2BE', fontSize: 13, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif", padding: '8px 0', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
            >
              Archive
            </button>
          )}
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflow: 'auto', padding: '20px 16px 140px', WebkitOverflowScrolling: 'touch' }}>
          {selected && renderDetail(selected)}
        </div>

        {/* Bottom action bar */}
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '12px 16px', paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))', background: '#374857', borderTop: '1px solid rgba(217,210,190,0.15)', display: 'flex', gap: 12 }}>
          <button
            onClick={() => selected && draftReply(selected)}
            disabled={drafting}
            style={{ flex: 1, padding: '13px 16px', background: '#C19131', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 600, cursor: drafting ? 'not-allowed' : 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif", touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
          >
            {drafting ? 'Drafting...' : '✦ AI Reply'}
          </button>
          <button
            onClick={() => setSendConfirm(true)}
            disabled={!draft}
            style={{ padding: '13px 18px', background: draft ? 'rgba(193,145,49,0.12)' : 'transparent', color: draft ? '#C19131' : 'rgba(217,210,190,0.4)', border: `1px solid ${draft ? 'rgba(193,145,49,0.3)' : 'rgba(217,210,190,0.15)'}`, borderRadius: 10, fontSize: 15, cursor: draft ? 'pointer' : 'default', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif", touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
          >
            Send
          </button>
        </div>
      </div>

      {/* ── FAB — compose (mobile only) ── */}
      {isMobile && !selected && (
        <button
          onClick={() => setComposeOpen(true)}
          style={{
            position: 'fixed', right: 20,
            bottom: 'calc(72px + env(safe-area-inset-bottom, 0px))',
            width: 56, height: 56, borderRadius: '50%',
            background: '#C19131',
            color: '#fff', border: 'none', fontSize: 30,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 20px rgba(193,145,49,0.45)',
            cursor: 'pointer', zIndex: 150,
            touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent',
          }}
        >+</button>
      )}

      {/* Compose modal */}
      {composeOpen && (
        <Modal title="New Email" onClose={() => setComposeOpen(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input value={composeTo} onChange={e => setComposeTo(e.target.value)} placeholder="To: email@example.com" style={inputStyle} />
            <input value={composeSubj} onChange={e => setComposeSubj(e.target.value)} placeholder="Subject" style={inputStyle} />
            <textarea value={composeBody} onChange={e => setComposeBody(e.target.value)} placeholder="Write your message..." rows={8} style={{ ...inputStyle, resize: 'vertical', minHeight: 160 }} />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setComposeOpen(false)} style={secondaryBtnStyle}>Cancel</button>
              <button onClick={() => { setDraft(composeBody); setSendConfirm(true) }} disabled={!composeTo || !composeSubj || !composeBody} style={{ ...primaryBtnStyle, opacity: (!composeTo || !composeSubj || !composeBody) ? 0.5 : 1 }}>Review &amp; Send</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Send confirmation */}
      {sendConfirm && (
        <Modal title="Confirm Send" onClose={() => setSendConfirm(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ background: '#2E3D49', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 8, padding: 14 }}>
              <p style={{ margin: '0 0 6px', fontSize: 12, color: '#D9D2BE' }}>To: <strong style={{ color: '#FFFFFF' }}>{selected ? (selected.from?.address || '') : composeTo}</strong></p>
              <p style={{ margin: '0 0 10px', fontSize: 12, color: '#D9D2BE' }}>Subject: <strong style={{ color: '#FFFFFF' }}>{selected ? `Re: ${selected.subject}` : composeSubj}</strong></p>
              <p style={{ margin: 0, fontSize: 13, color: '#D9D2BE', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{(draft || composeBody).slice(0, 300)}{(draft || composeBody).length > 300 ? '...' : ''}</p>
            </div>
            <p style={{ margin: 0, fontSize: 12, color: '#C19131' }}>This will send immediately. Please review before confirming.</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setSendConfirm(false)} style={secondaryBtnStyle}>Cancel</button>
              <button onClick={sendEmail} disabled={sending} style={{ ...primaryBtnStyle, opacity: sending ? 0.7 : 1 }}>{sending ? 'Sending...' : 'Send Now'}</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Undo toast for archive — depth via colour + border, no shadow */}
      {toast && (
        <div role="status" style={{
          position: 'fixed', left: '50%', transform: 'translateX(-50%)',
          bottom: 'calc(76px + env(safe-area-inset-bottom, 0px))', zIndex: 400,
          display: 'flex', alignItems: 'center', gap: 16,
          padding: '10px 16px', maxWidth: 'calc(100vw - 32px)',
          background: '#3f5262', border: `1px solid ${NAVY_BORDER}`, borderRadius: 10,
        }}>
          <span style={{ fontSize: 13, color: WHITE, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>{toast.label}</span>
          {archiveTimers.current.has(toast.id) && (
            <button onClick={() => undoArchive(toast.id)} style={{ background: 'none', border: 'none', color: GOLD, fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>Undo</button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── MATRIX TAB ───────────────────────────────────────────────────────────────
function MatrixTab({ tasks, onRefresh }: { tasks: EisenhowerTask[]; onRefresh: () => void }) {
  type QKey = 'do' | 'schedule' | 'delegate' | 'eliminate'

  // ── Form state ────────────────────────────────────────────────────────────
  const [addOpen, setAddOpen]           = useState(false)
  const [editTask, setEditTask]         = useState<EisenhowerTask | null>(null)
  const [taskTitle, setTaskTitle]       = useState('')
  const [taskQuadrant, setTaskQuadrant] = useState<QKey>('do')
  const [taskClient, setTaskClient]     = useState('')
  const [taskDue, setTaskDue]           = useState('')
  const [taskMins, setTaskMins]               = useState('')
  const [taskDescription, setTaskDescription] = useState('')
  const [saving, setSaving]                   = useState(false)

  // ── Action state ──────────────────────────────────────────────────────────
  const [completing, setCompleting]     = useState<string | null>(null)
  const [deleting, setDeleting]         = useState<string | null>(null)
  const [detailTask, setDetailTask]     = useState<EisenhowerTask | null>(null)

  // ── Completed tasks ───────────────────────────────────────────────────────
  const [showDone, setShowDone]         = useState(false)
  const [doneTasks, setDoneTasks]       = useState<EisenhowerTask[]>([])
  const [loadingDone, setLoadingDone]   = useState(false)

  // ── Drag & drop ───────────────────────────────────────────────────────────
  const [dragId, setDragId]             = useState<string | null>(null)
  const [dragOver, setDragOver]         = useState<QKey | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [merging, setMerging]           = useState(false)
  // Ref so event handlers always see the current drag ID synchronously
  // (React state updates are async; dragover fires before the re-render)
  const dragIdRef                       = useRef<string | null>(null)

  // ── Helpers ─────────────────────��─────────────────────────────────────────
  const qLabel = (q: QKey) => q === 'do' ? 'Q1' : q === 'schedule' ? 'Q2' : q === 'delegate' ? 'Q3' : 'Q4'
  const fmtDue = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', month: 'short', day: 'numeric' })

  function resetForm() {
    setTaskTitle(''); setTaskQuadrant('do'); setTaskClient('')
    setTaskDue(''); setTaskMins(''); setTaskDescription('')
  }

  function openEdit(t: EisenhowerTask) {
    setTaskTitle(t.title); setTaskQuadrant(t.quadrant)
    setTaskClient(t.client_name || ''); setTaskDue(t.due_date || '')
    setTaskMins(t.estimated_minutes ? String(t.estimated_minutes) : '')
    setTaskDescription(t.description || ''); setEditTask(t)
  }

  // ── API ───────────────────────────────────────────────────────────────────
  async function createTask() {
    if (!taskTitle.trim()) return
    setSaving(true)
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/eisenhower_tasks`, {
        method: 'POST',
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          title: taskTitle.trim(), quadrant: taskQuadrant,
          client_name: taskClient || null, due_date: taskDue || null,
          estimated_minutes: taskMins ? parseInt(taskMins) : null,
          description: taskDescription || null, status: 'open',
        }),
      })
      setAddOpen(false); resetForm(); onRefresh()
    } catch { alert('Failed to create task.') }
    setSaving(false)
  }

  async function saveEdit() {
    if (!editTask || !taskTitle.trim()) return
    setSaving(true)
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/eisenhower_tasks?id=eq.${editTask.id}`, {
        method: 'PATCH',
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          title: taskTitle.trim(), quadrant: taskQuadrant,
          client_name: taskClient || null, due_date: taskDue || null,
          estimated_minutes: taskMins ? parseInt(taskMins) : null,
          description: taskDescription || null,
        }),
      })
      setEditTask(null); resetForm(); onRefresh()
    } catch { alert('Failed to update task.') }
    setSaving(false)
  }

  async function completeTask(id: string) {
    setCompleting(id)
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/eisenhower_tasks?id=eq.${id}`, {
        method: 'PATCH',
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'done' }),
      })
      onRefresh()
      if (showDone) loadDone()
    } catch { alert('Failed to complete task.') }
    setCompleting(null)
  }

  async function deleteTask(id: string) {
    setDeleting(id)
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/eisenhower_tasks?id=eq.${id}`, {
        method: 'DELETE',
        headers: { apikey: ANON_KEY },
      })
      onRefresh()
      if (showDone) loadDone()
    } catch { alert('Failed to delete task.') }
    setDeleting(null)
  }

  async function moveTask(id: string, quadrant: QKey) {
    try {
      // Manual moves are recorded as overrides so the back-of-house cron and
      // future re-classification passes don't blow them away. ai_suggested_quadrant
      // is preserved separately and displayed on the card so Richard can see what
      // the AI originally thought.
      const task = tasks.find(t => t.id === id)
      const isManual = !task || task.quadrant !== quadrant
      const patchBody: Record<string, unknown> = { quadrant }
      if (isManual) patchBody.quadrant_override = true
      // First time we override, capture the original AI suggestion if not already set.
      if (isManual && task && !task.ai_suggested_quadrant) {
        patchBody.ai_suggested_quadrant = task.quadrant
      }
      await fetch(`${SUPABASE_URL}/rest/v1/eisenhower_tasks?id=eq.${id}`, {
        method: 'PATCH',
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(patchBody),
      })
      onRefresh()
    } catch { alert('Failed to move task.') }
  }

  async function mergeTask(targetId: string, sourceId: string) {
    if (targetId === sourceId || merging) return
    setMerging(true)
    try {
      const target = tasks.find(t => t.id === targetId)
      const source = tasks.find(t => t.id === sourceId)
      if (!target || !source) return

      // Combine descriptions: keep target title, append source as a bullet
      const parts = [
        target.description,
        `• ${source.title}`,
        source.description,
      ].filter(Boolean)
      const mergedDescription = parts.join('\n') || null

      // Union source_email_ids, deduplicating with a Set
      const mergedIds = Array.from(new Set([
        ...(target.source_email_ids || []),
        ...(source.source_email_ids || []),
      ]))

      await fetch(`${SUPABASE_URL}/rest/v1/eisenhower_tasks?id=eq.${targetId}`, {
        method: 'PATCH',
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          description: mergedDescription,
          source_email_ids: mergedIds.length > 0 ? mergedIds : null,
        }),
      })
      await fetch(`${SUPABASE_URL}/rest/v1/eisenhower_tasks?id=eq.${sourceId}`, {
        method: 'DELETE',
        headers: { apikey: ANON_KEY },
      })
      onRefresh()
    } catch { alert('Failed to merge tasks.') }
    setMerging(false)
    setDropTargetId(null)
  }

  async function loadDone() {
    setLoadingDone(true)
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/eisenhower_tasks?select=*&status=eq.done&order=updated_at.desc&limit=30`,
        { headers: { apikey: ANON_KEY } }
      )
      const data = await res.json()
      if (Array.isArray(data)) setDoneTasks(data)
    } catch { /* swallow */ }
    setLoadingDone(false)
  }

  // ── Drag handlers ─────────────────────────────────────────────────────────
  function onDragStart(e: React.DragEvent, id: string) {
    dragIdRef.current = id
    setDragId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
  function onDragOver(e: React.DragEvent, q: QKey) {
    e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(q)
  }
  function onDrop(e: React.DragEvent, q: QKey) {
    e.preventDefault()
    const id = dragIdRef.current || e.dataTransfer.getData('text/plain')
    if (id) moveTask(id, q)
    dragIdRef.current = null
    setDragId(null); setDragOver(null)
  }

  const quadrants = ['do', 'schedule', 'delegate', 'eliminate'] as const
  const q1Count   = tasks.filter(t => t.quadrant === 'do').length

  // ── Shared task form JSX ──────────────────────────────────────────────────
  const taskForm = (isEdit: boolean) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <input value={taskTitle} onChange={e => setTaskTitle(e.target.value)} placeholder="Task title *" style={inputStyle} autoFocus />
      <select value={taskQuadrant} onChange={e => setTaskQuadrant(e.target.value as QKey)} style={{ ...inputStyle, cursor: 'pointer' }}>
        <option value="do">Q1 — Do First (urgent + important)</option>
        <option value="schedule">Q2 — Schedule (important, not urgent)</option>
        <option value="delegate">Q3 — Delegate (urgent, not important)</option>
        <option value="eliminate">Q4 — Eliminate (not urgent, not important)</option>
      </select>
      <input value={taskClient} onChange={e => setTaskClient(e.target.value)} placeholder="Client name (optional)" style={inputStyle} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <input type="date" value={taskDue} onChange={e => setTaskDue(e.target.value)} style={inputStyle} />
        <input type="number" value={taskMins} onChange={e => setTaskMins(e.target.value)} placeholder="Est. minutes" min={1} style={inputStyle} />
      </div>
      <textarea value={taskDescription} onChange={e => setTaskDescription(e.target.value)} placeholder="Description (optional)" rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button onClick={() => { isEdit ? setEditTask(null) : setAddOpen(false); resetForm() }} style={secondaryBtnStyle}>Cancel</button>
        <button onClick={isEdit ? saveEdit : createTask} disabled={!taskTitle.trim() || saving} style={{ ...primaryBtnStyle, opacity: !taskTitle.trim() || saving ? 0.5 : 1 }}>
          {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Task'}
        </button>
      </div>
    </div>
  )

  return (
    <div>

      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#FFFFFF' }}>Eisenhower Matrix</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={e => { e.stopPropagation(); const next = !showDone; setShowDone(next); if (next) loadDone() }}
            style={{ padding: '7px 12px', background: showDone ? 'rgba(193,145,49,0.1)' : 'transparent', color: showDone ? '#C19131' : '#D9D2BE', border: `1px solid ${showDone ? 'rgba(193,145,49,0.3)' : 'rgba(217,210,190,0.15)'}`, borderRadius: 8, fontSize: 12, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}
          >&#10003; Done</button>
          <button onClick={e => { e.stopPropagation(); setAddOpen(true) }} style={{ padding: '7px 14px', background: 'rgba(193,145,49,0.12)', color: '#C19131', border: '1px solid rgba(193,145,49,0.3)', borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>+ Add Task</button>
        </div>
      </div>

      {q1Count > 8 && (
        <div style={{ background: 'rgba(192,57,43,0.08)', border: '1px solid rgba(192,57,43,0.25)', borderRadius: 10, padding: '10px 16px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 16 }}>&#9888;</span>
          <span style={{ fontSize: 13, color: '#C0392B', fontWeight: 500 }}>Q1 overload: {q1Count} urgent tasks. Consider delegating or rescheduling.</span>
        </div>
      )}

      {/* ── 2×2 Matrix ── */}
      <div className="r-grid-2" style={{ gap: 12 }}>
        {quadrants.map(q => {
          const cfg    = quadrantConfig[q]
          const qTasks = tasks.filter(t => t.quadrant === q)
          const isOver = dragOver === q
          return (
            <div
              key={q}
              onDragOver={e => { onDragOver(e, q); setDropTargetId(null) }}
              onDragLeave={() => setDragOver(null)}
              onDrop={e => { onDrop(e, q); setDropTargetId(null) }}
              style={{ background: isOver ? cfg.color + '22' : cfg.bg, border: `1px solid ${isOver ? cfg.color : cfg.border}`, borderRadius: 12, padding: 16, minHeight: 160, transition: 'border-color 0.12s, background 0.12s' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: cfg.color }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: cfg.color, textTransform: 'uppercase', letterSpacing: '0.6px' }}>{cfg.label}</span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: '#D9D2BE' }}>{qTasks.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {qTasks.length === 0
                  ? <p style={{ color: isOver ? cfg.color : 'rgba(217,210,190,0.4)', fontSize: 12, margin: 0, textAlign: 'center', padding: '12px 0', opacity: isOver ? 1 : 0.6 }}>{isOver ? '↓ Drop here' : 'No tasks'}</p>
                  : qTasks.map(t => {
                    const isDragging   = dragId === t.id
                    const isDropTarget = dropTargetId === t.id && dragId !== null && dragId !== t.id
                    return (
                      <div
                        key={t.id}
                        draggable
                        onDragStart={e => { e.stopPropagation(); onDragStart(e, t.id) }}
                        onDragEnd={() => { dragIdRef.current = null; setDragId(null); setDragOver(null); setDropTargetId(null) }}
                        onDragOver={e => {
                          const srcId = dragIdRef.current
                          if (srcId && srcId !== t.id) {
                            e.preventDefault(); e.stopPropagation()
                            e.dataTransfer.dropEffect = 'move'
                            if (dropTargetId !== t.id) setDropTargetId(t.id)
                            if (dragOver !== null) setDragOver(null)
                          }
                        }}
                        onDragLeave={e => {
                          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTargetId(null)
                        }}
                        onDrop={e => {
                          e.preventDefault(); e.stopPropagation()
                          const srcId = dragIdRef.current || e.dataTransfer.getData('text/plain')
                          if (srcId && srcId !== t.id) mergeTask(t.id, srcId)
                          dragIdRef.current = null
                          setDragId(null); setDragOver(null); setDropTargetId(null)
                        }}
                        onClick={e => { e.stopPropagation(); if (!dragIdRef.current) setDetailTask(t) }}
                        style={{
                          background: isDropTarget ? cfg.color + '12' : '#374857',
                          borderBottom: '1px solid rgba(217,210,190,0.1)',
                          borderLeft: `3px solid ${cfg.color}`,
                          borderTop: 'none', borderRight: 'none',
                          outline: isDropTarget ? `2px dashed ${cfg.color}` : 'none',
                          outlineOffset: -2,
                          borderRadius: 8, padding: '11px 14px',
                          opacity: isDragging ? 0.35 : 1,
                          cursor: 'pointer', userSelect: 'none',
                          transition: 'background 0.1s',
                        }}
                      >
                        {isDropTarget && (
                          <div style={{ fontSize: 11, color: cfg.color, marginBottom: 4, fontWeight: 600 }}>⊕ Drop to combine</div>
                        )}
                        <p style={{ margin: '0 0 4px', fontSize: 13, color: '#FFFFFF', fontWeight: q === 'do' ? 600 : 400, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</p>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          {t.client_name && <span style={{ fontSize: 11, color: '#C19131', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.client_name}</span>}
                          {t.due_date && <span style={{ fontSize: 11, color: '#D9D2BE' }}>{fmtDue(t.due_date)}</span>}
                          {t.estimated_minutes && <span style={{ fontSize: 11, color: '#D9D2BE' }}>{t.estimated_minutes}m</span>}
                          {t.quadrant_override && t.ai_suggested_quadrant && t.ai_suggested_quadrant !== t.quadrant && (
                            <span title={`AI originally suggested Q${({ do: 1, schedule: 2, delegate: 3, eliminate: 4 } as const)[t.ai_suggested_quadrant]} (${t.ai_suggested_quadrant})`} style={{ fontSize: 10, color: '#D9D2BE', background: 'rgba(217,210,190,0.08)', border: '1px solid rgba(217,210,190,0.2)', borderRadius: 4, padding: '1px 6px', letterSpacing: 0.3 }}>↻ override</span>
                          )}
                        </div>
                      </div>
                    )
                  })}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Completed section ── */}
      {showDone && (
        <div style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#C19131' }}>Completed</h4>
            <button onClick={loadDone} style={{ background: 'transparent', border: 'none', color: '#D9D2BE', fontSize: 12, cursor: 'pointer', padding: '2px 6px' }}>&#x21BB; Refresh</button>
          </div>
          {loadingDone
            ? <p style={{ color: '#D9D2BE', fontSize: 13 }}>Loading…</p>
            : doneTasks.length === 0
              ? <p style={{ color: 'rgba(217,210,190,0.4)', fontSize: 13 }}>No completed tasks yet.</p>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {doneTasks.map(t => (
                    <div key={t.id} style={{ background: '#374857', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 8, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, opacity: 0.65 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#C19131', flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 13, color: '#D9D2BE', textDecoration: 'line-through' }}>{t.title}</span>
                        {t.client_name && <span style={{ fontSize: 11, color: '#C19131', marginLeft: 8 }}>{t.client_name}</span>}
                        {t.due_date && <span style={{ fontSize: 11, color: '#4b5563', marginLeft: 8 }}>{fmtDue(t.due_date)}</span>}
                      </div>
                      <button onClick={() => deleteTask(t.id)} disabled={deleting === t.id}
                        style={{ background: 'transparent', border: 'none', color: '#D9D2BE', cursor: 'pointer', fontSize: 14, padding: '2px 6px', flexShrink: 0, opacity: deleting === t.id ? 0.4 : 1 }}
                        title="Delete">&#x2715;</button>
                    </div>
                  ))}
                </div>
              )
          }
        </div>
      )}

      {/* ── Add Task modal ── */}
      {addOpen && (
        <Modal title="Add Task" onClose={() => { setAddOpen(false); resetForm() }}>
          {taskForm(false)}
        </Modal>
      )}

      {/* ── Edit Task modal ── */}
      {editTask && (
        <Modal title="Edit Task" onClose={() => { setEditTask(null); resetForm() }}>
          {taskForm(true)}
        </Modal>
      )}

      {/* ── Task Detail modal ── */}
      {detailTask && (() => {
        const t   = detailTask
        const cfg = quadrantConfig[t.quadrant]
        const qFullLabel = t.quadrant === 'do' ? 'Q1 · Do First' : t.quadrant === 'schedule' ? 'Q2 · Schedule' : t.quadrant === 'delegate' ? 'Q3 · Delegate' : 'Q4 · Eliminate'
        const statusColors: Record<string, string> = { open: '#C19131', in_progress: '#C19131', waiting: '#D9D2BE', done: '#C19131', cancelled: '#C0392B' }
        const statusColor = statusColors[t.status] || '#D9D2BE'
        const MetaRow = ({ label, value }: { label: string; value: React.ReactNode }) => (
          <div style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid rgba(217,210,190,0.1)' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#D9D2BE', textTransform: 'uppercase', letterSpacing: '0.5px', minWidth: 100, paddingTop: 1 }}>{label}</span>
            <span style={{ fontSize: 13, color: '#D9D2BE', flex: 1 }}>{value}</span>
          </div>
        )
        return (
          <Modal title="" onClose={() => setDetailTask(null)}>

            {/* ── A: Header with coloured left accent ── */}
            <div style={{ borderLeft: `3px solid ${cfg.color}`, paddingLeft: 14, marginBottom: 20 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 4, background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}` }}>{qFullLabel}</span>
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: `${statusColor}18`, color: statusColor, fontWeight: 600, textTransform: 'capitalize' }}>{t.status.replace('_', ' ')}</span>
              </div>
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: '#FFFFFF', lineHeight: 1.35 }}>{t.title}</h2>
            </div>

            {/* ── B: Description ── */}
            {t.description && (
              <div style={{ background: '#2E3D49', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
                <p style={{ margin: 0, fontSize: 13, color: '#D9D2BE', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{t.description}</p>
              </div>
            )}

            {/* ── C: Meta rows ── */}
            {(t.client_name || t.due_date || t.estimated_minutes || t.priority_score != null || t.delegated_to || t.delegation_channel || t.source_type || (t.tags && t.tags.length > 0) || t.created_at) && (
              <div style={{ marginBottom: 16 }}>
                {t.client_name         && <MetaRow label="Client"       value={<span style={{ color: '#C19131' }}>{t.client_name}</span>} />}
                {t.due_date            && <MetaRow label="Due"           value={new Date(t.due_date + (t.due_date.includes('T') ? '' : 'T00:00:00')).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} />}
                {t.estimated_minutes   && <MetaRow label="Estimate"      value={`${t.estimated_minutes} min`} />}
                {t.priority_score != null && <MetaRow label="Priority"   value={String(t.priority_score)} />}
                {t.delegated_to        && <MetaRow label="Delegated to"  value={t.delegated_to} />}
                {t.delegation_channel  && <MetaRow label="Via"           value={t.delegation_channel} />}
                {t.source_type         && <MetaRow label="Source"        value={t.source_type} />}
                {t.tags && t.tags.length > 0 && (
                  <MetaRow label="Tags" value={
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {t.tags.map(tag => <span key={tag} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(193,145,49,0.12)', color: '#C19131', border: '1px solid rgba(193,145,49,0.25)' }}>{tag}</span>)}
                    </div>
                  } />
                )}
                {t.created_at && <MetaRow label="Created" value={new Date(t.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })} />}
              </div>
            )}

            {/* ── D: Move to ── */}
            {t.status !== 'done' && (
              <div style={{ marginBottom: 20 }}>
                <p style={{ margin: '0 0 8px', fontSize: 11, fontWeight: 600, color: '#D9D2BE', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Move to</p>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {quadrants.filter(qk => qk !== t.quadrant).map(qk => {
                    const qc = quadrantConfig[qk]
                    return (
                      <button key={qk} onClick={() => { moveTask(t.id, qk); setDetailTask(null) }}
                        style={{ padding: '6px 14px', borderRadius: 6, background: qc.bg, color: qc.color, border: `1px solid ${qc.border}`, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>
                        {qLabel(qk)}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* ── E: Action bar ── */}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setDetailTask(null); openEdit(t) }}
                style={{ flex: 1, padding: '11px 12px', background: 'rgba(193,145,49,0.08)', color: '#C19131', border: '1px solid rgba(193,145,49,0.25)', borderRadius: 10, fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>
                Edit
              </button>
              {t.status !== 'done' && (
                <button onClick={() => { setDetailTask(null); completeTask(t.id) }} disabled={completing === t.id}
                  style={{ flex: 1, padding: '11px 12px', background: 'rgba(193,145,49,0.08)', color: '#C19131', border: '1px solid rgba(193,145,49,0.25)', borderRadius: 10, fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif", opacity: completing === t.id ? 0.6 : 1 }}>
                  ✓ Done
                </button>
              )}
              <button onClick={() => { setDetailTask(null); deleteTask(t.id) }} disabled={deleting === t.id}
                style={{ padding: '11px 14px', background: 'transparent', color: '#C0392B', border: '1px solid rgba(192,57,43,0.25)', borderRadius: 10, fontSize: 14, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif", opacity: deleting === t.id ? 0.6 : 1 }}>
                Delete
              </button>
            </div>
          </Modal>
        )
      })()}

      {/* ── Mobile FAB ── */}
      <button
        onClick={e => { e.stopPropagation(); setAddOpen(true) }}
        className="matrix-fab"
        style={{
          position: 'fixed', right: 20,
          bottom: 'calc(72px + env(safe-area-inset-bottom, 0px))',
          width: 52, height: 52, borderRadius: '50%',
          background: '#C19131',
          color: '#fff', border: 'none', fontSize: 28,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 20px rgba(193,145,49,0.4)',
          cursor: 'pointer', zIndex: 150,
          touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent',
        }}
      >+</button>
    </div>
  )
}

// ─── CALENDAR TAB ─────────────────────────────────────────────────────────────
// Helper: local YYYY-MM-DD string from a Date (avoids UTC/timezone boundary issues)
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Helper: get a sortable Date from a calendar event.
// MS Graph returns dateTime without a timezone suffix when Prefer:UTC is set,
// which causes JS to interpret it as LOCAL time — wrong for AEDT users.
// We always force UTC by appending 'Z' if no offset/Z is present.
function toUTC(dt: string): Date {
  return new Date(/[Z+\-]\d{2}:\d{2}$/.test(dt) || dt.endsWith('Z') ? dt : dt + 'Z')
}
function evtStart(e: CalendarEvent): Date {
  if (e.start?.dateTime) return toUTC(e.start.dateTime)
  if (e.start?.date)     return new Date(e.start.date + 'T00:00:00')   // all-day → local midnight
  return new Date(0)
}
function evtEnd(e: CalendarEvent): Date {
  if (e.end?.dateTime) return toUTC(e.end.dateTime)
  if (e.end?.date)     return new Date(e.end.date + 'T23:59:59')
  return new Date(0)
}

function CalendarTab({ events, tasks, loadError }: { events: CalendarEvent[]; tasks: EisenhowerTask[]; loadError?: boolean }) {
  const [view, setView]       = useState<'agenda'|'week'>('agenda')
  const [selected, setSelected] = useState<{ type: 'event'; data: CalendarEvent } | { type: 'task'; data: EisenhowerTask } | null>(null)
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const now      = new Date()
  const todayKey = localDateKey(now)
  const tmrwKey  = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))
  const todayMid = new Date(now); todayMid.setHours(0, 0, 0, 0)

  // Build day groups: events + tasks together, sorted by date
  type DayGroup = { label: string; isToday: boolean; events: CalendarEvent[]; tasks: EisenhowerTask[] }
  const byDay: Record<string, DayGroup> = {}

  const mkGroup = (key: string): DayGroup => {
    const isToday = key === todayKey
    const isTmrw  = key === tmrwKey
    const d = new Date(key + 'T00:00:00')
    const label = isToday ? 'Today' : isTmrw ? 'Tomorrow' : d.toLocaleDateString('en-AU', { weekday: 'short', month: 'short', day: 'numeric' })
    return { label, isToday, events: [], tasks: [] }
  }

  ;[...events]
    .filter(e => (e.start?.dateTime || e.start?.date) && evtEnd(e).getTime() >= todayMid.getTime())
    .sort((a, b) => evtStart(a).getTime() - evtStart(b).getTime())
    .forEach(e => {
      const key = localDateKey(evtStart(e))
      if (!byDay[key]) byDay[key] = mkGroup(key)
      byDay[key].events.push(e)
    })

  tasks.filter(t => t.due_date).forEach(t => {
    const key = t.due_date!
    if (!byDay[key]) byDay[key] = mkGroup(key)
    byDay[key].tasks.push(t)
  })

  const sortedDays = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b))

  // Mon–Sun for current week
  const weekDays = (() => {
    const dow = now.getDay()
    const mon = new Date(now); mon.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1)); mon.setHours(0, 0, 0, 0)
    return Array.from({ length: 7 }, (_, i) => { const x = new Date(mon); x.setDate(mon.getDate() + i); return x })
  })()

  // ── Detail renderers ──────────────────────────────────────────────────────
  function renderEventDetail(e: CalendarEvent) {
    const isAllDay = e.isAllDay || !e.start?.dateTime
    return (
      <>
        <h3 style={{ margin: '0 0 16px', fontSize: 17, fontWeight: 600, color: '#FFFFFF', lineHeight: 1.4 }}>{e.subject}</h3>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 14px', background: 'rgba(193,145,49,0.06)', border: '1px solid rgba(193,145,49,0.15)', borderRadius: 10, marginBottom: 10 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#C19131" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          <div>
            <p style={{ margin: '0 0 3px', fontSize: 14, color: '#FFFFFF', fontWeight: 500 }}>
              {isAllDay ? 'All Day' : `${fmt(e.start.dateTime!)} – ${fmt(e.end?.dateTime ?? '')}`}
            </p>
            <p style={{ margin: 0, fontSize: 12, color: '#D9D2BE' }}>
              {evtStart(e).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
          </div>
        </div>
        {e.location?.displayName && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 14px', background: '#3f5262', borderRadius: 10, marginBottom: 10 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D9D2BE" strokeWidth="2" strokeLinecap="round"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
            <span style={{ fontSize: 13, color: '#FFFFFF' }}>{e.location.displayName}</span>
          </div>
        )}
        {e.organizer?.emailAddress?.name && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 14px', background: '#3f5262', borderRadius: 10, marginBottom: 10 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D9D2BE" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
            <span style={{ fontSize: 13, color: '#FFFFFF' }}>{e.organizer.emailAddress.name}</span>
          </div>
        )}
        {e.bodyPreview && (
          <div style={{ background: '#3f5262', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 10, padding: '12px 14px' }}>
            <p style={{ margin: '0 0 6px', fontSize: 11, fontWeight: 600, color: '#D9D2BE', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Description</p>
            <p style={{ margin: 0, fontSize: 13, color: '#D9D2BE', lineHeight: 1.6 }}>{e.bodyPreview}</p>
          </div>
        )}
      </>
    )
  }

  function renderTaskDetail(t: EisenhowerTask) {
    const qCfg = quadrantConfig[t.quadrant]
    const qLabel = t.quadrant === 'do' ? 'Q1' : t.quadrant === 'schedule' ? 'Q2' : t.quadrant === 'delegate' ? 'Q3' : 'Q4'
    return (
      <>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 6, background: qCfg.bg, color: qCfg.color, border: `1px solid ${qCfg.border}` }}>{qLabel} — {qCfg.label}</span>
          {t.client_name && <Badge text={t.client_name} color="#C19131" />}
        </div>
        <h3 style={{ margin: '0 0 16px', fontSize: 17, fontWeight: 600, color: '#FFFFFF', lineHeight: 1.4 }}>{t.title}</h3>
        {t.due_date && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 14px', background: qCfg.bg, border: `1px solid ${qCfg.border}`, borderRadius: 10, marginBottom: 10 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={qCfg.color} strokeWidth="2" strokeLinecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>
            <span style={{ fontSize: 13, color: '#FFFFFF' }}>Due {fmtDate(t.due_date)}</span>
          </div>
        )}
        {t.estimated_minutes && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 14px', background: '#3f5262', borderRadius: 10, marginBottom: 10 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D9D2BE" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            <span style={{ fontSize: 13, color: '#FFFFFF' }}>Est. {t.estimated_minutes} min</span>
          </div>
        )}
        {t.notes && (
          <div style={{ background: '#3f5262', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 10, padding: '12px 14px' }}>
            <p style={{ margin: '0 0 6px', fontSize: 11, fontWeight: 600, color: '#D9D2BE', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Notes</p>
            <p style={{ margin: 0, fontSize: 13, color: '#D9D2BE', lineHeight: 1.6 }}>{t.notes}</p>
          </div>
        )}
      </>
    )
  }

  const detailContent = selected
    ? (selected.type === 'event' ? renderEventDetail(selected.data) : renderTaskDetail(selected.data))
    : null

  const viewBtn = (v: 'agenda'|'week', label: string) => (
    <button key={v} onClick={() => setView(v)} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', fontSize: 12, background: view === v ? 'rgba(193,145,49,0.15)' : 'transparent', color: view === v ? '#C19131' : '#D9D2BE', fontWeight: view === v ? 600 : 400, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif", touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}>{label}</button>
  )

  return (
    <div style={{ position: 'relative' }}>
      <div className={selected && !isMobile ? 'email-grid email-grid--split' : 'email-grid'} style={{ gap: 16, alignItems: 'start' }}>

        {/* ── List column ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#FFFFFF' }}>Calendar</h3>
            <div style={{ display: 'flex', gap: 2, background: '#374857', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 8, padding: 3 }}>
              {viewBtn('agenda', 'Agenda')}
              {viewBtn('week', 'Week')}
            </div>
          </div>

          {/* ── Agenda view ── */}
          {view === 'agenda' && (
            sortedDays.length === 0
              ? <Card><p style={{ color: loadError ? '#C0392B' : '#D9D2BE', margin: 0, fontSize: 13 }}>{loadError ? "Couldn't load your calendar — tap Retry at the top." : 'No upcoming events or tasks.'}</p></Card>
              : <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {sortedDays.slice(0, 14).map(([key, group]) => (
                    <div key={key} style={{ marginBottom: 8 }}>
                      {/* Day header */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, paddingTop: 4 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: group.isToday ? '#C19131' : '#D9D2BE', textTransform: 'uppercase', letterSpacing: '0.6px', whiteSpace: 'nowrap' }}>{group.label}</span>
                        <div style={{ flex: 1, height: 1, background: 'rgba(217,210,190,0.15)' }} />
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {/* Events */}
                        {group.events.map(e => {
                          const isAllDay = e.isAllDay || !e.start?.dateTime
                          const sel = selected?.type === 'event' && selected.data.id === e.id
                          return (
                            <div key={e.id} onClick={() => setSelected(sel ? null : { type: 'event', data: e })}
                              style={{ display: 'flex', background: sel ? '#3f5262' : '#374857', border: `1px solid ${sel ? '#C19131' : 'rgba(217,210,190,0.15)'}`, borderLeft: '3px solid #C19131', borderRadius: 10, overflow: 'hidden', cursor: 'pointer', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}>
                              <div style={{ padding: '10px 12px', width: 68, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'rgba(193,145,49,0.06)', borderRight: '1px solid rgba(217,210,190,0.15)' }}>
                                <span style={{ fontSize: 11, fontWeight: 700, color: '#C19131', textAlign: 'center', lineHeight: 1.3 }}>{isAllDay ? 'All\nDay' : fmt(e.start.dateTime!)}</span>
                              </div>
                              <div style={{ padding: '10px 12px', flex: 1, minWidth: 0 }}>
                                <p style={{ margin: '0 0 3px', fontSize: 14, fontWeight: 500, color: '#FFFFFF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.subject}</p>
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                  {e.location?.displayName && <span style={{ fontSize: 11, color: '#D9D2BE' }}>@ {e.location.displayName}</span>}
                                  {e.organizer?.emailAddress?.name && <span style={{ fontSize: 11, color: '#D9D2BE' }}>{e.organizer.emailAddress.name}</span>}
                                </div>
                              </div>
                              <div style={{ padding: '0 10px', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(217,210,190,0.4)" strokeWidth="2.5" strokeLinecap="round"><path d="M9 18l6-6-6-6"/></svg>
                              </div>
                            </div>
                          )
                        })}
                        {/* Tasks (with Q badge) */}
                        {group.tasks.map(t => {
                          const qCfg  = quadrantConfig[t.quadrant]
                          const qLabel = t.quadrant === 'do' ? 'Q1' : t.quadrant === 'schedule' ? 'Q2' : t.quadrant === 'delegate' ? 'Q3' : 'Q4'
                          const sel   = selected?.type === 'task' && selected.data.id === t.id
                          return (
                            <div key={t.id} onClick={() => setSelected(sel ? null : { type: 'task', data: t })}
                              style={{ display: 'flex', background: sel ? '#3f5262' : '#374857', border: `1px solid ${sel ? qCfg.color : 'rgba(217,210,190,0.15)'}`, borderLeft: `3px solid ${qCfg.color}`, borderRadius: 10, overflow: 'hidden', cursor: 'pointer', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}>
                              <div style={{ padding: '10px 12px', width: 68, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: qCfg.bg, borderRight: '1px solid rgba(217,210,190,0.15)' }}>
                                <span style={{ fontSize: 13, fontWeight: 800, color: qCfg.color }}>{qLabel}</span>
                                <span style={{ fontSize: 9, color: qCfg.color, opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.3px' }}>task</span>
                              </div>
                              <div style={{ padding: '10px 12px', flex: 1, minWidth: 0 }}>
                                <p style={{ margin: '0 0 3px', fontSize: 14, fontWeight: 500, color: '#FFFFFF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</p>
                                {t.client_name && <span style={{ fontSize: 11, color: '#C19131' }}>{t.client_name}</span>}
                              </div>
                              <div style={{ padding: '0 10px', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(217,210,190,0.4)" strokeWidth="2.5" strokeLinecap="round"><path d="M9 18l6-6-6-6"/></svg>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
          )}

          {/* ── Week view ── */}
          {view === 'week' && (
            <div className="r-week-grid">
              {weekDays.map(day => {
                const dayKey  = localDateKey(day)
                const isToday = dayKey === todayKey
                const dayEvts = events.filter(e => (e.start?.dateTime || e.start?.date) && localDateKey(evtStart(e)) === dayKey).sort((a, b) => evtStart(a).getTime() - evtStart(b).getTime())
                const dayTasks = tasks.filter(t => t.due_date === dayKey)
                return (
                  <div key={dayKey} style={{ background: isToday ? 'rgba(193,145,49,0.06)' : '#374857', border: `1px solid ${isToday ? 'rgba(193,145,49,0.3)' : 'rgba(217,210,190,0.15)'}`, borderRadius: 10, padding: '10px 8px', minHeight: 140 }}>
                    <div style={{ textAlign: 'center', marginBottom: 10 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: isToday ? '#C19131' : '#D9D2BE', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{day.toLocaleDateString('en-AU', { weekday: 'short' })}</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: isToday ? '#C19131' : '#FFFFFF', lineHeight: 1.3 }}>{day.getDate()}</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {dayEvts.length === 0 && dayTasks.length === 0
                        ? <p style={{ color: 'rgba(217,210,190,0.15)', fontSize: 11, margin: 0, textAlign: 'center' }}>—</p>
                        : <>
                            {dayEvts.map(e => (
                              <div key={e.id} onClick={() => setSelected({ type: 'event', data: e })} style={{ background: 'rgba(193,145,49,0.1)', borderLeft: '2px solid #C19131', borderRadius: 4, padding: '3px 6px', cursor: 'pointer', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}>
                                <div style={{ fontSize: 10, color: '#C19131', fontWeight: 600 }}>{(e.isAllDay || !e.start?.dateTime) ? 'All day' : fmt(e.start.dateTime!)}</div>
                                <div style={{ fontSize: 11, color: '#FFFFFF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.subject}</div>
                              </div>
                            ))}
                            {dayTasks.map(t => {
                              const qCfg = quadrantConfig[t.quadrant]
                              const qL   = t.quadrant === 'do' ? 'Q1' : t.quadrant === 'schedule' ? 'Q2' : t.quadrant === 'delegate' ? 'Q3' : 'Q4'
                              return (
                                <div key={t.id} onClick={() => setSelected({ type: 'task', data: t })} style={{ background: qCfg.bg, borderLeft: `2px solid ${qCfg.color}`, borderRadius: 4, padding: '3px 6px', cursor: 'pointer', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}>
                                  <div style={{ fontSize: 10, color: qCfg.color, fontWeight: 700 }}>{qL}</div>
                                  <div style={{ fontSize: 11, color: '#FFFFFF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                                </div>
                              )
                            })}
                          </>
                      }
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* ── Desktop detail panel ── */}
        {selected && !isMobile && (
          <Card style={{ position: 'sticky', top: 72, alignSelf: 'start', maxHeight: 'calc(100vh - 96px)', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
              <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', color: '#D9D2BE', cursor: 'pointer', fontSize: 20 }}>&#x2715;</button>
            </div>
            {detailContent}
          </Card>
        )}
      </div>

      {/* ── Mobile: full-screen detail slide-in ── */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 300,
        background: '#2E3D49',
        transform: (selected && isMobile) ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.3s cubic-bezier(0.4,0,0.2,1)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden', touchAction: 'pan-y',
        pointerEvents: (selected && isMobile) ? 'auto' : 'none',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', height: 56, padding: '0 16px', background: '#374857', borderBottom: '1px solid rgba(217,210,190,0.15)', flexShrink: 0 }}>
          <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', color: '#C19131', fontSize: 17, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif", display: 'flex', alignItems: 'center', gap: 4, padding: '8px 0', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}>
            ‹ Calendar
          </button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '20px 16px 40px', WebkitOverflowScrolling: 'touch' }}>
          {detailContent}
        </div>
      </div>
    </div>
  )
}

// ─── CLIENTS TAB ──────────────────────────────────────────────────────────────
function ClientsTab({ emails, tasks, vipCompanies }: { emails: Email[]; tasks: EisenhowerTask[]; vipCompanies: string[] }) {
  const clientList = vipCompanies.map(name => {
    const domain       = vipDomainMatcher(name)
    const clientEmails = emails.filter(e => {
      const cn   = (e.ai_client_name || '').toLowerCase()
      const addr = (e.from?.address || '').toLowerCase()
      return cn.includes(name.toLowerCase()) || addr.includes(domain)
    })
    const clientTasks  = tasks.filter(t => (t.client_name || '').toLowerCase().includes(name.toLowerCase()))
    const sorted       = [...clientEmails].sort((a, b) => new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime())
    const lastEmail    = sorted[0]
    const urgentCount  = clientTasks.filter(t => t.quadrant === 'do').length
    const unreadCount  = clientEmails.filter(e => !e.isRead).length
    return { name, emails: clientEmails, tasks: clientTasks, lastEmail, urgentCount, unreadCount }
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#FFFFFF' }}>Client Pipeline</h3>
        <span style={{ fontSize: 12, color: '#D9D2BE' }}>{clientList.length} VIP clients tracked</span>
      </div>
      <div className="r-grid-2" style={{ gap: 12 }}>
        {clientList.map(c => (
          <Card key={c.name}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <h4 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: '#FFFFFF' }}>{c.name}</h4>
                {c.lastEmail
                  ? <p style={{ margin: 0, fontSize: 11, color: '#D9D2BE' }}>Last contact: {timeAgo(c.lastEmail.receivedDateTime)}</p>
                  : <p style={{ margin: 0, fontSize: 11, color: 'rgba(217,210,190,0.4)' }}>No recent email</p>}
              </div>
              {c.urgentCount > 0 && (
                <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 4, background: 'rgba(192,57,43,0.12)', color: '#C0392B', flexShrink: 0 }}>{c.urgentCount} urgent</span>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {[
                { val: c.emails.length, label: 'emails',  color: '#C19131' },
                { val: c.tasks.length,  label: 'tasks',   color: '#C19131' },
                { val: c.unreadCount,   label: 'unread',  color: c.unreadCount > 0 ? '#C0392B' : '#D9D2BE' },
              ].map(({ val, label, color }) => (
                <div key={label} style={{ flex: 1, background: '#2E3D49', borderRadius: 8, padding: '8px 6px', textAlign: 'center' }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color }}>{val}</div>
                  <div style={{ fontSize: 11, color: '#D9D2BE' }}>{label}</div>
                </div>
              ))}
            </div>

            {c.tasks.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <p style={{ margin: '0 0 6px', fontSize: 11, fontWeight: 600, color: '#D9D2BE', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Active tasks</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {c.tasks.slice(0, 3).map(t => (
                    <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 8px', background: '#2E3D49', borderRadius: 6 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: quadrantConfig[t.quadrant].color, flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: '#D9D2BE', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                    </div>
                  ))}
                  {c.tasks.length > 3 && <p style={{ margin: 0, fontSize: 11, color: 'rgba(217,210,190,0.4)' }}>+{c.tasks.length - 3} more</p>}
                </div>
              </div>
            )}

            {c.lastEmail && (
              <div style={{ padding: '8px 10px', background: '#2E3D49', borderRadius: 8 }}>
                <p style={{ margin: '0 0 2px', fontSize: 11, color: '#D9D2BE' }}>{c.lastEmail.from?.name || c.lastEmail.from?.address || 'Unknown sender'}</p>
                <p style={{ margin: 0, fontSize: 12, color: '#D9D2BE', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.lastEmail.subject}</p>
              </div>
            )}

            {!c.lastEmail && c.tasks.length === 0 && (
              <p style={{ margin: 0, fontSize: 12, color: 'rgba(217,210,190,0.4)' }}>No recent activity</p>
            )}
          </Card>
        ))}
      </div>
    </div>
  )
}

// ─── Markdown renderer ────────────────────────────────────────────────────────
function renderMarkdown(text: string): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string) =>
    escape(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code style="background:rgba(217,210,190,0.15);padding:1px 5px;border-radius:3px;font-size:12px">$1</code>')

  const lines = text.split('\n')
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Table block
    if (line.trim().startsWith('|')) {
      const tLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) { tLines.push(lines[i]); i++ }
      out.push('<table style="border-collapse:collapse;width:100%;margin:8px 0;font-size:13px">')
      tLines.forEach((tl, ti) => {
        if (ti === 1) return // separator row
        const cells = tl.split('|').slice(1, -1)
        const tag = ti === 0 ? 'th' : 'td'
        const bg = ti === 0 ? '#3f5262' : ti % 2 === 0 ? 'rgba(217,210,190,0.1)' : 'transparent'
        out.push(`<tr style="background:${bg}">`)
        cells.forEach(c => out.push(`<${tag} style="padding:5px 10px;border:1px solid rgba(217,210,190,0.15);text-align:left">${inline(c.trim())}</${tag}>`))
        out.push('</tr>')
      })
      out.push('</table>')
      continue
    }

    // Headings
    if (line.startsWith('### ')) { out.push(`<h3 style="margin:10px 0 4px;font-size:13px;font-weight:600;color:#C19131">${inline(line.slice(4))}</h3>`); i++; continue }
    if (line.startsWith('## '))  { out.push(`<h2 style="margin:12px 0 5px;font-size:14px;font-weight:600;color:#C19131">${inline(line.slice(3))}</h2>`); i++; continue }
    if (line.startsWith('# '))   { out.push(`<h1 style="margin:14px 0 6px;font-size:15px;font-weight:700;color:#C19131">${inline(line.slice(2))}</h1>`); i++; continue }

    // Bullet list
    if (/^[-*] /.test(line)) {
      out.push('<ul style="margin:4px 0;padding-left:18px">')
      while (i < lines.length && /^[-*] /.test(lines[i])) { out.push(`<li style="margin:2px 0">${inline(lines[i].slice(2))}</li>`); i++ }
      out.push('</ul>')
      continue
    }

    // Numbered list
    if (/^\d+\. /.test(line)) {
      out.push('<ol style="margin:4px 0;padding-left:18px">')
      while (i < lines.length && /^\d+\. /.test(lines[i])) { out.push(`<li style="margin:2px 0">${inline(lines[i].replace(/^\d+\. /, ''))}</li>`); i++ }
      out.push('</ol>')
      continue
    }

    // Blank line
    if (line.trim() === '') { i++; continue }

    // Paragraph
    out.push(`<p style="margin:3px 0">${inline(line)}</p>`)
    i++
  }

  return out.join('')
}

// ─── CHAT TAB ─────────────────────────────────────────────────────────────────
function ChatTab() {
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([
    { role: 'assistant', content: "Hi Richard, I'm your Admin Agent. I can help you manage emails, tasks, and calendar. What would you like to do today?" }
  ])
  const [input, setInput]   = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const quickActions = [
    { label: 'Morning briefing',  msg: 'Generate my morning briefing for today' },
    { label: 'Triage inbox',      msg: 'What are my most urgent emails to respond to today?' },
    { label: "Today's schedule",  msg: 'What does my schedule look like today?' },
    { label: 'Q1 tasks',          msg: 'What are my most urgent Q1 tasks right now?' },
    { label: 'Weekly review',     msg: 'Help me do a weekly review of my Eisenhower matrix' },
    { label: 'Focus block',       msg: 'What Q2 work should I schedule a focus block for this week?' },
  ]

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, loading])

  async function send(message?: string) {
    const userMsg = (message || input).trim()
    if (!userMsg || loading) return
    setInput('')
    setMessages(m => [...m, { role: 'user', content: userMsg }])
    setLoading(true)
    try {
      // Build full conversation array (Claude API format) — edge function expects `messages`
      const conversationMessages = [
        ...messages.filter(m => m.role === 'user' || m.role === 'assistant'),
        { role: 'user' as const, content: userMsg },
      ]
      const res = await authFetch(`${SUPABASE_FUNCTIONS_URL}/chat`, {
        method: 'POST',
        body: JSON.stringify({ message: userMsg, messages: conversationMessages }),
      })
      const data = await res.json()
      setMessages(m => [...m, { role: 'assistant', content: data.response || data.message || JSON.stringify(data) }])
    } catch {
      setMessages(m => [...m, { role: 'assistant', content: 'Sorry, I encountered an error. Please try again.' }])
    }
    setLoading(false)
  }

  return (
    <div className="chat-container">
      {messages.length <= 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {quickActions.map(qa => (
            <button key={qa.label} onClick={() => send(qa.msg)} style={{ padding: '7px 14px', background: '#374857', color: '#D9D2BE', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 20, fontSize: 12, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>
              {qa.label}
            </button>
          ))}
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 16 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            {m.role === 'user' ? (
              <div style={{ maxWidth: '75%', padding: '10px 14px', borderRadius: '12px 12px 4px 12px', background: '#C19131', color: '#FFFFFF', fontSize: 14, lineHeight: 1.6 }}>
                {m.content}
              </div>
            ) : (
              <div
                dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                style={{ maxWidth: '85%', padding: '10px 14px', borderRadius: '12px 12px 12px 4px', background: '#374857', border: '1px solid rgba(217,210,190,0.15)', color: '#FFFFFF', fontSize: 14, lineHeight: 1.6 }}
              />
            )}
          </div>
        ))}
        {loading && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{ padding: '10px 14px', background: '#374857', border: '1px solid rgba(217,210,190,0.15)', borderRadius: '12px 12px 12px 4px', color: '#D9D2BE', fontSize: 14 }}>Thinking...</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()} placeholder="Ask me anything about your day..." style={{ flex: 1, padding: '12px 16px', background: '#374857', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 10, color: '#FFFFFF', fontSize: 14, outline: 'none', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }} />
        <button onClick={() => send()} disabled={loading || !input.trim()} style={{ padding: '12px 20px', background: loading || !input.trim() ? '#3f5262' : '#C19131', color: loading || !input.trim() ? 'rgba(217,210,190,0.4)' : '#fff', border: 'none', borderRadius: 10, cursor: loading || !input.trim() ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 500, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>Send</button>
      </div>
    </div>
  )
}

// ─── SETTINGS TAB ─────────────────────────────────────────────────────────────
function SettingsTab({ connected, onDisconnect, settings, save, loading }: {
  connected: boolean
  onDisconnect: () => void
  settings: ReturnType<typeof useUserSettings>['settings']
  save: ReturnType<typeof useUserSettings>['save']
  loading: boolean
}) {
  const [briefingTime, setBriefingTime] = useState(DEFAULT_SETTINGS.briefingTime)
  const [focusStart, setFocusStart]     = useState(DEFAULT_SETTINGS.focusStart)
  const [focusEnd, setFocusEnd]         = useState(DEFAULT_SETTINGS.focusEnd)
  const [vipContacts, setVipContacts]   = useState<string[]>([...DEFAULT_SETTINGS.vipCompanies])
  const [newContact, setNewContact]     = useState('')
  const [saved, setSaved]               = useState(false)
  const [saving, setSaving]             = useState(false)
  const [syncing, setSyncing]           = useState(false)
  const [syncMessage, setSyncMessage]   = useState<string | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  async function triggerVipSync() {
    setSyncing(true)
    setSyncMessage(null)
    try {
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/sync-vips`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY, 'Content-Type': 'application/json' },
      })
      const data = await res.json()
      if (!res.ok || data?.success === false) {
        setSyncMessage(`Sync failed: ${data?.error || res.statusText}`)
      } else {
        setSyncMessage(`Synced ${data.count ?? 0} clients from SharePoint. Reload to see them.`)
      }
    } catch (e) {
      setSyncMessage(`Sync failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
    setSyncing(false)
  }

  // Hydrate local form state once settings have loaded from Supabase.
  useEffect(() => {
    if (loading) return
    setBriefingTime(settings.briefingTime)
    setFocusStart(settings.focusStart)
    setFocusEnd(settings.focusEnd)
    setVipContacts(settings.vipCompanies)
  }, [loading, settings])

  async function savePrefs() {
    setSaving(true)
    await save({
      briefingTime,
      focusStart,
      focusEnd,
      vipCompanies: vipContacts,
    })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  function addContact() {
    const c = newContact.trim()
    if (c && !vipContacts.includes(c)) { setVipContacts(p => [...p, c]); setNewContact('') }
  }

  function disconnect() {
    onDisconnect()
  }

  const archiveRules = [
    { label: 'No-reply senders',       pattern: 'noreply@*,  no-reply@*' },
    { label: 'Notification services',  pattern: 'notifications@*' },
    { label: 'SharePoint / Teams',     pattern: '*@sharepoint.com, *@teams.microsoft.com' },
    { label: 'n8n automation',         pattern: '*@n8n.io' },
    { label: 'Microsoft system mail',  pattern: '*@microsoft.com' },
  ]

  const labelStyle: React.CSSProperties = { fontSize: 12, color: '#D9D2BE', display: 'block', marginBottom: 6 }

  return (
    <div style={{ maxWidth: 600, display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Briefing Preferences */}
      <Card>
        <h3 style={{ margin: '0 0 16px', fontSize: 13, fontWeight: 600, color: '#C19131', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Briefing Preferences</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>Daily Briefing Time</label>
            <input type="time" value={briefingTime} onChange={e => setBriefingTime(e.target.value)} style={{ ...inputStyle, maxWidth: 160 }} />
          </div>
          <div>
            <label style={labelStyle}>Focus Block Window</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input type="time" value={focusStart} onChange={e => setFocusStart(e.target.value)} style={{ ...inputStyle, maxWidth: 140 }} />
              <span style={{ color: '#D9D2BE', fontSize: 13 }}>to</span>
              <input type="time" value={focusEnd}   onChange={e => setFocusEnd(e.target.value)}   style={{ ...inputStyle, maxWidth: 140 }} />
            </div>
          </div>
        </div>
      </Card>

      {/* VIP Clients — Manual */}
      <Card>
        <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, color: '#C19131', textTransform: 'uppercase', letterSpacing: '0.8px' }}>VIP Clients (Manual)</h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: '#D9D2BE' }}>Treated as VIP in Email and Clients tabs. Combined with SharePoint-synced clients below.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {vipContacts.map(name => (
            <div key={name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 10px', background: '#2E3D49', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 7 }}>
              <span style={{ fontSize: 13, color: '#FFFFFF' }}>{name}</span>
              <button onClick={() => setVipContacts(p => p.filter(c => c !== name))} style={{ background: 'none', border: 'none', color: '#D9D2BE', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}>&#x2715;</button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={newContact} onChange={e => setNewContact(e.target.value)} onKeyDown={e => e.key === 'Enter' && addContact()} placeholder="Add client name..." style={{ ...inputStyle, flex: 1 }} />
          <button onClick={addContact} disabled={!newContact.trim()} style={{ ...primaryBtnStyle, opacity: newContact.trim() ? 1 : 0.5 }}>Add</button>
        </div>
      </Card>

      {/* VIP Clients — SharePoint synced */}
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#C19131', textTransform: 'uppercase', letterSpacing: '0.8px' }}>SharePoint Clients (Auto)</h3>
          <button
            onClick={triggerVipSync}
            disabled={syncing}
            style={{ ...primaryBtnStyle, padding: '6px 12px', fontSize: 12, opacity: syncing ? 0.6 : 1 }}
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: '#D9D2BE' }}>
          Read-only. Pulled from <code style={{ fontSize: 11, color: '#D9D2BE' }}>quratepty.sharepoint.com/sites/QurateClient</code> + your <code style={{ fontSize: 11, color: '#D9D2BE' }}>1. Own - Engagements</code> OneDrive.
          {settings.vipCompaniesAutoSyncedAt
            ? <> Last synced {timeAgo(settings.vipCompaniesAutoSyncedAt)}.</>
            : <> Never synced.</>}
        </p>
        {syncMessage && (
          <p style={{ margin: '0 0 10px', fontSize: 12, color: syncMessage.startsWith('Sync failed') ? '#C0392B' : '#D9D2BE' }}>{syncMessage}</p>
        )}
        {settings.vipCompaniesAuto.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12, color: 'rgba(217,210,190,0.5)' }}>No SharePoint clients yet. Hit Sync now to fetch them.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {settings.vipCompaniesAuto.map(name => (
              <div key={name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 10px', background: '#2E3D49', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 7 }}>
                <span style={{ fontSize: 13, color: '#FFFFFF' }}>{name}</span>
                <span style={{ fontSize: 10, color: 'rgba(217,210,190,0.5)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>SharePoint</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Auto-archive Rules */}
      <Card>
        <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, color: '#C19131', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Auto-archive Rules</h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: '#D9D2BE' }}>Emails matching these patterns are routed to the Tools filter automatically.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {archiveRules.map(r => (
            <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', background: '#2E3D49', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 7 }}>
              <span style={{ fontSize: 13, color: '#FFFFFF' }}>{r.label}</span>
              <span style={{ fontSize: 11, color: 'rgba(217,210,190,0.4)', fontFamily: 'monospace' }}>{r.pattern}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Save */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={savePrefs}
          disabled={saving || loading}
          style={{ ...primaryBtnStyle, minWidth: 140, opacity: (saving || loading) ? 0.6 : 1 }}
        >
          {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save Preferences'}
        </button>
      </div>

      {/* Microsoft Connection */}
      <Card>
        <h3 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 600, color: '#C19131', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Microsoft Connection</h3>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <p style={{ margin: '0 0 4px', fontSize: 14, color: '#FFFFFF' }}>{connected ? 'Connected to Microsoft 365' : 'Not connected'}</p>
            <p style={{ margin: 0, fontSize: 12, color: '#D9D2BE' }}>{connected ? 'Your email and calendar are syncing.' : 'Connect to access email and calendar data.'}</p>
          </div>
          {connected && <button onClick={() => setConfirmDisconnect(true)} style={{ padding: '8px 14px', background: 'rgba(192,57,43,0.1)', color: '#C0392B', border: '1px solid rgba(192,57,43,0.2)', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>Disconnect</button>}
        </div>
      </Card>

      {confirmDisconnect && (
        <Modal title="Disconnect Microsoft?" onClose={() => setConfirmDisconnect(false)}>
          <p style={{ margin: '0 0 20px', fontSize: 14, color: BEIGE, lineHeight: 1.6 }}>
            This revokes access to your email and calendar and signs you out. You&apos;ll need to sign in with Microsoft again to reconnect.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => setConfirmDisconnect(false)} style={secondaryBtnStyle}>Cancel</button>
            <button onClick={() => { setConfirmDisconnect(false); disconnect() }} style={{ ...primaryBtnStyle, background: RED, color: WHITE }}>Disconnect</button>
          </div>
        </Modal>
      )}

      {/* About */}
      <Card>
        <h3 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 600, color: '#C19131', textTransform: 'uppercase', letterSpacing: '0.8px' }}>About</h3>
        <p style={{ margin: 0, fontSize: 13, color: '#D9D2BE', lineHeight: 1.6 }}>
          Qurate Admin Agent v1.0<br />
          Stack: Next.js, Supabase, Microsoft Graph, Claude API (Haiku + Sonnet)
        </p>
      </Card>
    </div>
  )
}

// ─── MAIN DASHBOARD ───────────────────────────────────────────────────────────
const TAB_TITLES: Record<string, string> = {
  briefing: 'Briefing', email: 'Inbox', calendar: 'Calendar',
  matrix: 'Tasks', clients: 'Clients', chat: 'AI Chat', settings: 'Settings',
}

type Tab = 'briefing'|'email'|'calendar'|'matrix'|'clients'|'chat'|'settings'

// Simple SVG icons for bottom nav
function NavIcon({ name }: { name: Tab }) {
  const s = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }
  if (name === 'briefing') return <svg {...s} strokeLinecap="round" strokeLinejoin="round"><path d="M3 12L12 3l9 9"/><path d="M5 10v9a1 1 0 001 1h4v-5h4v5h4a1 1 0 001-1V10"/></svg>
  if (name === 'email')    return <svg {...s} strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 8l10 6 10-6"/></svg>
  if (name === 'calendar') return <svg {...s} strokeLinecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>
  if (name === 'matrix')   return <svg {...s} strokeLinecap="round"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>
  if (name === 'clients')  return <svg {...s} strokeLinecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
  if (name === 'chat')     return <svg {...s} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
  /* settings */           return <svg {...s} strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v2m0 16v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M2 12h2m16 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
}
export default function Dashboard() {
  const [tab, setTab]           = useState<Tab>('briefing')
  const [emails, setEmails]     = useState<Email[]>([])
  const [events, setEvents]     = useState<CalendarEvent[]>([])
  const [tasks, setTasks]       = useState<EisenhowerTask[]>([])
  const [emailLoading, setEmailLoading] = useState(false)
  const [connected, setConnected] = useState(false)
  // Per-source load errors. Presence of a value means that source failed to load —
  // the UI uses this to show an honest "couldn't load" instead of an empty "all clear".
  const [loadErrors, setLoadErrors] = useState<{ email?: string; calendar?: string; tasks?: string; auth?: boolean }>({})
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const userSettings = useUserSettings()
  const { settings, vipCompaniesMerged } = userSettings

  // Verify MS token on mount; redirect to login if missing
  useEffect(() => {
    getMsToken().then(({ token }) => {
      if (token) setConnected(true)
      else window.location.href = '/'
    })
  }, [])

  const loadEmails = useCallback(async () => {
    setEmailLoading(true)
    setLoadErrors(e => ({ ...e, email: undefined }))
    try {
      const { token } = await getMsToken()
      if (!token) { setLoadErrors(e => ({ ...e, auth: true, email: 'auth' })); setEmailLoading(false); return }
      setLoadErrors(e => ({ ...e, auth: false }))
      const r = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=50&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,isRead', { headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) throw new Error(`Graph ${r.status}`)
      const data = await r.json()
      const emails: Email[] = (data.value || []).filter((e: Email) => e.from && e.id && e.receivedDateTime)

      // Enrich with email_processing_history (back-of-house AI classification).
      // The DB uses ai_category values 'do | plan | delegate | eliminate'; the dashboard's
      // ai_quadrant uses 'do | schedule | delegate | eliminate'. Map plan → schedule.
      // If this enrich fails, we silently fall through to heuristic categorisation — no regression.
      if (emails.length > 0) {
        try {
          const ids = emails.map(e => `"${e.id}"`).join(',')
          const enrichRes = await fetch(
            `${SUPABASE_URL}/rest/v1/email_processing_history?select=email_id,ai_category,ai_client_name&email_id=in.(${ids})`,
            { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } }
          )
          if (enrichRes.ok) {
            const enrichData: Array<{ email_id: string; ai_category?: string; ai_client_name?: string }> = await enrichRes.json()
            const mapQuadrant = (c?: string): Email['ai_quadrant'] | undefined => {
              if (!c) return undefined
              const v = c.toLowerCase()
              if (v === 'plan') return 'schedule'
              if (v === 'do' || v === 'schedule' || v === 'delegate' || v === 'eliminate') return v as Email['ai_quadrant']
              return undefined
            }
            const byId = new Map(enrichData.map(r => [r.email_id, r]))
            for (const email of emails) {
              const ai = byId.get(email.id)
              if (ai) {
                email.ai_quadrant = mapQuadrant(ai.ai_category) ?? email.ai_quadrant
                email.ai_client_name = ai.ai_client_name ?? email.ai_client_name
              }
            }
          }
        } catch (enrichErr) {
          console.warn('Email enrichment from email_processing_history failed (non-fatal):', enrichErr)
        }
      }

      setEmails(emails)
    } catch (e) {
      console.error('Email load error:', e)
      setLoadErrors(prev => ({ ...prev, email: e instanceof Error ? e.message : 'load failed' }))
    }
    setEmailLoading(false)
  }, [])

  const loadCalendar = useCallback(async () => {
    // Strategy: read from calendar_events table first (populated every 30 min by
    // pg_cron sync-calendar-30min calling ms-calendar). Fall back to a live Graph
    // pull only when the cache is empty or stale (>2h old).
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setDate(start.getDate() + 14)
    const startIso = start.toISOString()
    const endIso = end.toISOString()

    type CachedEvent = { graph_event_id: string; subject: string; start_time: string; end_time: string; is_all_day: boolean; location?: string; organizer_name?: string; body_preview?: string; synced_at?: string }

    const TWO_HOURS_MS = 2 * 60 * 60 * 1000
    let usedCache = false
    setLoadErrors(e => ({ ...e, calendar: undefined }))

    try {
      const cacheRes = await fetch(
        `${SUPABASE_URL}/rest/v1/calendar_events?select=graph_event_id,subject,start_time,end_time,is_all_day,location,organizer_name,body_preview,synced_at&start_time=gte.${startIso}&start_time=lte.${endIso}&order=start_time.asc&limit=50`,
        { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } }
      )
      if (cacheRes.ok) {
        const rows: CachedEvent[] = await cacheRes.json()
        const newest = rows.reduce<number>((m, r) => Math.max(m, r.synced_at ? new Date(r.synced_at).getTime() : 0), 0)
        const fresh = rows.length > 0 && (Date.now() - newest) < TWO_HOURS_MS
        if (fresh) {
          const mapped: CalendarEvent[] = rows.map(r => ({
            id: r.graph_event_id,
            subject: r.subject,
            start: { dateTime: r.start_time },
            end: { dateTime: r.end_time },
            isAllDay: r.is_all_day,
            location: r.location ? { displayName: r.location } : undefined,
            organizer: r.organizer_name ? { emailAddress: { name: r.organizer_name } } : undefined,
            bodyPreview: r.body_preview,
          }))
          setEvents(mapped)
          usedCache = true
        }
      }
    } catch (cacheErr) {
      console.warn('calendar_events cache read failed (non-fatal):', cacheErr)
    }

    if (usedCache) return

    // Fallback: live Graph pull. Same endpoint as before — preserves the existing
    // behaviour when the cache is empty or stale (e.g. fresh OAuth, cron missed runs).
    try {
      const { token } = await getMsToken()
      if (!token) { setLoadErrors(e => ({ ...e, calendar: 'auth', auth: true })); return }
      const url = `https://graph.microsoft.com/v1.0/me/calendarView` +
        `?startDateTime=${startIso}&endDateTime=${endIso}` +
        `&$select=id,subject,start,end,location,organizer,bodyPreview,isAllDay` +
        `&$orderby=start/dateTime&$top=50`
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' } })
      if (!r.ok) throw new Error(`Graph ${r.status}`)
      const data = await r.json()
      if (data.value) setEvents(data.value)
    } catch (e) {
      console.error('Calendar load error:', e)
      setLoadErrors(prev => ({ ...prev, calendar: e instanceof Error ? e.message : 'load failed' }))
    }
  }, [])

  const loadTasks = useCallback(async () => {
    setLoadErrors(e => ({ ...e, tasks: undefined }))
    try {
      const res  = await fetch(`${SUPABASE_URL}/rest/v1/eisenhower_tasks?select=*&status=neq.done&order=created_at.desc`, { headers: { apikey: ANON_KEY } })
      if (!res.ok) throw new Error(`Supabase ${res.status}`)
      const data = await res.json()
      if (Array.isArray(data)) setTasks(data)
    } catch (e) {
      console.error('Tasks load error:', e)
      setLoadErrors(prev => ({ ...prev, tasks: e instanceof Error ? e.message : 'load failed' }))
    }
  }, [])

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }
  }, [])

  useEffect(() => { loadEmails(); loadCalendar(); loadTasks() }, [loadEmails, loadCalendar, loadTasks])

  const unread        = useMemo(() => emails.filter(e => !e.isRead).length, [emails])
  const todayEvtCount = useMemo(() => {
    const todayKey = localDateKey(new Date())
    return events.filter(e => (e.start?.dateTime || e.start?.date) && localDateKey(evtStart(e)) === todayKey).length
  }, [events])
  const q1Count = useMemo(() => tasks.filter(t => t.quadrant === 'do').length, [tasks])

  const errorMessages = useMemo(() => {
    const m: string[] = []
    if (loadErrors.auth) m.push("Couldn't reach Microsoft — reconnect in Settings if this persists")
    if (loadErrors.email && loadErrors.email !== 'auth') m.push('Inbox failed to load')
    if (loadErrors.calendar && loadErrors.calendar !== 'auth') m.push('Calendar failed to load')
    if (loadErrors.tasks) m.push('Tasks failed to load')
    return m
  }, [loadErrors])
  const reloadAll = useCallback(() => { loadEmails(); loadCalendar(); loadTasks() }, [loadEmails, loadCalendar, loadTasks])

  const calendarHasError = !!(loadErrors.auth || loadErrors.calendar)
  const emailHasError    = !!(loadErrors.auth || loadErrors.email)
  const tasksHasError    = !!loadErrors.tasks

  const navItems: Array<{ key: Tab; label: string; badge?: number }> = [
    { key: 'briefing',  label: 'Brief' },
    { key: 'email',     label: 'Mail',     badge: unread || undefined },
    { key: 'calendar',  label: 'Calendar', badge: todayEvtCount || undefined },
    { key: 'matrix',    label: 'Tasks',    badge: q1Count || undefined },
    { key: 'clients',   label: 'Clients' },
    { key: 'chat',      label: 'Chat' },
    { key: 'settings',  label: 'Settings' },
  ]

  return (
    <div style={{ minHeight: '100vh', background: NAVY, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif", fontWeight: 300 }}>

      {/* Static top header — logo left, tab title centre, logout right */}
      <div className="dash-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 30, height: 30, background: GOLD, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, color: NAVY, flexShrink: 0, fontFamily: "'Gujarati Sangam MN', 'DM Sans', serif" }}>Q</div>
          <span style={{ fontSize: 15, fontWeight: 700, color: WHITE, letterSpacing: '-0.3px', fontFamily: "'Gujarati Sangam MN', 'DM Sans', serif" }}>Qurate</span>
        </div>
        <span style={{ fontSize: 15, fontWeight: 400, color: BEIGE, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>{TAB_TITLES[tab]}</span>
        <button
          onClick={() => setConfirmSignOut(true)}
          title="Sign out"
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'transparent', color: BEIGE, border: `1px solid ${NAVY_BORDER}`, borderRadius: 8, fontSize: 12, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif", transition: 'all 0.15s' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = RED; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(192,57,43,0.4)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = BEIGE; (e.currentTarget as HTMLButtonElement).style.borderColor = NAVY_BORDER }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          Sign out
        </button>
      </div>

      {/* Scrollable content */}
      <div className="main-content">
        <HealthBanner />
        <ErrorBanner messages={errorMessages} onRetry={reloadAll} />
        {tab === 'briefing'  && <BriefingTab events={events} tasks={tasks} emails={emails} vipCompanies={vipCompaniesMerged} calendarError={calendarHasError} tasksError={tasksHasError} />}
        {tab === 'email'     && <EmailTab emails={emails} loading={emailLoading} onRefresh={loadEmails} vipCompanies={vipCompaniesMerged} loadError={emailHasError} />}
        {tab === 'calendar'  && <CalendarTab events={events} tasks={tasks} loadError={calendarHasError} />}
        {tab === 'matrix'    && <MatrixTab tasks={tasks} onRefresh={loadTasks} />}
        {tab === 'clients'   && <ClientsTab emails={emails} tasks={tasks} vipCompanies={vipCompaniesMerged} />}
        {tab === 'chat'      && <ChatTab />}
        {tab === 'settings'  && <SettingsTab connected={connected} onDisconnect={() => { setConnected(false); window.location.href = '/api/auth/logout' }} settings={userSettings.settings} save={userSettings.save} loading={userSettings.loading} />}
      </div>

      {/* Fixed bottom navigation — Outlook-style */}
      <nav className="bottom-nav">
        {navItems.map(item => (
          <button key={item.key} className={`bottom-nav-item${tab === item.key ? ' active' : ''}`} onClick={() => setTab(item.key)}>
            <NavIcon name={item.key} />
            <span>{item.label}</span>
            {item.badge ? <span className="nav-badge">{item.badge > 99 ? '99+' : item.badge}</span> : null}
          </button>
        ))}
      </nav>

      {confirmSignOut && (
        <Modal title="Sign out?" onClose={() => setConfirmSignOut(false)}>
          <p style={{ margin: '0 0 20px', fontSize: 14, color: BEIGE, lineHeight: 1.6 }}>
            This signs you out and disconnects your Microsoft 365 session. You&apos;ll need to sign in again to access your email and calendar.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => setConfirmSignOut(false)} style={secondaryBtnStyle}>Cancel</button>
            <button onClick={() => { window.location.href = '/api/auth/logout' }} style={{ ...primaryBtnStyle, background: RED, color: WHITE }}>Sign out</button>
          </div>
        </Modal>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
      `}</style>
    </div>
  )
}
