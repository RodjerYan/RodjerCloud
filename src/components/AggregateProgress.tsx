import React, { useEffect, useState } from "react"
import { useUploadProgress } from "../lib/useUploadProgress"
import { fmtBytes, fmtTime } from "../lib/v3store"
import { Activity } from "lucide-react"

import { useUploadQueue } from "../lib/UploadQueueContext"
import { pendingStore, type PendingUpload } from "../lib/PendingUploadStore"

export default function AggregateProgress() {
  const { items } = useUploadProgress()
  const { queue } = useUploadQueue()
  const [pendingMyFiles, setPendingMyFiles] = useState<PendingUpload[]>(pendingStore.uploads)

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
  if (pendingQueue.length === 0 && pendingVisible.length === 0) return null

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
  const eta = speed > 0 ? (remaining / speed) * 1000 : 0
  
  // Консистентная семантика «X из Y»: один id может быть и в queue (main broadcast),
  // и в pendingStore (MyFiles drop) — считаем union id, не сумму массивов.
  // Раньше totalFiles = queue.length + pendingMyFiles.length → «0 из 2» на одном файле.
  const pendingIds = new Set(pendingMyFiles.map(p => p.id))
  const queueOnly = queue.filter(q => !pendingIds.has(q.id))
  const totalFiles = queueOnly.length + pendingMyFiles.length
  const doneFiles =
    queueOnly.filter(q => q.status === 'done').length +
    pendingMyFiles.filter(p => p.progress >= 100).length
  return (
    <>
      <div className="v3-aggregate" data-testid="aggregate-progress">
        <div className="v3-row">
          <Activity size={14}/>
          <div className="label">Загрузка <span className="v3-num">{doneFiles}</span> из <span className="v3-num">{totalFiles}</span> · всего <span className="v3-num">{overall}%</span></div>
          <div style={{ marginLeft: "auto" }} className="v3-row v3-sub v3-num">
            {speed > 0 && (
              <>
                <span>{fmtBytes(speed)}/s</span>
                <span>·</span>
                <span>Осталось {fmtTime(eta)}</span>
              </>
            )}
            {speed === 0 && <span>Подсчёт…</span>}
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
          <span className="v3-sub v3-num">· {fmtBytes(speed)}/s</span>
        </div>
      )}
    </>
  )
}
