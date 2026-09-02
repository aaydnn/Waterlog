import './app.css'
import { CaptureFlow } from './features/capture/capture-flow'
import { TripBanner } from './features/trips/trip-banner'
import { Wordmark } from './ui/wordmark'

// Epic 1 shell: trip lifecycle + capture flow. Journal/Patterns/Briefing (F3-F9) are later
// epics — no bottom nav yet, there's nothing for it to navigate to.
export function App() {
  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>
          <Wordmark />
        </h1>
      </header>
      <TripBanner />
      <CaptureFlow />
    </main>
  )
}
