// Plain words for each command in the waiting-changes list. Every new command adds an entry.
type Args = Record<string, unknown>

export const commandLabels: Record<string, (args: Args) => string> = {
  create_tournament: (a) => `Create tournament ‘${String(a.name ?? '')}’`,
}

export const labelFor = (name: string, args: Args) => commandLabels[name]?.(args) ?? 'A change'
