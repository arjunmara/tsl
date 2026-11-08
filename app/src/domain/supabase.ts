import { createClient } from '@supabase/supabase-js'
import { supabasePublishableKey, supabaseUrl } from './env'

// The one Supabase client. Without a configured database it points nowhere, so calls fail as offline.
export const supabase = createClient(supabaseUrl || 'https://no-database.invalid', supabasePublishableKey || 'none')
