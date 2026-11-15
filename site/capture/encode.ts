import { execFileSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** One screencast frame on disk and its paint time in ms. */
export type Frame = { file: string; at: number }
/** From `at` (ms) the camera heads to centre cx, cy (frame pixels), zoomed out by `zoom` (>= 1). */
export type CameraKey = { at: number; cx: number; cy: number; zoom: number }
/** A crop of `width` x `height` at zoom 1 that pans and zooms between keys; output keeps that size. */
export type Camera = { width: number; height: number; keys: CameraKey[] }
/**
 * How the loop closes without a jump. `open-on-end`: the video opens on its finished state,
 * then fades into the start (hero). `fade-to-start`: it ends by fading back to its first frame.
 */
export type Loop = 'open-on-end' | 'fade-to-start'

type Options = {
  name: string
  loop: Loop
  /** Output width for whole-window videos; camera videos keep the crop's own size. */
  width?: number | undefined
  camera?: Camera | undefined
  maxBytes?: number | undefined
  /** Writes `<name>-poster.png`, for pages that show a still before the video plays. */
  poster?: boolean | undefined
}

const FPS = 30
const HOLD_S = 2.5
/** Chapters fade back slowly, so what the video added leaves gently. */
const FADE_S: Record<Loop, number> = { 'open-on-end': 0.4, 'fade-to-start': 1 }
const MOVE_MS = 900

const ffmpeg = (...args: string[]): void => {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' })
}

const even = (n: number): number => Math.round(n / 2) * 2
const clamp = (n: number, max: number): number => Math.min(Math.max(n, 0), max)

/** Ease in-out cubic over progress `p`, clamped to the move. */
function ease(p: number): number {
  const t = clamp(p, 1)
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2
}

/** Where the camera is at `t`; each key starts a move from wherever the camera was then. */
function cameraAt(keys: CameraKey[], t: number): CameraKey {
  const toward = (a: CameraKey, b: CameraKey, at: number): CameraKey => {
    const p = ease((at - b.at) / MOVE_MS)
    return { at, cx: a.cx + (b.cx - a.cx) * p, cy: a.cy + (b.cy - a.cy) * p, zoom: a.zoom + (b.zoom - a.zoom) * p }
  }
  let from = keys[0]!
  let to = keys[0]!
  for (const key of keys.slice(1)) {
    if (key.at > t) break
    from = toward(from, to, key.at)
    to = key
  }
  return toward(from, to, t)
}

/** Writes `<name>.mp4` and, unless told not to, `<name>-poster.png`: the video's first frame. */
export function encodeVideo(
  frames: Frame[],
  outDir: string,
  { name, loop, width = 1920, camera, maxBytes = 2_000_000, poster = true }: Options
): void {
  const first = frames[0]!
  const last = frames.at(-1)!
  const dir = path.dirname(first.file)
  // Paint times become per-frame durations; the concat demuxer needs the last file twice.
  const entries = frames.flatMap((frame, i) => {
    const next = frames[i + 1]?.at ?? frame.at + 1000 / FPS
    return [`file '${frame.file}'`, `duration ${(next - frame.at) / 1000}`]
  })
  const list = path.join(dir, 'frames.ffconcat')
  writeFileSync(list, ['ffconcat version 1.0', ...entries, `file '${last.file}'`].join('\n'))
  const seconds = (last.at - first.at) / 1000 + 1 / FPS

  // The still that closes the loop, and the filters that frame it and the recording.
  const still = loop === 'open-on-end' ? last : first
  let view = `scale=${width}:-2:flags=lanczos`
  let stillView = view
  if (camera !== undefined) {
    const png = readFileSync(first.file)
    const [frameWidth, frameHeight] = [png.readUInt32BE(16), png.readUInt32BE(20)]
    // The crop grows with the zoom and is scaled back down, so the output size never changes.
    const at = (t: number) => {
      const { cx, cy, zoom } = cameraAt(camera.keys, t)
      const w = Math.min(even(camera.width * zoom), frameWidth)
      const h = Math.min(even(camera.height * zoom), frameHeight)
      return { w, h, x: even(clamp(cx - w / 2, frameWidth - w)), y: even(clamp(cy - h / 2, frameHeight - h)) }
    }
    const moves: string[] = []
    let last = ''
    for (let k = 0; k / FPS <= seconds; k++) {
      const { w, h, x, y } = at(first.at + (k * 1000) / FPS)
      const move = `crop@cam w ${w}, crop@cam h ${h}, crop@cam x ${x}, crop@cam y ${y}`
      if (move !== last) moves.push(`${(k / FPS).toFixed(4)} ${move};`)
      last = move
    }
    const commands = path.join(dir, 'camera.cmd')
    writeFileSync(commands, moves.join('\n'))
    const size = `${even(camera.width)}:${even(camera.height)}:flags=lanczos`
    const start = at(first.at)
    const rest = at(still.at)
    view = `sendcmd=f=${commands},crop@cam=${start.w}:${start.h}:${start.x}:${start.y},scale=${size}`
    stillView = `crop=${rest.w}:${rest.h}:${rest.x}:${rest.y},scale=${size}`
  }

  const prep = (filter: string) =>
    `fps=${FPS},${filter},scale=out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p,settb=AVTB`
  const fade = FADE_S[loop]
  const join =
    loop === 'open-on-end'
      ? `[still][rec]xfade=transition=fade:duration=${fade}:offset=${HOLD_S}[v]`
      : `[rec][still]xfade=transition=fade:duration=${fade}:offset=${(seconds - fade).toFixed(3)}[v]`
  const stillSeconds = loop === 'open-on-end' ? HOLD_S + fade : fade
  const video = path.join(outDir, `${name}.mp4`)
  ffmpeg(
    ...['-f', 'concat', '-safe', '0', '-i', list],
    ...['-loop', '1', '-framerate', String(FPS), '-t', String(stillSeconds), '-i', still.file],
    ...['-filter_complex', `[0]${prep(view)}[rec];[1]${prep(stillView)}[still];${join}`],
    ...['-map', '[v]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p'],
    ...['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'],
    ...['-movflags', '+faststart', '-an', video]
  )
  if (poster) ffmpeg('-i', still.file, '-vf', stillView, '-frames:v', '1', path.join(outDir, `${name}-poster.png`))

  const bytes = statSync(video).size
  if (bytes > maxBytes) throw new Error(`${name}.mp4 is ${bytes} bytes, over the ${maxBytes} budget`)
}
