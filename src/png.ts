import { deflateSync, inflateSync } from 'node:zlib'

/**
 * Zero-dependency PNG support: decode, encode, crop and pixel-diff, used by region
 * screenshots and by the screenshot baseline comparison. No I/O - callers own the files.
 */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** One decoded PNG: 8-bit RGB(A) pixels, row-major, unfiltered. */
export interface DecodedPng { width: number; height: number; channels: number; pixels: Buffer }

/** Paeth predictor, straight from the PNG spec. */
export function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * Decode a PNG far enough to compare pixels. `devecocli ui screenshot` writes one shape —
 * 1320x2856, 8 bit, colorType 6 (RGBA), interlace 0, filter 0 — and Node's zlib does the inflate, so
 * this stays dependency-free. Anything outside that shape is refused by name rather than guessed at.
 */
export function decodePng(file: Buffer): DecodedPng {
  const data = Buffer.isBuffer(file) ? file : Buffer.from(file)
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('不是 PNG(签名不符)')
  let offset = 8
  let header: { width: number; height: number; depth: number; color: number; interlace: number } | null = null
  const idat: Buffer[] = []
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset)
    const type = data.subarray(offset + 4, offset + 8).toString('ascii')
    const chunk = data.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      header = { width: chunk.readUInt32BE(0), height: chunk.readUInt32BE(4), depth: chunk[8], color: chunk[9], interlace: chunk[12] }
    } else if (type === 'IDAT') idat.push(chunk)
    else if (type === 'IEND') break
  }
  if (!header) throw new Error('PNG 缺少 IHDR')
  if (header.depth !== 8) throw new Error(`PNG 位深 ${header.depth} 不支持(只处理 8 位)`)
  if (header.interlace !== 0) throw new Error('PNG 是隔行(interlace)编码,不支持')
  const channels = header.color === 6 ? 4 : header.color === 2 ? 3 : 0
  if (channels === 0) throw new Error(`PNG 颜色类型 ${header.color} 不支持(只处理 RGB/RGBA)`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = header.width * channels
  if (raw.length < header.height * (stride + 1)) throw new Error('PNG 数据不完整')
  const pixels = Buffer.alloc(header.height * stride)
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1)
    const start = y * stride
    const above = start - stride
    for (let i = 0; i < stride; i += 1) {
      const byte = line[i]
      const left = i >= channels ? pixels[start + i - channels] : 0
      const up = y > 0 ? pixels[above + i] : 0
      const upLeft = y > 0 && i >= channels ? pixels[above + i - channels] : 0
      const value = filter === 0 ? byte
        : filter === 1 ? byte + left
          : filter === 2 ? byte + up
            : filter === 3 ? byte + ((left + up) >> 1)
              : filter === 4 ? byte + paeth(left, up, upLeft)
                : NaN
      if (Number.isNaN(value)) throw new Error(`PNG 行过滤类型 ${filter} 不支持`)
      pixels[start + i] = value & 0xff
    }
  }
  return { width: header.width, height: header.height, channels, pixels }
}

/** CRC32 table for PNG chunks, built once. */
export const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** One PNG chunk: length, type, body, CRC over type+body. */
export function pngChunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

/**
 * Encode 8-bit RGB/RGBA pixels as a PNG, filter 0 on every row. The mirror of `decodePng`, and the
 * The one thing a region capture needs: devecocli has no crop option, so a region capture means cutting the
 * bitmap locally — which needs a way to write it back out. Deflate comes from `node:zlib`, so this
 * stays dependency-free like the decoder.
 */
export function encodePng(image: DecodedPng): Buffer {
  const { width, height, channels, pixels } = image
  if (channels !== 3 && channels !== 4) throw new Error(`无法编码 ${channels} 通道(只处理 RGB/RGBA)`)
  if (width <= 0 || height <= 0) throw new Error(`无法编码 ${width}x${height} 的图`)
  const stride = width * channels
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Cut a rectangle out of a decoded PNG, clamped to the image bounds. Returns the rectangle actually
 * used (`clamped: true` when it differs from the request), so a partly off-screen request is
 * reported rather than silently producing a different picture.
 */
export function cropPng(image: DecodedPng, rect: { x: number; y: number; w: number; h: number }): { image: DecodedPng; rect: { x: number; y: number; w: number; h: number }; clamped: boolean } {
  const asked = { x: Math.floor(rect.x), y: Math.floor(rect.y), w: Math.floor(rect.w), h: Math.floor(rect.h) }
  // All four edges intersect the image. Clamping the origin on its own would slide the rectangle and pick
  // up pixels from the far side — `{x: -3, w: 5}` would answer 5 columns where only 3 are on screen — and
  // report the same `clamped` as a harmless narrowing.
  const left = Math.max(0, Math.min(image.width, asked.x))
  const top = Math.max(0, Math.min(image.height, asked.y))
  const right = Math.max(left, Math.min(image.width, asked.x + asked.w))
  const bottom = Math.max(top, Math.min(image.height, asked.y + asked.h))
  const x = left
  const y = top
  const w = Math.max(1, right - left)
  const h = Math.max(1, bottom - top)
  const clamped = x !== asked.x || y !== asked.y || w !== asked.w || h !== asked.h
  const stride = image.width * image.channels
  const rowBytes = w * image.channels
  const out = Buffer.alloc(h * rowBytes)
  for (let row = 0; row < h; row += 1) {
    const from = (y + row) * stride + x * image.channels
    image.pixels.copy(out, row * rowBytes, from, from + rowBytes)
  }
  return { image: { width: w, height: h, channels: image.channels, pixels: out }, rect: { x, y, w, h }, clamped }
}

/**
 * Pixel difference between two captures, as the fraction of pixels whose channels differ at all.
 * Two captures of an unchanged screen are byte-identical , so callers get `same` from a
 * byte compare and never reach this function on the cheap path; it exists for the other case, where
 * "did that colour change actually land on screen, and how much" has to be a number rather than a
 * 268 KB image read into context.
 */
export function diffPng(before: DecodedPng, after: DecodedPng, tolerance = 0): { same: boolean; diffRatio: number; changedPixels: number; totalPixels: number } {
  const total = before.width * before.height
  if (before.width !== after.width || before.height !== after.height || before.channels !== after.channels) {
    return { same: false, diffRatio: 1, changedPixels: total, totalPixels: total }
  }
  let changed = 0
  for (let i = 0; i < before.pixels.length; i += before.channels) {
    for (let c = 0; c < before.channels; c += 1) {
      if (Math.abs(before.pixels[i + c] - after.pixels[i + c]) > tolerance) { changed += 1; break }
    }
  }
  return { same: changed === 0, diffRatio: Number((changed / total).toFixed(6)), changedPixels: changed, totalPixels: total }
}

