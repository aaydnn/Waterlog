export type Season = 'winter' | 'spring' | 'summer' | 'fall'

const NORTHERN_HEMISPHERE_SEASON_BY_MONTH: Season[] = [
  'winter', // Jan
  'winter', // Feb
  'spring', // Mar
  'spring', // Apr
  'spring', // May
  'summer', // Jun
  'summer', // Jul
  'summer', // Aug
  'fall', // Sep
  'fall', // Oct
  'fall', // Nov
  'winter', // Dec
]

const OPPOSITE: Record<Season, Season> = { winter: 'summer', summer: 'winter', spring: 'fall', fall: 'spring' }

/** Meteorological (month-banded) season, hemisphere-aware per packet §08 — southern-hemisphere
 * anglers get the opposite season for the same calendar month. */
export function seasonFor(date: Date, lat: number | null): Season {
  const month = date.getUTCMonth() // 0-11
  const northern = NORTHERN_HEMISPHERE_SEASON_BY_MONTH[month]!
  return lat !== null && lat < 0 ? OPPOSITE[northern] : northern
}
