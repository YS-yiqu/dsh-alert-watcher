// Decode DSH session artifacts. A `.jsonl.zstd` session file is a *sequence of
// independently decodable zstd frames* (one per durable batch), so a single
// zstdDecompressSync call only yields the first record. Frame boundaries are
// located structurally by copying the scanner from
// @deepseek-ai/dsh-session-persistence-jsonl (not exported publicly).
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 4247762216

export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/** Decode every complete frame of one session artifact into plaintext. */
export function decodeSessionFile(file) {
  const bytes = readFileSync(file)
  const { frames, tornStart } = scanZstdFrames(bytes)
  const parts = []
  for (const frame of frames) {
    try {
      parts.push(zstdDecompressSync(bytes.subarray(frame.start, frame.end)))
    } catch (error) {
      parts.push(Buffer.from(`\n{"type":"decode-error","message":${JSON.stringify(error.message)}}\n`))
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: frames.length, tornStart }
}

if (import.meta.main) {
  const file = process.argv[2]
  const { text, frames, tornStart } = decodeSessionFile(file)
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  console.log(`file frames: ${frames}, tornStart: ${tornStart ?? 'none'}, plaintext chars: ${text.length}, records: ${lines.length}`)
  const types = {}
  for (const line of lines) {
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    types[rec.type ?? 'no-type'] = (types[rec.type ?? 'no-type'] ?? 0) + 1
  }
  console.log('record types:', JSON.stringify(types, null, 2))
  const seen = new Set()
  for (const line of lines) {
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (seen.has(rec.type)) continue
    seen.add(rec.type)
    console.log(`\n[${rec.type}] keys=${Object.keys(rec).join(',')}`)
    console.log(line.slice(0, 900))
  }
  if (process.argv[3]) writeFileSync(process.argv[3], text)
}
