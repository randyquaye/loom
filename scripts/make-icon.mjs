// Renders the Loom weave mark to resources/icon.png (1024x1024) — electron-builder's
// buildResources dir per electron-builder.yml — so it can derive the macOS icns.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { deflateSync } from 'node:zlib'

const SIZE = 1024
const S = SIZE / 24
const BG = [23, 23, 26]
const MARK = [228, 228, 231]

const verticals = [
  [6, 3, 10.2],
  [6, 13.8, 21],
  [12, 3, 4.2],
  [12, 7.8, 16.2],
  [12, 19.8, 21],
  [18, 3, 10.2],
  [18, 13.8, 21]
]
const horizontals = [
  [6, 3, 4.2],
  [6, 7.8, 16.2],
  [6, 19.8, 21],
  [12, 3, 10.2],
  [12, 13.8, 21],
  [18, 3, 4.2],
  [18, 7.8, 16.2],
  [18, 19.8, 21]
]
const rects = [
  ...verticals.map(([x, y1, y2]) => [(x - 1) * S, (y1 - 1) * S, (x + 1) * S, (y2 + 1) * S]),
  ...horizontals.map(([y, x1, x2]) => [(x1 - 1) * S, (y - 1) * S, (x2 + 1) * S, (y + 1) * S])
]

const pixels = Buffer.alloc(SIZE * SIZE * 3)
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const inside = rects.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1)
    const [r, g, b] = inside ? MARK : BG
    const o = (y * SIZE + x) * 3
    pixels[o] = r
    pixels[o + 1] = g
    pixels[o + 2] = b
  }
}

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8
ihdr[9] = 2
const stride = SIZE * 3 + 1
const raw = Buffer.alloc(SIZE * stride)
for (let y = 0; y < SIZE; y += 1) {
  raw[y * stride] = 0
  pixels.copy(raw, y * stride + 1, y * SIZE * 3, (y + 1) * SIZE * 3)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])
const target = path.join(process.cwd(), 'resources', 'icon.png')
await mkdir(path.dirname(target), { recursive: true })
await writeFile(target, png)
console.log(`wrote ${target} (${png.length} bytes)`)
