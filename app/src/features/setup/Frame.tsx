import type { ReactNode } from 'react'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'

export const STEPS = ['Name & logo', 'Description & rules', 'Dates', 'Format', 'Line-up rules', 'Structure', 'Sponsors']

/** The wizard frame: "Step n of 7 · Name", a thin bar of the steps finished before this one, and the fixed Back / Next bar. */
export function Frame({ step, onBack, onNext, children }: { step: number; onBack: () => void; onNext?: () => void; children: ReactNode }) {
  return (
    <main className="wizard">
      <h1 className="title">Step {step} of 7 · {STEPS[step - 1]}</h1>
      <div className="wizard-progress" aria-hidden="true">
        <div style={{ width: `${((step - 1) / 7) * 100}%` }} />
      </div>
      {children}
      <div className="wizard-bar">
        <div className="wizard-bar-inner">
          <SecondaryButton label="Back" onClick={onBack} />
          {onNext && <PrimaryButton label="Next" onClick={onNext} />}
        </div>
      </div>
    </main>
  )
}
