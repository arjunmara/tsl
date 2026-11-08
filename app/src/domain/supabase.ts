import { createClient } from '@supabase/supabase-js'
import { noteServerDate } from './clock'
import { supabasePublishableKey, supabaseUrl } from './env'

// Every response sets the server clock offset (clock.ts).
const clockFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init)
  noteServerDate(res)
  return res
}

// The one Supabase client. Without a configured database it points nowhere, so calls fail as offline.
export const supabase = createClient(supabaseUrl || 'https://no-database.invalid', supabasePublishableKey || 'none', {
  global: { fetch: clockFetch },
})
