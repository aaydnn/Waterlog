import { z } from 'zod'

// External NOAA NWPS v1 contracts: validate only the fields enrichment reads, and ignore the
// rest of the provider's payload. Same boundary-parsing approach as `usgs.ts`.

/** `pedts` encodes the physical element observed; its second character is 'P' for reservoir pool. */
const pedtsSchema = z.object({
  observed: z.string().nullish(),
  forecast: z.string().nullish(),
})

export const nwpsGaugeSchema = z.object({
  lid: z.string().min(1),
  name: z.string(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  pedts: pedtsSchema.nullish(),
})

/** One point of the observed series. NWPS uses -999 for missing rather than null, so `primary`
 * stays a plain number here and the sentinel is filtered in the adapter. */
const stageflowPointSchema = z.object({
  validTime: z.string(),
  primary: z.number().nullish(),
  secondary: z.number().nullish(),
})

export const nwpsStageflowSchema = z.object({
  observed: z
    .object({
      primaryName: z.string().nullish(), // "Pool" for reservoirs, "Stage" for rivers
      primaryUnits: z.string().nullish(), // "ft"
      data: z.array(stageflowPointSchema).default([]),
    })
    .nullish(),
})
