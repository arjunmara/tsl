import { forwardRef } from 'react'
import type { ResultData } from '../../domain/graphics'
import { Classic } from './Classic'
import { Gradient } from './Gradient'
import { Minimal } from './Minimal'
import { Spotlight } from './Spotlight'
import { Split } from './Split'

/**
 * Template × kind → component (Story 5.7 and 5.8): the one place a Graphic's Template is chosen, from the Tournament's `template` carried in its data. A Result has a
 * component per Template; the Player and list kinds (Player.tsx, List.tsx) read data.template for their palette and header. No Graphic stores its Template.
 */
export const Result = forwardRef<HTMLDivElement, { data: ResultData }>(function Result({ data }, ref) {
  const T = { classic: Classic, split: Split, minimal: Minimal, gradient: Gradient, spotlight: Spotlight }[data.template] ?? Classic
  return <T ref={ref} data={data} />
})
