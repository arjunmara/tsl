// Plain words for each command in the waiting-changes list. Every new command adds an entry.
type Args = Record<string, unknown>

export const commandLabels: Record<string, (args: Args) => string> = {
  create_tournament: (a) => `Create tournament ‘${String(a.name ?? '')}’`,
  discard_command: () => 'Discard a change that was refused',
  set_tournament_branding: (a) =>
    a.name != null ? `Rename tournament to ‘${String(a.name)}’`
      : a.logo_path === '' ? 'Remove the tournament logo'
        : a.logo_path != null ? 'Change the tournament logo'
          : a.brand_primary != null ? 'Change the main colour'
            : a.brand_secondary != null ? 'Change the second colour' : 'Change the tournament',
  set_setup_step: (a) => `Finish setup step ${String(a.step ?? '')}`,
  set_season_rules: (a) => `Change the season's ${changed(a)}`,
  set_season_dates: () => 'Change the season dates',
}

/** "rules", "description and rules": the fields an edit changes, in words. */
function changed(a: Args) {
  const words = Object.keys(fieldLabels).filter((k) => a[k] != null).map((k) => fieldLabels[k]!.toLowerCase())
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0] ?? 'details'
}

export const labelFor = (name: string, args: Args) => commandLabels[name]?.(args) ?? 'A change'

/** Words for a command's fields in the hand-back sheet's "Your change" / "Their version" columns; else the field name. */
export const fieldLabels: Record<string, string> = {
  name: 'Name',
  brand_primary: 'Main colour',
  brand_secondary: 'Second colour',
  logo_path: 'Logo',
  description: 'Description',
  rules: 'Rules',
  photo_consent: 'Photo-consent statement',
  starts_on: 'Season starts',
  ends_on: 'Season ends',
  registration_deadline: 'Registration deadline',
}
