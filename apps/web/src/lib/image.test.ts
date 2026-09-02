import { describe, expect, it } from 'vitest'
import { computeResizedDimensions } from './image'

describe('computeResizedDimensions', () => {
  it('leaves an already-small image unchanged', () => {
    expect(computeResizedDimensions(800, 600)).toEqual({ width: 800, height: 600 })
  })

  it('leaves an image exactly at the cap unchanged', () => {
    expect(computeResizedDimensions(1600, 1200)).toEqual({ width: 1600, height: 1200 })
  })

  it('scales a landscape image down by its width', () => {
    expect(computeResizedDimensions(3200, 2400)).toEqual({ width: 1600, height: 1200 })
  })

  it('scales a portrait image down by its height', () => {
    expect(computeResizedDimensions(2400, 3200)).toEqual({ width: 1200, height: 1600 })
  })

  it('scales a square image down by either edge', () => {
    expect(computeResizedDimensions(4000, 4000)).toEqual({ width: 1600, height: 1600 })
  })

  it('honors a custom max edge', () => {
    expect(computeResizedDimensions(2000, 1000, 800)).toEqual({ width: 800, height: 400 })
  })
})
