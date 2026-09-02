import { CaptureFlow } from './features/capture/capture-flow'
import { TripBanner } from './features/trips/trip-banner'

// Epic 1 shell: trip lifecycle + capture flow. Journal/Patterns/Briefing (F3-F9) are later
// epics — no bottom nav yet, there's nothing for it to navigate to.
export function App() {
  return (
    <main style={{ padding: '1rem' }}>
      <h1>WaterLog</h1>
      <TripBanner />
      <CaptureFlow />
    </main>
  )
}
