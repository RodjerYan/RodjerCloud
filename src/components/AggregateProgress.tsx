import React, { useEffect, useRef, useState } from "react"
import { useUploadProgress } from "../lib/useUploadProgress"
import { fmtBytes, fmtTime } from "../lib/v3store"
import { Activity } from "lucide-react"

import { useUploadQueue } from "../lib/UploadQueueContext"
import { pendingStore, type PendingUpload } from "../lib/PendingUploadStore"

// ==== T-20260925-005 S1: агрегатная скорость с last-known + TTL ====
// per-file speed (useUploadProgress) живёт в окне 5s и ОБНУЛЯЕТСЯ на finish,
// а main молчит во время computeFileHash и между файлами (очередь = 1 файл).
// Поэтому скорость меряем по АГРЕГАТУ (Σ sent по всем items, включая waiting):
// сэмпл агрегата переживает finish и паузы между файлами.
const AGG_WINDOW_MS = 10000 // окно измерения суммарной скорости (5-10s)
const AGG_TTL_MS = 15000 // агрегат молчит (нет прироста sent) >15s → скорость неизвестна
const COUNTING_MS = 3000 // «Подсчёт…» — максимум первые 3s видимости баннера
const AGG_MIN_SPAN_MS = 1000 // минимальная база окна, чтобы не ловить шум <1s

type AggSample = { ts: number; sent: number }
type AggState = {
  samples: AggSample[]
  lastSent: number
  lastIncreaseTs: number
  speed: number
  speedAt: number
  shownAt: number
}

export default function AggregateProgress() {
  const { items } = useUploadProgress()
  const { queue } = useUploadQueue()
  const [pendingMyFiles, setPendingMyFiles] = useState<PendingUpload[]>(pendingStore.uploads)
  const [, setTick] = useState(0)
  const aggRef = useRef<AggState>({
    samples: [],
    lastSent: 0,
    lastIncreaseTs: 0,
    speed: 0,
    speedAt: 0,
    shownAt: 0,
  })

  useEffect(() => {
    return pendingStore.subscribe(setPendingMyFiles)
  }, [])

  // Видимость баннера: только реально незавершённые (percent < 100).
  // done-элементы и uploading-зомби с percent=100 баннер не держат.
  const pendingQueue = queue.filter(q =>
    (q.status === 'waiting' || q.status === 'uploading') && (q.percent ?? 0) < 100
  )
  // Banner-видимость не зависит от pending с progress>=100: считаем их "done"
  const pendingVisible = pendingMyFiles.filter(p => p.progress < 100)
  const visible = pendingQueue.length > 0 || pendingVisible.length > 0

  // Тик 1s: TTL last-known и переход «Подсчёт…» → «Осталось N Б» должны
  // срабатывать и БЕЗ новых событий progress (тишина main: hash/между файлами).
  useEffect(() => {
    if (!visible) return
    const t = window.setInterval(() => setTick(v => v + 1), 1000)
    return () => window.clearInterval(t)
  }, [visible])

  const list = Object.values(items)
  const currentUploadIds = new Set([
    ...queue.filter(q => q.status === 'uploading').map(q => q.id),
    ...pendingVisible.map(p => p.id),
  ])
  const active = list.filter(i => !i.finished && currentUploadIds.has(i.id))

  // Bytes: id из pendingStore приоритетнее queue (там уже есть sent/total из progress),
  // queue-элементы с тем же id не суммируем (иначе двойной счёт → overall >100 / «всего» врёт).
  // M1: byte-блок по полному pendingMyFiles (не только <100) — done-файл не «выпадает»
  // из overall, пока pending не снят finalizePending.
  const pendingIdSet = new Set(pendingMyFiles.map(p => p.id))
  const queueOnlyBytes = queue.filter(q => !pendingIdSet.has(q.id))
  const totalQueueBytes = queueOnlyBytes.reduce((s, q) => q.status === 'failed' ? s : s + (q.fileSize || 0), 0)
  const totalMyFilesBytes = pendingMyFiles.reduce((s, p) => s + (p.total || 0), 0)
  const totalBytes = totalQueueBytes + totalMyFilesBytes

  const sentQueueBytes = queueOnlyBytes.reduce((s, q) => {
    if (q.status === 'done') return s + q.fileSize
    if (q.status === 'waiting' || q.status === 'failed') return s
    const p = items[q.id]
    if (p) return s + (p.sent || 0)
    return s + (q.fileSize * ((q.percent || 0) / 100))
  }, 0)

  const sentMyFilesBytes = pendingMyFiles.reduce((s, p) => s + (p.sent || 0), 0)
  const sentBytes = sentQueueBytes + sentMyFilesBytes

  const overall = totalBytes > 0 ? Math.min(100, Math.floor((sentBytes / totalBytes) * 100)) : 0
  const speed = active.reduce((s, i) => s + (i.speed || 0), 0)
  const remaining = Math.max(0, totalBytes - sentBytes)

  // ==== агрегатное измерение скорости (по Σ sent ВСЕХ файлов) ====
  const now = Date.now()
  const agg = aggRef.current
  if (!visible) {
    // баннер скрыт → следующая загрузка начинается с чистого «Подсчёт…»
    agg.samples = []
    agg.lastSent = 0
    agg.lastIncreaseTs = 0
    agg.speed = 0
    agg.speedAt = 0
    agg.shownAt = 0
  } else {
    if (!agg.shownAt) agg.shownAt = now
    const lastSample = agg.samples[agg.samples.length - 1]
    // сэмпл: на каждом изменении sent + heartbeat 1s (для пауз/тишины main)
    if (!lastSample || lastSample.sent !== sentBytes || now - lastSample.ts >= 1000) {
      agg.samples.push({ ts: now, sent: sentBytes })
    }
    if (sentBytes > agg.lastSent) agg.lastIncreaseTs = now
    agg.lastSent = sentBytes
    agg.samples = agg.samples.filter(s => now - s.ts <= AGG_WINDOW_MS)
    if (agg.samples.length > 1) {
      const first = agg.samples[0]
      const spanMs = now - first.ts
      if (spanMs >= AGG_MIN_SPAN_MS) {
        const v = Math.max(0, (sentBytes - first.sent) / (spanMs / 1000))
        agg.speed = v
        if (v > 0) agg.speedAt = now
      }
    }
  }
  // last-known: живёт между файлами/finish, пока агрегат «молчит» не дольше TTL
  const aggSpeed = agg.speed
  const speedKnown = visible && aggSpeed > 0
    && now - agg.speedAt <= AGG_TTL_MS
    && now - agg.lastIncreaseTs <= AGG_TTL_MS
  const eta = speedKnown && remaining > 0 ? (remaining / aggSpeed) * 1000 : 0
  // правый блок баннера: ETA → «Подсчёт…» (только первые 3s) → остаток байтами
  const showCounting = !speedKnown && now - agg.shownAt < COUNTING_MS

  if (!visible) return null

  // Консистентная семантика «X из Y»: один id может быть и в queue (main broadcast),
  // и в pendingStore (MyFiles drop) — считаем union id, не сумму массивов.
  // Раньше totalFiles = queue.length + pendingMyFiles.length → «0 из 2» на одном файле.
  const pendingIds = new Set(pendingMyFiles.map(p => p.id))
  const queueOnly = queue.filter(q => !pendingIds.has(q.id))
  const totalFiles = queueOnly.length + pendingMyFiles.length
  const doneFiles =
    queueOnly.filter(q => q.status === 'done').length +
    pendingMyFiles.filter(p => p.progress >= 100).length
  // в трее показываем агрегатную скорость, если она известна (per-file может быть 0 на паузах)
  const traySpeed = speedKnown ? aggSpeed : speed
  return (
    <>
      <div className="v3-aggregate" data-testid="aggregate-progress">
        <div className="v3-row">
          <Activity size={14}/>
          <div className="label">Загрузка <span className="v3-num">{doneFiles}</span> из <span className="v3-num">{totalFiles}</span> · всего <span className="v3-num">{overall}%</span></div>
          <div style={{ marginLeft: "auto" }} className="v3-row v3-sub v3-num">
            {speedKnown && remaining > 0 && (
              <>
                <span>{fmtBytes(aggSpeed)}/s</span>
                <span>·</span>
                <span>Осталось {fmtTime(eta)}</span>
              </>
            )}
            {showCounting && <span>Подсчёт…</span>}
            {!speedKnown && !showCounting && <span>Осталось {fmtBytes(remaining)}</span>}
          </div>
        </div>
        <div className="v3-progress" role="progressbar" aria-label="Общий прогресс загрузки" aria-valuemin={0} aria-valuemax={100} aria-valuenow={overall}>
          <div className="v3-progress-bar" style={{ width: overall + "%" }}/>
        </div>
      </div>
      {active.length > 0 && (
        <div className="v3-tray" data-testid="upload-tray">
          <span className="pulse"/>
          <span className="v3-num">{active.length} активных</span>
          <span className="v3-sub v3-num">· {fmtBytes(traySpeed)}/s</span>
        </div>
      )}
    </>
  )
}
