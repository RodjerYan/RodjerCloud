import React from "react"
import { useUploadProgress } from "../lib/useUploadProgress"
import { fmtBytes, fmtTime } from "../lib/v3store"
import { Activity } from "lucide-react"

import { useUploadQueue } from "../lib/UploadQueueContext"

export default function AggregateProgress() {
  const { items } = useUploadProgress()
  const { queue } = useUploadQueue()
  
  const pendingQueue = queue.filter(q => q.status === 'waiting' || q.status === 'uploading')
  if (pendingQueue.length === 0) return null

  const list = Object.values(items)
  const active = list.filter(i => !i.finished)
  
  const totalBytes = queue.reduce((s, q) => s + (q.fileSize || 0), 0)
  const sentBytes = queue.reduce((s, q) => {
    if (q.status === 'done') return s + q.fileSize
    if (q.status === 'waiting' || q.status === 'failed') return s
    const p = items[q.id]
    if (p) return s + (p.sent || 0)
    return s + (q.fileSize * ((q.percent || 0) / 100))
  }, 0)
  
  const overall = totalBytes > 0 ? Math.min(100, Math.floor((sentBytes / totalBytes) * 100)) : 0
  const speed = list.reduce((s, i) => s + (i.speed || 0), 0)
  const remaining = Math.max(0, totalBytes - sentBytes)
  const eta = speed > 0 ? (remaining / speed) * 1000 : 0
  
  const totalFiles = queue.length
  const doneFiles = queue.filter(q => q.status === 'done').length
  return (
    <>
      <div className="v3-aggregate" data-testid="aggregate-progress">
        <div className="v3-row">
          <Activity size={14}/>
          <div className="label">Загрузка <span className="v3-num">{doneFiles}</span> из <span className="v3-num">{totalFiles}</span> · всего <span className="v3-num">{overall}%</span></div>
          <div style={{ marginLeft: "auto" }} className="v3-row v3-sub v3-num">
            <span>{fmtBytes(speed)}/s</span>
            <span>·</span>
            <span>Осталось {fmtTime(eta)}</span>
          </div>
        </div>
        <div className="v3-progress"><div className="v3-progress-bar" style={{ width: overall + "%" }}/></div>
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
