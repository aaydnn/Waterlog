# @waterlog/pattern-engine v2

Pure-TypeScript, zero-dependency, zero-I/O pattern engine for WaterLog. The cron consumer feeds it rows; it returns findings, lifecycle records, hypothesis verdicts, experiments, and data-quality questions.

```ts
import { runEngine, buildBriefing, summarizeTrip, toPersisted } from '@waterlog/pattern-engine';

const result = runEngine({ userId, now, trips, conditions, catches, offerings, offeringSessions, previousRecords, hypotheses });
```

| Module | Responsibility (layer) |
|---|---|
| `exposure.ts` | Observation: fishable minutes, pauses, tie-on sessions, catch attribution, data questions |
| `dimensions.ts` | Context: buckets incl. water-temp trajectory, prior rain, flow trend, real-sunset time blocks |
| `analyze.ts` | Discovery math: Mantel–Haenszel rate ratios vs comparable alternatives, dispersion, shrinkage, leave-one-trip-out |
| `family.ts` | Discovery + validation: bounded combo search, BH, tiers, alias collapse, confounders, gaps, "little difference", profiles |
| `lifecycle.ts` | Validation over time: prospective confirmation, F17 decay, retirement, revival, "what changed" |
| `hypotheses.ts` | Beliefs → verdicts; next useful experiment |
| `briefing.ts` | Decision: forecast matching, tie groups, best window, boundary of experience, analogs from both sides |
| `tripLesson.ts` | Explanation: one post-trip lesson |
| `explain.ts` | Deterministic English with `{{offering:id}}`-style tokens the UI resolves |

```
npm test          # 45 tests
npm run coverage  # 99.6% lines / 91.4% branches (spec wants 100% branches — see brief §9)
npm run typecheck
```
