import './bottom-nav.css'

export type AppView = 'journal' | 'stats'

export interface BottomNavProps {
  view: AppView
  onChange: (view: AppView) => void
}

/** Packet §09 specifies Journal · Patterns · [+] · Briefing · Profile. Patterns (Epic 4),
 * Briefing (Epic 5) and Profile (Epic 6) don't exist yet and a tab that goes nowhere is worse
 * than no tab, so they arrive with their epics. The [+] capture FAB is not a tab — it floats
 * above this bar, bottom-right, where a thumb already is. */
export function BottomNav({ view, onChange }: BottomNavProps) {
  return (
    <nav className="bottom-nav" aria-label="Main">
      {(
        [
          ['journal', 'Journal'],
          ['stats', 'Stats'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={`bottom-nav__tab${view === id ? ' bottom-nav__tab--active' : ''}`}
          aria-current={view === id ? 'page' : undefined}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </nav>
  )
}
