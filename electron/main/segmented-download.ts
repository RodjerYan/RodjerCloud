import { Api } from 'telegram'
import bigInt from 'big-integer'
import * as crypto from 'crypto'

// Configuration constants
export const SEG_FETCH_CONCURRENCY = 2
export const SEG_SEGMENT_SIZE = 8 * 1024 * 1024 // 8MB segments (each worker streams one segment)
export const SEG_CHUNK_SIZE = 512 * 1024 // 512KB chunk size for iterDownload requestSize
export const SEG_MAX_BUFFERED_SEGMENTS = SEG_FETCH_CONCURRENCY * 2 // max segments ahead of nextExpectedSegment
// A/B result: 2 workers / 8MB segments / 512KB chunks → median 7.80 MB/s, 0 FloodWait
// vs 4 workers / 4MB / 512KB → median 7.32 MB/s, 15 FloodWait. 2 workers wins on median + API load.

export interface SegmentedDownloadOptions {
  client: any // TelegramClient
  file: any // InputDocument / InputDocumentFileLocation
  partStart: number // absolute file offset of this part
  partEnd: number // absolute file offset (inclusive) of this part
  reqStart: number // requested range start (absolute)
  reqEnd: number // requested range end (absolute)
  isEncrypted: boolean
  key?: Buffer
  ivHex?: string
  previousPart?: { msg: any; size: number } | null // for cross-part IV
  onChunk: (segmentIndex: number, chunkIndex: number, data: Buffer, isLastChunk: boolean, isLastSegment: boolean) => Promise<void>
  signal?: AbortSignal
}

interface Segment {
  index: number
  absStart: number
  absEnd: number
  skipBytes: number // bytes to skip at start of first chunk
  isLast: boolean
}

interface Chunk {
  segmentIndex: number
  chunkIndex: number
  data: Buffer
  isLastChunk: boolean
  isLastSegment: boolean
}

/**
 * Ordered-parallel fetcher for a single part's sub-range.
 * Splits the requested range into large segments (8MB), each streamed by a worker
 * using iterDownload (like sequential code). Chunks are yielded in strict order.
 */
export async function fetchPartSegments(opts: SegmentedDownloadOptions): Promise<void> {
  const { client, file, partStart, partEnd, reqStart, reqEnd, isEncrypted, key, ivHex, previousPart, onChunk, signal } = opts

  // Calculate the actual range within this part
  const rangeStart = Math.max(reqStart, partStart)
  const rangeEnd = Math.min(reqEnd, partEnd)
  if (rangeStart > rangeEnd) return

  // Align first segment start down to 4096 boundary (for skipBytes handling)
  const firstSegmentStart = Math.floor(rangeStart / 4096) * 4096
  const lastSegmentEnd = rangeEnd

  // Generate segment boundaries: each segment is SEG_SEGMENT_SIZE, aligned to 4096
  const segments: Segment[] = []
  let segmentIndex = 0
  let currentAbsStart = firstSegmentStart

  while (currentAbsStart <= lastSegmentEnd) {
    const segmentAbsEnd = Math.min(currentAbsStart + SEG_SEGMENT_SIZE - 1, lastSegmentEnd)
    const skipBytes = Math.max(0, rangeStart - currentAbsStart)
    const isLast = segmentAbsEnd === lastSegmentEnd

    segments.push({
      index: segmentIndex++,
      absStart: currentAbsStart,
      absEnd: segmentAbsEnd,
      skipBytes,
      isLast
    })

    currentAbsStart = segmentAbsEnd + 1
  }

  const totalSegments = segments.length
  if (totalSegments === 0) return

  slog(`seg-fetch start: ${totalSegments} segments (${SEG_SEGMENT_SIZE / 1024 / 1024}MB each), range=${rangeStart}-${rangeEnd}, part=${partStart}-${partEnd}, workers=${SEG_FETCH_CONCURRENCY}`)

  // Shared state for ordered assembly
  let nextExpectedSegment = 0
  let nextExpectedChunkInSegment = 0
  let pumpChain: Promise<void> = Promise.resolve()
  const segmentBuffers = new Map<number, Chunk[]>() // segmentIndex -> chunks in order
  const segmentComplete = new Set<number>() // segments that have finished downloading
  let aborted = false
  let decipher: crypto.Decipher | null = null
  let decipherInitialized = false

  // Backpressure: track how many segments are ahead of nextExpectedSegment
  let segmentsAhead = 0
  const waitingWorkers: Array<() => void> = []

  const waitForBackpressure = (): Promise<void> => {
    if (segmentsAhead < SEG_MAX_BUFFERED_SEGMENTS) {
      segmentsAhead++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      waitingWorkers.push(resolve)
    })
  }

  const releaseBackpressure = () => {
    segmentsAhead--
    if (waitingWorkers.length > 0) {
      const resolve = waitingWorkers.shift()!
      resolve()
    }
  }

  // Check abort signal
  if (signal) {
    signal.addEventListener('abort', () => { aborted = true })
  }

  // Initialize decipher for encrypted files (sequential CBC - only for first segment of part)
  const initDecipher = async (segmentAbsStart: number): Promise<crypto.Decipher | null> => {
    if (!isEncrypted || !key) return null
    if (decipherInitialized) return decipher

    decipherInitialized = true

    if (segmentAbsStart === 0 && partStart === 0) {
      // Beginning of the very first part
      decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex!, 'hex'))
      decipher.setAutoPadding(false)
    } else {
      // Need to fetch previous 16 bytes for IV
      let iv: Buffer | null = null

      if (segmentAbsStart === 0 && partStart > 0 && previousPart) {
        // Get last 16 bytes of the previous part
        try {
          const prevIter = client.iterDownload({
            file: previousPart.msg.media,
            offset: bigInt(previousPart.size - 16),
            limit: 16,
            requestSize: 16,
          })
          for await (const chunk of prevIter) {
            iv = Buffer.from(chunk)
            break
          }
        } catch (e) {
          console.error('[seg-fetch] Failed to fetch cross-part IV:', e)
        }
      } else if (segmentAbsStart >= 16) {
        try {
          const prevIter = client.iterDownload({
            file: file,
            offset: bigInt(segmentAbsStart - 16),
            limit: 16,
            requestSize: 16,
          })
          for await (const chunk of prevIter) {
            iv = Buffer.from(chunk).subarray(0, 16)
            break
          }
        } catch (e) {
          console.error('[seg-fetch] Failed to fetch intra-part IV:', e)
        }
      }

      if (iv && iv.length === 16) {
        decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
        decipher.setAutoPadding(false)
      } else {
        // Fallback
        decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.alloc(16))
        decipher.setAutoPadding(false)
      }
    }
    return decipher
  }

  // Worker function: streams one segment continuously
  const worker = async (workerId: number): Promise<void> => {
    slog(`seg-fetch worker ${workerId} started`)
    while (!aborted) {
      // Backpressure: wait if too many segments ahead
      await waitForBackpressure()
      if (aborted) break

      // Get next segment to process
      let mySegmentIndex: number
      mySegmentIndex = workerCursor++
      if (mySegmentIndex >= totalSegments) {
        releaseBackpressure()
        break
      }

      const segment = segments[mySegmentIndex]
      const segmentSize = segment.absEnd - segment.absStart + 1
      const deliverableSize = segmentSize - segment.skipBytes

      try {
        // Initialize decipher on first segment if encrypted
        if (isEncrypted && !decipherInitialized) {
          await initDecipher(segment.absStart)
        }

        // Stream this segment using iterDownload with limit to segment end
        // limit must be chunk count (not bytes) for gramjs; chunkSize defaults to requestSize
        const chunkCount = Math.ceil(segmentSize / SEG_CHUNK_SIZE)
        const iter = client.iterDownload({
          file,
          offset: bigInt(segment.absStart),
          requestSize: SEG_CHUNK_SIZE,
          limit: chunkCount,
        })

        let chunkIndex = 0
        let firstChunk = true
        let remainingSkipBytes = segment.skipBytes
        let segmentBytesDelivered = 0

        for await (const chunk of iter) {
          if (aborted) break

          let processedChunk = chunk
          if (decipher) {
            processedChunk = decipher.update(processedChunk)
          }

          // Apply skipBytes on first chunk
          if (firstChunk && remainingSkipBytes > 0) {
            if (remainingSkipBytes >= processedChunk.length) {
              remainingSkipBytes -= processedChunk.length
              continue
            } else {
              processedChunk = processedChunk.subarray(remainingSkipBytes)
              remainingSkipBytes = 0
            }
          }
          firstChunk = false

          // Check if we've delivered enough for this segment
          if (segmentBytesDelivered + processedChunk.length > deliverableSize) {
            processedChunk = processedChunk.subarray(0, deliverableSize - segmentBytesDelivered)
          }

          segmentBytesDelivered += processedChunk.length

          // Store chunk in segment buffer
          const chunkData: Chunk = {
            segmentIndex: mySegmentIndex,
            chunkIndex,
            data: processedChunk,
            isLastChunk: false,
            isLastSegment: segment.isLast
          }

          // Add to segment buffer
          if (!segmentBuffers.has(mySegmentIndex)) {
            segmentBuffers.set(mySegmentIndex, [])
          }
          segmentBuffers.get(mySegmentIndex)!.push(chunkData)

          // Try to deliver in-order chunks
          await schedulePump()

          chunkIndex++

          // Stop if we've delivered the full segment
          if (segmentBytesDelivered >= deliverableSize) break
        }

        // Mark last chunk of this segment
        const segBuffer = segmentBuffers.get(mySegmentIndex)
        if (segBuffer && segBuffer.length > 0) {
          segBuffer[segBuffer.length - 1].isLastChunk = true
        }

        // Mark segment as complete
        segmentComplete.add(mySegmentIndex)

        // Try to deliver any remaining chunks from this segment
        await schedulePump()

      } catch (err) {
        if (!aborted) {
          console.error(`[seg-fetch] Worker ${workerId} error on segment ${mySegmentIndex}:`, err)
          aborted = true
          throw err
        }
      } finally {
        releaseBackpressure()
      }
    }
    slog(`seg-fetch worker ${workerId} finished`)
  }

  // Shared cursor for segment assignment (simple, not atomic but OK for 2 workers)
  let workerCursor = 0

  // Deliver chunks in strict order: segment 0 chunk 0, segment 0 chunk 1, ..., segment 1 chunk 0, ...
  const deliverChunks = async (force = false): Promise<void> => {
    let delivered = 0
    let segmentBoundaryCrossed = false
    while (force || !aborted) {
      const buffer = segmentBuffers.get(nextExpectedSegment)
      if (!buffer || buffer.length === 0) {
        // No chunks buffered for this segment
        // If segment is complete, we can move to next segment
        if (segmentComplete.has(nextExpectedSegment)) {
          nextExpectedSegment++
          nextExpectedChunkInSegment = 0
          segmentBoundaryCrossed = true
          continue
        }
        break
      }

      const chunk = buffer[0]
      if (chunk.chunkIndex !== nextExpectedChunkInSegment) break

      // This is the next expected chunk
      buffer.shift()
      if (buffer.length === 0) {
        segmentBuffers.delete(nextExpectedSegment)
      }

      await onChunk(chunk.segmentIndex, chunk.chunkIndex, chunk.data, chunk.isLastChunk, chunk.isLastSegment)
      delivered++

      nextExpectedChunkInSegment++
      if (chunk.isLastChunk) {
        nextExpectedSegment++
        nextExpectedChunkInSegment = 0
        segmentBoundaryCrossed = true
      }
    }
    // Log only when a segment boundary is crossed (not per chunk)
    if (segmentBoundaryCrossed) {
      slog(`seg-fetch deliverChunks: nextExpectedSegment=${nextExpectedSegment}`)
    }
  }

  // Serialize deliverChunks calls to prevent re-entrancy race conditions
  const schedulePump = async (force = false): Promise<void> => {
    pumpChain = pumpChain.then(() => deliverChunks(force)).catch((err) => {
      console.error('[seg-fetch] pump error:', err)
      aborted = true
    })
    await pumpChain
  }

  // Start workers with small stagger to avoid flood wait
  const workers: Promise<void>[] = []
  for (let i = 0; i < SEG_FETCH_CONCURRENCY; i++) {
    const workerPromise = (async () => {
      if (i > 0) await new Promise(r => setTimeout(r, i * 100))
      slog(`seg-fetch starting worker ${i}`)
      await worker(i)
    })()
    workers.push(workerPromise)
  }

  // Wait for all workers to complete
  await Promise.all(workers)

  // Deliver any remaining chunks (force delivery even if aborted)
  await schedulePump(true)

  // Verify all segments delivered (only if not aborted)
  if (!aborted && nextExpectedSegment < totalSegments) {
    throw new Error(`Missing segments after all workers completed: expected ${totalSegments}, delivered ${nextExpectedSegment}`)
  }

  if (!aborted) {
    slog(`seg-fetch complete: ${totalSegments} segments delivered`)
  } else {
    slog(`seg-fetch aborted: ${nextExpectedSegment}/${totalSegments} segments delivered`)
  }
}

function slog(msg: string) {
  console.log(`[stream] ${msg}`)
}