import type { ImageSegmenter } from '@mediapipe/tasks-vision'
import { encodeImage } from './image'

/** The person's confidence (0–1) for each pixel of the canvas, row by row. */
export type Segment = (canvas: HTMLCanvasElement) => Promise<Float32Array>

// Self-hosted (AD-9): the wasm is copied from the package at build time (`prebuild`), the model is in public/mediapipe.
const base = `${import.meta.env.BASE_URL}mediapipe`
let segmenter: Promise<ImageSegmenter> | null = null

/** MediaPipe selfie_segmenter, loaded on first use only (the library, its wasm and the model), then kept. */
const mediapipe: Segment = async (canvas) => {
  segmenter ??= (async () => {
    const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision')
    const files = await FilesetResolver.forVisionTasks(base)
    // CPU: the GPU delegate scrambles masks on some iPhones (architecture review, AD-9).
    return ImageSegmenter.createFromOptions(files, {
      baseOptions: { modelAssetPath: `${base}/selfie_segmenter.tflite`, delegate: 'CPU' },
      runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
    })
  })()
  let s: ImageSegmenter
  try {
    s = await segmenter
  } catch (e) {
    segmenter = null // a failed load (offline) is tried again next time
    throw e
  }
  const result = s.segment(canvas)
  try {
    const masks = result.confidenceMasks ?? []
    // The person mask: the only one, or the second when the model also gives the background.
    const mask = masks[masks.length > 1 ? 1 : 0]
    if (!mask) throw new Error('No mask')
    return mask.getAsFloat32Array().slice()
  } finally {
    result.close()
  }
}

/**
 * The canvas with its background removed, as a transparent WebP of at most limit bytes. Throws when segmentation fails
 * or finds no clear person (almost nothing, or almost everything, kept): the card then offers Try again / Keep.
 * Checks stub the model with window.tslSegment, so CI never downloads it.
 */
export async function removeBackground(canvas: HTMLCanvasElement, limit: number): Promise<Blob> {
  const segment = (window as { tslSegment?: Segment }).tslSegment ?? mediapipe
  const mask = await segment(canvas)
  const { width, height } = canvas
  if (mask.length !== width * height) throw new Error('Mask size differs')
  const share = mask.reduce((n, v) => n + (v > 0.5 ? 1 : 0), 0) / mask.length
  if (share < 0.03 || share > 0.97) throw new Error('No clear person')
  const out = document.createElement('canvas')
  out.width = width
  out.height = height
  const g = out.getContext('2d')!
  g.drawImage(canvas, 0, 0)
  const px = g.getImageData(0, 0, width, height)
  for (let i = 0; i < mask.length; i++) px.data[i * 4 + 3] = Math.round(mask[i]! * px.data[i * 4 + 3]!)
  g.putImageData(px, 0, 0)
  return encodeImage(out, limit)
}
