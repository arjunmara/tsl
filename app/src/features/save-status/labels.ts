// Plain words for each command in the waiting-changes list. Every new command adds an entry.
type Args = Record<string, unknown>

export const commandLabels: Record<string, (args: Args) => string> = {
  create_tournament: (a) => `Create tournament ‘${String(a.name ?? '')}’`,
  discard_command: () => 'Discard a change that was refused',
}

export const labelFor = (name: string, args: Args) => commandLabels[name]?.(args) ?? 'A change'

/** Words for a command's fields in the hand-back sheet's "Your change" / "Their version" columns; else the field name. */
export const fieldLabels: Record<string, string> = {
  name: 'Name',
}
