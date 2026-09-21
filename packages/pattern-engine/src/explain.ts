import type { BucketStats, OutcomeKey } from './types';

/* Deterministic English. Tokens like {{offering:ID}}, {{water:ID}}, {{species:slug}} are resolved by the
 * UI from the user's own records — the engine never sees names, and an LLM never writes the numbers. */

const TITLE: Record<string, Record<string, string>> = {
  sky: { clear: 'clear skies', partly: 'partly cloudy skies', overcast: 'overcast skies' },
  wind: { calm: 'calm wind', light: 'light wind', strong: 'strong wind' },
  water_temp_trend: { warming: 'warming water', cooling: 'cooling water', steady: 'steady water temperature' },
  rain_prev_48h: { dry: 'a dry 48 hours', some_rain: 'rain in the prior 48 hours', heavy_rain: 'heavy rain in the prior 48 hours' },
  flow_trend: { falling: 'falling flow', rising: 'rising flow', stable: 'stable flow' },
  moon: { new: 'the new moon', first_quarter: 'the first-quarter moon', full: 'the full moon', last_quarter: 'the last-quarter moon' },
  time_block: { dawn: 'dawn', morning: 'morning', midday: 'midday', evening: 'evening', dusk: 'dusk', night: 'night' },
};

export function bucketPhrase(dimension: string, bucket: string): string {
  if (dimension.includes('+')) {
    const dims = dimension.split('+');
    const parts = bucket.split('|');
    return dims.map((d, i) => bucketPhrase(d, parts[i] ?? '')).join(' + ');
  }
  const pretty = bucket.replace(/_/g, ' ');
  switch (dimension) {
    case 'offering_family':
      return `${pretty}s`;
    case 'offering_color':
      return `${pretty} lures`;
    case 'offering':
      return `{{offering:${bucket}}}`;
    case 'pressure_trend':
      return `${pretty} pressure`;
    case 'water_temp':
      return `water at ${bucket.replace('-', '–').replace('c', '°C')}`;
    case 'season':
      return pretty;
    case 'water_body':
      return `{{water:${bucket}}}`;
    default:
      return TITLE[dimension]?.[bucket] ?? pretty;
  }
}

export function outcomePrefix(outcome: OutcomeKey): string {
  if (outcome === 'all') return '';
  if (outcome === 'quality') return 'Bigger fish — ';
  return `{{species:${outcome.slice('species:'.length)}}} — `;
}

const fmt = (x: number) => (x >= 10 ? x.toFixed(0) : x.toFixed(1));

export function findingSummary(outcome: OutcomeKey, s: BucketStats): string {
  const phrase = bucketPhrase(s.dimension, s.bucket);
  const trips = `${s.exposedTrips} trip${s.exposedTrips === 1 ? '' : 's'}`;
  if (s.catches === 0) {
    return `${outcomePrefix(outcome)}No fish in ${fmt(s.hours)} hrs of ${phrase} across ${trips} (you'd normally expect about ${fmt(s.expected)}).`;
  }
  return `${outcomePrefix(outcome)}${phrase[0]!.toUpperCase()}${phrase.slice(1)} → ${s.multiplier.toFixed(1)}x your comparable rate (${s.catches} fish over ${fmt(s.hours)} hrs, ${trips}).`;
}
