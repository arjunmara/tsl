import { forwardRef } from 'react'
import type { ResultData } from '../../domain/graphics'
import { Classic } from './Classic'
import { Minimal } from './Minimal'
import { Split } from './Split'

/**
 * Template × kind → component (Story 5.7): the one place a Graphic's Template is chosen, from the Tournament's `template` carried in its data. A Result has a
 * component per Template; the Player and list kinds (Player.tsx, List.tsx) read data.template for their palette and header. No Graphic stores its Template.
 */
export const Result = forwardRef<HTMLDivElement, { data: ResultData }>(function Result({ data }, ref) {
  return data.template === 'split' ? <Split ref={ref} data={data} /> : data.template === 'minimal' ? <Minimal ref={ref} data={data} /> : <Classic ref={ref} data={data} />
})
