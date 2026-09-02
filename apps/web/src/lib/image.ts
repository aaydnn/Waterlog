const MAX_EDGE = 1600

/** Pure — unit-testable without a browser. Leaves dimensions unchanged when already within the
 * cap; otherwise scales the longest edge down to it, preserving aspect ratio. */
export function computeResizedDimensions(
  width: number,
  height: number,
  maxEdge = MAX_EDGE,
): { width: number; height: number } {
  if (width <= maxEdge && height <= maxEdge) return { width, height }
  const scale = maxEdge / Math.max(width, height)
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

/** Browser-only: draws the captured photo into a canvas at the capped size and re-encodes as
 * JPEG (packet §10: "camera flow with client resize, max 1600px"). Needs a real Canvas/Image
 * decoder, so — like the camera input itself — this isn't unit tested; callers inject a fake for
 * component tests. */
export async function resizeImageToBlob(file: File, maxEdge = MAX_EDGE): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const { width, height } = computeResizedDimensions(bitmap.width, bitmap.height, maxEdge)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  ctx.drawImage(bitmap, 0, 0, width, height)

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas encode failed'))), 'image/jpeg', 0.85)
  })
}
