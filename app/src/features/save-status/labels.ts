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
  // Preset keys are their labels in lower case (futsal → Futsal, 7-a-side).
  set_match_settings: (a) => (a.format_preset != null
    ? `Change the format to ${String(a.format_preset).replace(/^./, (c) => c.toUpperCase())}` : 'Change the Match settings'),
  set_lineup_rules: () => 'Change the Line-up rules',
  // The tie-break list sends its order on its own.
  set_structure: (a) => (a.tiebreaks != null ? 'Change the tie-break order' : 'Change the Structure'),
  add_sponsor: (a) => `Add Sponsor ‘${String(a.caption ?? '')}’`,
  edit_sponsor: (a) => (a.caption != null ? `Change a Sponsor's caption to ‘${String(a.caption)}’`
    : a.logo_path != null ? "Change a Sponsor's logo" : "Change a Sponsor's ad images"),
  delete_sponsor: () => 'Delete a Sponsor',
  reorder_sponsors: () => 'Change the Sponsor order',
  invite_organiser: (a) => `Invite ${String(a.email ?? '')} to organise the tournament`,
  cancel_invite: () => 'Cancel an invite',
  accept_invite: () => 'Accept an invite to organise a tournament',
  remove_organiser: () => 'Remove an organiser',
  add_team: (a) => `Add Team ‘${String(a.name ?? '')}’`,
  open_registration: () => 'Open registration',
  revoke_registration_link: () => 'Revoke a Registration link',
  reissue_registration_link: () => 'Make a new Registration link',
  edit_team: (a) => (a.name != null ? `Rename the Team to ‘${String(a.name)}’`
    : a.code != null ? `Change the Team code to ${String(a.code)}` : 'Change the kit colour'),
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
  format_preset: 'Format preset',
  periods: 'Periods',
  period_minutes: 'Minutes per period',
  clock: 'Clock',
  half_time_minutes: 'Half-time (minutes)',
  extra_time: 'Extra time',
  extra_time_periods: 'Extra-time periods',
  extra_time_minutes: 'Minutes per extra-time period',
  shootout: 'Shootout',
  substitutions: 'Substitutions',
  max_substitutions: 'Maximum substitutions',
  foul_warning: 'Accumulated-foul warning',
  timeouts_per_period: 'Timeouts per team per period',
  power_play_minutes: 'Power play (minutes)',
  starters: 'Starters',
  max_bench: 'Maximum bench',
  staff_roles: 'Allowed Staff roles',
  structure: 'Structure',
  group_count: 'Number of groups',
  teams_per_group: 'Teams per group',
  qualifiers_per_group: 'Qualifiers per group',
  points_win: 'Points for a win',
  points_draw: 'Points for a draw',
  points_loss: 'Points for a loss',
  tiebreaks: 'Tie-breaks',
  caption: 'Caption',
  ad_paths: 'Ad images',
  code: 'Team code',
  kit_colour: 'Kit colour',
}
