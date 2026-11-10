/**
 * A picture as uploaded (logo, ad image, document scan): scaled down (never up) to fit max×max and encoded WebP, so the
 * original photo never leaves the phone. Throws when the browser can't decode the file.
 */
// ponytail: browsers that can't encode WebP (older Safari) return PNG; the path still ends .webp, contentType is honest.
export async function resizeImage(file: Blob, max = 512): Promise<Blob> {
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
  // The bucket takes at most 1 MiB: a busy photo at the larger ad size gets a second, lighter encoding.
  for (const quality of [0.85, 0.6]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', quality))
    if (!blob) break
    if (blob.size <= 1048576) return blob
  }
  // RangeError: readable, but too detailed to fit (callers say so in words).
  throw new RangeError('Could not encode the image under 1 MiB')
}
