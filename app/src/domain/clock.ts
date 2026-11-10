import { supabase } from './supabase'

// Server-corrected time: the offset from app.server_now(), asked at app start, when the signal comes back
// and when the page is shown again, taking the round trip's midpoint. Until an answer arrives (or when none
// ever does) the offset is 0. A failed call keeps the last offset.
let offset = 0
let asked = 0
let applied = 0
const MAX_ROUND_TRIP = 5000

export async function syncClock() {
  const n = ++asked
  try {
    const sent = Date.now()
    const { data, error } = await supabase.schema('app').rpc('server_now')
    const back = Date.now()
    const t = Date.parse(String(data))
    // A slow answer says little about the clock; an older answer never overwrites a newer one.
    if (error || Number.isNaN(t) || back - sent > MAX_ROUND_TRIP || n < applied) return
    applied = n
    offset = t - (sent + back) / 2
  } catch {
    // Keep the last offset.
  }
}

export const serverNow = () => new Date(Date.now() + offset)
