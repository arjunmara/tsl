import { createClient } from '@supabase/supabase-js'
import { supabasePublishableKey, supabaseUrl } from './env'

const page = location.pathname.replace(/\/+$/, '')
/** True on a Registration link page (/register#<token>), which never leads to another route. */
export const onRegistrationLink = page === '/register'
/** True on the Scorer page (/score#<token>): the same, with its own anonymous session. */
const onScorerLink = page === '/score' || page.startsWith('/score/')

// The one Supabase client. Without a configured database it points nowhere, so calls fail as offline. A Registration
// link page keeps its anonymous Team-manager session under its own key (a Scorer page likewise), so it never mixes with an Organiser's session
// on the same phone (each page load picks its key; no route links from one to the other).
export const supabase = createClient(supabaseUrl || 'https://no-database.invalid', supabasePublishableKey || 'none',
  onRegistrationLink ? { auth: { storageKey: 'tsl-register-auth' } } : onScorerLink ? { auth: { storageKey: 'tsl-score-auth' } } : undefined)
