/** A picture scaled down (never up) to fit max×max on a canvas. Throws when the browser can't decode the file. */
export async function toCanvas(file: Blob, max: number): Promise<HTMLCanvasElement> {
  const probe = await createImageBitmap(file)
  const scale = Math.min(1, max / Math.max(probe.width, probe.height))
  const width = Math.max(1, Math.round(probe.width * scale))
  const height = Math.max(1, Math.round(probe.height * scale))
  probe.close()
  // The browser's own high-quality downscale, rather than one drawImage step from 3000px.
  const img = await createImageBitmap(file, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' })
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')!.drawImage(img, 0, 0)
  img.close()
  return canvas
}

/**
 * The canvas as WebP (transparency kept) of at most limit bytes: a busy picture gets a second, lighter encoding.
 * Throws RangeError when it still doesn't fit (callers say so in words).
 */
// ponytail: browsers that can't encode WebP (older Safari) return PNG; the path still ends .webp, contentType is honest.
export async function encodeImage(canvas: HTMLCanvasElement, limit = 1048576): Promise<Blob> {
  for (const quality of [0.85, 0.6]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', quality))
    if (!blob) break
    if (blob.size <= limit) return blob
  }
  throw new RangeError('Could not encode the image under the size limit')
}

/**
 * A picture as uploaded (logo, ad image, document scan): scaled down to fit max×max and encoded WebP, so the original
 * photo never leaves the phone.
 */
export const resizeImage = async (file: Blob, max = 512): Promise<Blob> => encodeImage(await toCanvas(file, max))

/** Any stored picture as PNG, for downloads (EXPERIENCE.md: anything downloaded is PNG). */
export async function toPng(blob: Blob): Promise<Blob> {
  const img = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  canvas.getContext('2d')!.drawImage(img, 0, 0)
  img.close()
  const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
  if (!png) throw new Error('Could not encode PNG')
  return png
}

/** Downloads a stored picture (a signed URL) as `<name>.png`. Throws when it can't be fetched or decoded. */
export async function downloadAsPng(url: string, name: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const href = URL.createObjectURL(await toPng(await res.blob()))
  const a = document.createElement('a')
  a.href = href
  a.download = `${name}.png`
  a.click()
  setTimeout(() => URL.revokeObjectURL(href), 10000)
}
