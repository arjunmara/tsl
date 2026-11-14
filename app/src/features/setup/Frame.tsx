import { createContext, useContext, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { messages } from '../../domain/messages'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'

export const STEPS = ['Name & logo', 'Description & rules', 'Dates', 'Format', 'Line-up rules', 'Structure', 'Sponsors']

/** True when a wizard step is shown as a Settings section: no Next, no step progress, Back returns to Settings. */
export const SettingsMode = createContext(false)
/** True once the Season has started: steps 2 to 6 (rules, dates, Format, Line-up rules, Structure) lock, but the description in step 2 saves; name, logo and Sponsors stay open. */
export const SeasonStarted = createContext(false)

/** Where Back goes from this step: the previous step (step 1: My tournaments), or Settings in a Settings section. */
export function useLeave(tournamentId: string, step: number) {
  const navigate = useNavigate()
  const settings = useContext(SettingsMode)
  // Opened from the Settings list (pushed): step back to it, so the browser's Back doesn't find a second copy.
  const fromList = (useLocation().state as { fromList?: boolean } | null)?.fromList
  return () => (settings && fromList ? navigate(-1) : navigate(settings ? `/t/${tournamentId}/settings` : step === 1 ? '/' : `/t/${tournamentId}/setup/${step - 1}`, { replace: true }))
}

/**
 * The wizard frame: "Step n of 7 · Name", a thin bar of the steps finished before this one, and the fixed Back / Next bar.
 * In a Settings section: "Settings · Name" and only "Back to settings"; Enter never submits (each field saves when left).
 * backLabel and nextLabel replace "Back" / "Back to settings" and "Next" (step 7's "Finish setup", its editor's "Back to Sponsors").
 */
export function Frame({ step, onBack, onNext, backLabel, nextLabel = 'Next', children }: {
  step: number; onBack: () => void; onNext?: () => void; backLabel?: string; nextLabel?: string; children: ReactNode
}) {
  const settings = useContext(SettingsMode)
  const locked = useContext(SeasonStarted) && step >= 2 && step <= 6
  // Step 2 stays open for the description alone (its rules and consent statement lock inside the step).
  const wholeStep = locked && step !== 2
  if (settings) {
    return (
      <main className="wizard" onSubmitCapture={(e) => (e.preventDefault(), e.stopPropagation())}>
        <h1 className="title">Settings · {STEPS[step - 1]}</h1>
        {locked && <p className="body">{step === 2 ? messages.rules_locked : messages.season_started}</p>}
        <fieldset disabled={wholeStep} className="wizard-fields">{children}</fieldset>
        <div className="wizard-bar">
          <div className="wizard-bar-inner">
            <SecondaryButton label={backLabel ?? 'Back to settings'} onClick={onBack} />
          </div>
        </div>
      </main>
    )
  }
  return (
    <main className="wizard">
      <h1 className="title">Step {step} of 7 · {STEPS[step - 1]}</h1>
      <div className="wizard-progress" aria-hidden="true">
        <div style={{ width: `${((step - 1) / 7) * 100}%` }} />
      </div>
      {children}
      <div className="wizard-bar">
        <div className="wizard-bar-inner">
          <SecondaryButton label={backLabel ?? 'Back'} onClick={onBack} />
          {onNext && <PrimaryButton label={nextLabel} onClick={onNext} />}
        </div>
      </div>
    </main>
  )
}
