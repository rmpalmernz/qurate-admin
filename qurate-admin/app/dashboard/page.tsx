'use client'

import { useState, useEffect, useCallback } from 'react'
import { SUPABASE_FUNCTIONS_URL } from '@/lib/supabase'

const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

const authFetch = (url: string, opts: RequestInit = {}) =>
  fetch(url, { ...opts, headers: { ...(opts.headers || {}), apikey: ANON_KEY, 'Content-Type': 'application/json' } })

// ─── Types ───────────────────────────────────────────────────────────────────
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
}

interface CalendarEvent {
  id: string
  subject: string
  start: { dateTime: string }
  end: { dateTime: string }
  location?: { displayName: string }
  organizer?: { emailAddress: { name: string } }
  bodyPreview?: string
}

interface EisenhowerTask {
  id: string
  title: string
  quadrant: 'do' | 'schedule' | 'delegate' | 'eliminate'
  client_name?: string
  due_date?: string
  status: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fmt = (d: string) => new Date(d).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })
const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-AU', { weekday: 'short', month: 'short', day: 'numeric' })
const timeAgo = (d: string) => {
  const diff = Date.now() - new Date(d).getTime()
  const h = Math.floor(diff / 3600000)
  if (h < 1) return `${Math.floor(diff / 60000)}m ago`
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const quadrantConfig = {
  do: { label: 'Do First', color: '#ef4444', bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.2)' },
  schedule: { label: 'Schedule', color: '#3AAFA9', bg: 'rgba(58,175,169,0.08)', border: 'rgba(58,175,169,0.2)' },
  delegate: { label: 'Delegate', color: '#C9A96E', bg: 'rgba(201,169,110,0.08)', border: 'rgba(201,169,110,0.2)' },
  eliminate: { label: 'Eliminate', color: '#6b7280', bg: 'rgba(107,114,128,0.08)', border: 'rgba(107,114,128,0.2)' },
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: '8px 16px',
      borderRadius: 8,
      border: 'none',
      background: active ? 'rgba(58,175,169,0.15)' : 'transparent',
      color: active ? '#3AAFA9' : '#6b7280',
      fontWeight: active ? 600 : 400,
      fontSize: 13,
      cursor: 'pointer',
      fontFamily: "'DM Sans', sans-serif",
      transition: 'all 0.15s',
      whiteSpace: 'nowrap'
    }}>{children}</button>
  )
}

function Card({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: '#1a1d27',
      border: '1px solid #2a2f45',
      borderRadius: 12,
      padding: 20,
      ...style
    }}>{children}</div>
  )
}

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span style={{
      fontSize: 11,
      fontWeight: 600,
      padding: '2px 8px',
      borderRadius: 4,
      background: `${color}20`,
      color,
      textTransform: 'uppercase',
      letterSpacing: '0.5px'
    }}>{text}</span>
  )
}

function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, color: '#3AAFA9', gap: 10 }}>
      <span style={{ display: 'inline-block', width: 20, height: 20, border: '2px solid rgba(58,175,169,0.2)', borderTopColor: '#3AAFA9', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      Loading...
    </div>
  )
}

// ─── BRIEFING TAB ─────────────────────────────────────────────────────────────
function BriefingTab({ events }: { events: CalendarEvent[] }) {
  const [brief, setBrief] = useState<string>('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/ai_daily_briefs?select=brief_text&order=created_at.desc&limit=1`, {
      headers: { apikey: ANON_KEY }
    })
      .then(r => r.json())
      .then(data => {
        if (data?.[0]) setBrief(data[0].brief_text)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const today = new Date()
  const todayStr = today.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })
  const todayEvents = events.filter(e => {
    const d = new Date(e.start.dateTime)
    return d.toDateString() === today.toDateString()
  })

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: '#e8eaf0', letterSpacing: '-0.5px' }}>
          Good morning, Richard
        </h2>
        <span style={{ color: '#6b7280', fontSize: 13 }}>{todayStr}</span>
      </div>

      {/* Today's calendar */}
      <Card>
        <h3 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 600, color: '#3AAFA9', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
          Today's Calendar
        </h3>
        {todayEvents.length === 0 ? (
          <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>No meetings today — clear day ahead.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {todayEvents.map(e => (
              <div key={e.id} style={{ display: 'flex', gap: 14, padding: '10px 12px', background: '#22263a', borderRadius: 8 }}>
                <div style={{ minWidth: 70, color: '#3AAFA9', fontSize: 12, fontWeight: 600, paddingTop: 2 }}>
                  {fmt(e.start.dateTime)}
                </div>
                <div>
                  <div style={{ fontWeight: 500, color: '#e8eaf0', fontSize: 14, marginBottom: 2 }}>{e.subject}</div>
                  {e.location?.displayName && (
                    <div style={{ color: '#6b7280', fontSize: 12 }}>📍 {e.location.displayName}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* AI Brief */}
      <Card>
        <h3 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 600, color: '#C9A96E', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
          AI Daily Brief
        </h3>
        {loading ? <Spinner /> : brief ? (
          <div style={{ color: '#b0b8cc', fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{brief}</div>
        ) : (
          <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>No brief generated yet for today.</p>
        )}
      </Card>
    </div>
  )
}

// ─── EMAIL TAB ────────────────────────────────────────────────────────────────
function EmailTab({ emails, loading }: { emails: Email[]; loading: boolean }) {
  const [selected, setSelected] = useState<Email | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [draft, setDraft] = useState('')

  async function draftReply(email: Email) {
    setDrafting(true)
    setDraft('')
    try {
      const res = await authFetch(`${SUPABASE_FUNCTIONS_URL}/draft-reply`, {
        method: 'POST',
        body: JSON.stringify({
          email_id: email.id,
          subject: email.subject,
          from_name: email.from.name,
          from_email: email.from.address,
          body_preview: email.bodyPreview
        })
      })
      const data = await res.json()
      setDraft(data.draft || data.body_text || 'Could not generate draft.')
    } catch {
      setDraft('Error generating draft.')
    }
    setDrafting(false)
  }

  const priorityColor = (p?: string) => {
    if (p === 'high') return '#ef4444'
    if (p === 'medium') return '#C9A96E'
    return '#6b7280'
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 1fr' : '1fr', gap: 16 }}>
      {/* Email list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#e8eaf0' }}>
            Inbox <span style={{ color: '#6b7280', fontWeight: 400 }}>({emails.length})</span>
          </h3>
        </div>
        {loading ? <Spinner /> : emails.length === 0 ? (
          <Card><p style={{ color: '#6b7280', margin: 0, fontSize: 13 }}>No emails found.</p></Card>
        ) : emails.map(email => (
          <div
            key={email.id}
            onClick={() => setSelected(selected?.id === email.id ? null : email)}
            style={{
              background: selected?.id === email.id ? '#22263a' : '#1a1d27',
              border: `1px solid ${selected?.id === email.id ? '#3AAFA9' : '#2a2f45'}`,
              borderRadius: 10,
              padding: '12px 14px',
              cursor: 'pointer',
              transition: 'all 0.15s'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontWeight: email.isRead ? 400 : 600, fontSize: 13, color: '#e8eaf0' }}>
                  {email.from.name}
                </span>
                {email.ai_client_name && (
                  <Badge text={email.ai_client_name} color="#3AAFA9" />
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {email.ai_priority_level && (
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: priorityColor(email.ai_priority_level), flexShrink: 0 }} />
                )}
                <span style={{ color: '#6b7280', fontSize: 11 }}>{timeAgo(email.receivedDateTime)}</span>
              </div>
            </div>
            <div style={{ fontWeight: email.isRead ? 400 : 500, fontSize: 13, color: '#c0c8d8', marginBottom: 3 }}>
              {email.subject}
            </div>
            {email.ai_original_email_summary ? (
              <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.5 }}>
                🤖 {email.ai_original_email_summary.slice(0, 100)}…
              </div>
            ) : (
              <div style={{ fontSize: 12, color: '#6b7280' }}>{email.bodyPreview?.slice(0, 80)}…</div>
            )}
          </div>
        ))}
      </div>

      {/* Email detail */}
      {selected && (
        <Card style={{ position: 'sticky', top: 16, alignSelf: 'start', maxHeight: '80vh', overflow: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
            <div>
              <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: '#e8eaf0' }}>{selected.subject}</h3>
              <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>From: {selected.from.name} &lt;{selected.from.address}&gt;</p>
            </div>
            <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 18 }}>×</button>
          </div>

          {selected.ai_category && (
            <div style={{ marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Badge text={selected.ai_category} color="#3AAFA9" />
              {selected.ai_priority_level && <Badge text={selected.ai_priority_level} color={priorityColor(selected.ai_priority_level)} />}
            </div>
          )}

          {selected.ai_original_email_summary && (
            <div style={{ background: 'rgba(58,175,169,0.06)', border: '1px solid rgba(58,175,169,0.15)', borderRadius: 8, padding: '10px 12px', marginBottom: 14 }}>
              <p style={{ margin: '0 0 4px', fontSize: 11, fontWeight: 600, color: '#3AAFA9', textTransform: 'uppercase', letterSpacing: '0.5px' }}>AI Summary</p>
              <p style={{ margin: 0, fontSize: 13, color: '#b0b8cc', lineHeight: 1.6 }}>{selected.ai_original_email_summary}</p>
            </div>
          )}

          <p style={{ fontSize: 13, color: '#8892a4', lineHeight: 1.7, marginBottom: 16 }}>{selected.bodyPreview}</p>

          <button
            onClick={() => draftReply(selected)}
            disabled={drafting}
            style={{
              width: '100%',
              padding: '10px 16px',
              background: 'rgba(58,175,169,0.15)',
              color: '#3AAFA9',
              border: '1px solid rgba(58,175,169,0.3)',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 500,
              cursor: drafting ? 'not-allowed' : 'pointer',
              fontFamily: "'DM Sans', sans-serif",
              marginBottom: draft ? 12 : 0
            }}
          >
            {drafting ? 'Drafting reply...' : '✦ Draft AI Reply'}
          </button>

          {draft && (
            <div style={{ background: '#22263a', border: '1px solid #2a2f45', borderRadius: 8, padding: 12 }}>
              <p style={{ margin: '0 0 8px', fontSize: 11, fontWeight: 600, color: '#C9A96E', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Draft Reply</p>
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                style={{
                  width: '100%',
                  minHeight: 120,
                  background: 'transparent',
                  border: 'none',
                  color: '#b0b8cc',
                  fontSize: 13,
                  lineHeight: 1.6,
                  resize: 'vertical',
                  outline: 'none',
                  fontFamily: "'DM Sans', sans-serif"
                }}
              />
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

// ─── MATRIX TAB ───────────────────────────────────────────────────────────────
function MatrixTab({ tasks }: { tasks: EisenhowerTask[] }) {
  const quadrants = ['do', 'schedule', 'delegate', 'eliminate'] as const

  return (
    <div>
      <h3 style={{ margin: '0 0 16px', fontSize: 14, fontWeight: 600, color: '#e8eaf0' }}>Eisenhower Matrix</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {quadrants.map(q => {
          const cfg = quadrantConfig[q]
          const qTasks = tasks.filter(t => t.quadrant === q)
          return (
            <div key={q} style={{
              background: cfg.bg,
              border: `1px solid ${cfg.border}`,
              borderRadius: 12,
              padding: 16,
              minHeight: 160
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: cfg.color }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: cfg.color, textTransform: 'uppercase', letterSpacing: '0.6px' }}>
                  {cfg.label}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6b7280' }}>{qTasks.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {qTasks.length === 0 ? (
                  <p style={{ color: '#3d4258', fontSize: 12, margin: 0 }}>No tasks</p>
                ) : qTasks.map(t => (
                  <div key={t.id} style={{
                    background: '#1a1d27',
                    border: '1px solid #2a2f45',
                    borderRadius: 8,
                    padding: '8px 10px'
                  }}>
                    <p style={{ margin: '0 0 2px', fontSize: 13, color: '#e8eaf0', fontWeight: 500 }}>{t.title}</p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {t.client_name && <span style={{ fontSize: 11, color: '#3AAFA9' }}>{t.client_name}</span>}
                      {t.due_date && <span style={{ fontSize: 11, color: '#6b7280' }}>{fmtDate(t.due_date)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── CHAT TAB ─────────────────────────────────────────────────────────────────
function ChatTab() {
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([
    { role: 'assistant', content: "Hi Richard, I'm your Admin Agent. I can help you manage emails, tasks, and calendar. What would you like to do today?" }
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  async function send() {
    if (!input.trim() || loading) return
    const userMsg = input.trim()
    setInput('')
    setMessages(m => [...m, { role: 'user', content: userMsg }])
    setLoading(true)

    try {
      const res = await authFetch(`${SUPABASE_FUNCTIONS_URL}/chat`, {
        method: 'POST',
        body: JSON.stringify({ message: userMsg, history: messages })
      })
      const data = await res.json()
      setMessages(m => [...m, { role: 'assistant', content: data.response || data.message || JSON.stringify(data) }])
    } catch {
      setMessages(m => [...m, { role: 'assistant', content: 'Sorry, I encountered an error.' }])
    }
    setLoading(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 180px)' }}>
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 16 }}>
        {messages.map((m, i) => (
          <div key={i} style={{
            display: 'flex',
            justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start'
          }}>
            <div style={{
              maxWidth: '75%',
              padding: '10px 14px',
              borderRadius: m.role === 'user' ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
              background: m.role === 'user' ? 'linear-gradient(135deg, #3AAFA9, #2E9E98)' : '#1a1d27',
              border: m.role === 'assistant' ? '1px solid #2a2f45' : 'none',
              color: '#e8eaf0',
              fontSize: 14,
              lineHeight: 1.6
            }}>
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{ padding: '10px 14px', background: '#1a1d27', border: '1px solid #2a2f45', borderRadius: '12px 12px 12px 4px', color: '#6b7280', fontSize: 14 }}>
              Thinking...
            </div>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
          placeholder="Ask me anything about your day..."
          style={{
            flex: 1,
            padding: '12px 16px',
            background: '#1a1d27',
            border: '1px solid #2a2f45',
            borderRadius: 10,
            color: '#e8eaf0',
            fontSize: 14,
            outline: 'none',
            fontFamily: "'DM Sans', sans-serif"
          }}
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          style={{
            padding: '12px 20px',
            background: 'linear-gradient(135deg, #3AAFA9, #2E9E98)',
            color: '#fff',
            border: 'none',
            borderRadius: 10,
            cursor: 'pointer',
            fontSize: 14,
            fontWeight: 500,
            fontFamily: "'DM Sans', sans-serif"
          }}
        >
          Send
        </button>
      </div>
    </div>
  )
}

// ─── SETTINGS TAB ─────────────────────────────────────────────────────────────
function SettingsTab({ connected, onDisconnect }: { connected: boolean; onDisconnect: () => void }) {
  async function disconnect() {
    await authFetch(`${SUPABASE_FUNCTIONS_URL}/ms-auth?action=disconnect`)
    onDisconnect()
  }

  return (
    <div style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <h3 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 600, color: '#3AAFA9', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
          Microsoft Connection
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <p style={{ margin: '0 0 4px', fontSize: 14, color: '#e8eaf0' }}>
              {connected ? '✅ Connected to Microsoft 365' : '❌ Not connected'}
            </p>
            <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>
              {connected ? 'Your email and calendar are syncing.' : 'Connect to access email and calendar data.'}
            </p>
          </div>
          {connected && (
            <button
              onClick={disconnect}
              style={{
                padding: '8px 14px',
                background: 'rgba(239,68,68,0.1)',
                color: '#ef4444',
                border: '1px solid rgba(239,68,68,0.2)',
                borderRadius: 8,
                cursor: 'pointer',
                fontSize: 13,
                fontFamily: "'DM Sans', sans-serif"
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      </Card>

      <Card>
        <h3 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 600, color: '#3AAFA9', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
          About
        </h3>
        <p style={{ margin: 0, fontSize: 13, color: '#6b7280', lineHeight: 1.6 }}>
          Qurate Admin Agent — built for Richard's advisory practice.<br />
          Connects to Microsoft Graph for live email and calendar data.
        </p>
      </Card>
    </div>
  )
}

// ─── MAIN DASHBOARD ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const [tab, setTab] = useState<'briefing' | 'email' | 'matrix' | 'chat' | 'settings'>('briefing')
  const [emails, setEmails] = useState<Email[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [tasks, setTasks] = useState<EisenhowerTask[]>([])
  const [emailLoading, setEmailLoading] = useState(false)
  const [connected, setConnected] = useState(true)

  const loadEmails = useCallback(async () => {
    setEmailLoading(true)
    try {
      const res = await authFetch(`${SUPABASE_FUNCTIONS_URL}/ms-auth`)
      const { access_token } = await res.json()
      const r = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=30&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,isRead', {
        headers: { Authorization: `Bearer ${access_token}` }
      })
      const data = await r.json()
      if (data.value) setEmails(data.value)
    } catch (e) {
      console.error('Email load error:', e)
    }
    setEmailLoading(false)
  }, [])

  const loadCalendar = useCallback(async () => {
    try {
      const res = await authFetch(`${SUPABASE_FUNCTIONS_URL}/ms-calendar`)
      const data = await res.json()
      if (data.events) setEvents(data.events)
      else if (Array.isArray(data)) setEvents(data)
    } catch (e) {
      console.error('Calendar load error:', e)
    }
  }, [])

  const loadTasks = useCallback(async () => {
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/eisenhower_tasks?select=*&status=neq.done&order=created_at.desc`, {
        headers: { apikey: ANON_KEY }
      })
      const data = await res.json()
      if (Array.isArray(data)) setTasks(data)
    } catch (e) {
      console.error('Tasks load error:', e)
    }
  }, [])

  useEffect(() => {
    loadEmails()
    loadCalendar()
    loadTasks()
  }, [loadEmails, loadCalendar, loadTasks])

  function handleDisconnect() {
    setConnected(false)
    window.location.href = '/'
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0f1117', fontFamily: "'DM Sans', sans-serif" }}>
      {/* Header */}
      <div style={{
        background: '#1a1d27',
        borderBottom: '1px solid #2a2f45',
        padding: '0 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 56
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 28,
            height: 28,
            background: 'linear-gradient(135deg, #3AAFA9, #C9A96E)',
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            fontWeight: 700,
            color: '#fff'
          }}>Q</div>
          <span style={{ fontSize: 15, fontWeight: 600, color: '#e8eaf0' }}>Admin Agent</span>
        </div>

        <div style={{ display: 'flex', gap: 2 }}>
          {(['briefing', 'email', 'matrix', 'chat', 'settings'] as const).map(t => (
            <TabBtn key={t} active={tab === t} onClick={() => setTab(t)}>
              {t === 'briefing' ? '☀ Briefing' :
               t === 'email' ? `✉ Email${emails.length ? ` (${emails.length})` : ''}` :
               t === 'matrix' ? '⊞ Matrix' :
               t === 'chat' ? '✦ Chat' : '⚙ Settings'}
            </TabBtn>
          ))}
        </div>

        <div style={{ fontSize: 12, color: '#6b7280' }}>
          {new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: '24px', maxWidth: 1100, margin: '0 auto' }}>
        {tab === 'briefing' && <BriefingTab events={events} />}
        {tab === 'email' && <EmailTab emails={emails} loading={emailLoading} />}
        {tab === 'matrix' && <MatrixTab tasks={tasks} />}
        {tab === 'chat' && <ChatTab />}
        {tab === 'settings' && <SettingsTab connected={connected} onDisconnect={handleDisconnect} />}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2a2f45; border-radius: 3px; }
      `}</style>
    </div>
  )
}
