import { z } from 'zod'

// External USGS OGC v0 contracts: validate the envelope and each useful feature.
// Additional provider fields are deliberately ignored.
export const usgsPageSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.unknown()),
  links: z.array(z.object({ rel: z.string(), href: z.string() })).default([]),
})

export const usgsSeriesFeatureSchema = z.object({
  type: z.literal('Feature'),
  geometry: z.object({
    type: z.literal('Point'),
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  }),
  properties: z.object({
    monitoring_location_id: z.string().regex(/^USGS-\d+$/),
    parameter_code: z.enum(['00010', '00060']),
    computation_identifier: z.literal('Instantaneous'),
    begin_utc: z.string(),
    end_utc: z.string(),
  }),
})

export const usgsReadingFeatureSchema = z.object({
  type: z.literal('Feature'),
  properties: z.object({
    monitoring_location_id: z.string(),
    parameter_code: z.enum(['00010', '00060']),
    time: z.string(),
    value: z.union([z.string(), z.number().finite()]).nullable(),
    unit_of_measure: z.string(),
    approval_status: z.string().nullish(),
  }),
})
