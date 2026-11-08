// Server-corrected time: the offset from the Date header of the latest Supabase response.
// No readable header (or none yet) means offset 0.
let offset = 0

export function noteServerDate(res: Response) {
  const t = Date.parse(res.headers.get('date') ?? '')
  if (!Number.isNaN(t)) offset = t - Date.now()
}

export const serverNow = () => new Date(Date.now() + offset)
