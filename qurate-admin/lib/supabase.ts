import { createClient } from '@supabase/supabase-js'

// Falls back to a placeholder URL/key when env vars are missing so that
// `next build` can complete on environments where the real values aren't
// scoped (e.g. Vercel Preview without project-level secrets). Any runtime
// call that actually hits Supabase will fail loudly with a 4xx — that's
// a deliberate trade-off vs. failing the build itself.
const FALLBACK_URL = 'https://localhost.supabase.invalid'
const FALLBACK_KEY = 'placeholder-anon-key'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || FALLBACK_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || FALLBACK_KEY

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  console.warn(
    '[supabase] NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is unset. ' +
    'Using placeholder values — any Supabase call will fail until the real env vars are configured.'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

export const SUPABASE_FUNCTIONS_URL = `${supabaseUrl}/functions/v1`

