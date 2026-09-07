import type { z } from 'zod'
import { pressureTrendSchema } from '@waterlog/schema'

export type PressureTrend = z.infer<typeof pressureTrendSchema>

const THRESHOLD_HPA = 1.5

/** Packet §07/§08: falling < -1.5 hPa · rising > +1.5 hPa over 6h · else stable. */
export function classifyPressureTrend(hpaNow: number, hpaSixHoursAgo: number): PressureTrend {
  const delta = hpaNow - hpaSixHoursAgo
  if (delta < -THRESHOLD_HPA) return 'falling'
  if (delta > THRESHOLD_HPA) return 'rising'
  return 'stable'
}
