import React, { useEffect, useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LabelList } from 'recharts'
import { Upload, HardDrive, FileText, TrendingUp } from 'lucide-react'
import { fmtSize } from '../lib/utils'

function timeGreeting(): string {
  const h = new Date().getHours()
  if (h >= 6 && h < 12) return 'Доброе утро'
  if (h >= 12 && h < 18) return 'Добрый день'
  if (h >= 18 && h < 24) return 'Добрый вечер'
  return 'Доброй ночи'
}

interface DashboardData {
  total: number
  totalSize: number
  weekFiles: number
  avgSize: number
  counts: Record<string, number>
  recent: any[]
}

export default function DashboardHome({ channelInfo, userInfo }: { channelInfo: any; userInfo?: { firstName?: string } | null }) {
  const navigate = useNavigate()
  const [data, setData] = useState<DashboardData | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadData = useCallback(async () => {
    try {
      const [countsRes, sizeRes, recentRes] = await Promise.all([
        window.electronAPI.telegram.getCategoryCounts(),
        window.electronAPI.telegram.getTotalSize(),
        window.electronAPI.telegram.listFilesFromCache(5, 0),
      ])
      const counts = countsRes?.success ? (countsRes.data || {}) : {}
      const sizeData = sizeRes?.success ? (sizeRes.data || {}) : {}
      const totalSize = sizeData.totalSize || 0
      const totalFromSize = sizeData.total || 0
      const weekFiles = sizeData.weekFiles || 0
      const recent = recentRes?.success ? (recentRes.data || (recentRes as any).files || []) : []
      const total = totalFromSize > 0 ? totalFromSize : Object.values(counts).reduce((s: number, v: any) => s + (typeof v === 'number' ? v : 0), 0)
      const avgSize = total > 0 ? totalSize / total : 0
      setData({ total, totalSize, weekFiles, avgSize, counts, recent })
    } catch {}
  }, [])

  useEffect(() => {
    let active = true
    ;(async () => {
      await loadData()
      if (active) window.electronAPI.telegram.syncFilesBg()
    })()
    const unsubChanged = window.electronAPI.telegram.onFilesChanged?.(() => {
      if (!active) return
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => { loadData() }, 3000)
    })
    return () => { active = false; unsubChanged?.(); if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [loadData])

  const CATS = ['Изображения', 'Видео', 'Аудио', 'Документы', 'Архивы', 'Другое']
  const chartData = CATS.filter(c => (data?.counts?.[c] || 0) > 0).map(name => ({ name, value: data?.counts?.[name] || 0 }))

  return (
    <div className="dh-root">
      <div className="dh-banner">
        <div>
          <h1>{timeGreeting()}{userInfo?.firstName ? `, ${userInfo.firstName}` : ''}</h1>
        </div>
      </div>

      <div className="dh-stats">
        {!data ? (
          <>
            <div className="dh-card"><div className="dh-card-icon skeleton" style={{width:42,height:42}}/><div className="dh-card-body"><div className="dh-card-label">Всего файлов</div><div className="dh-card-value"><div className="skeleton skeleton-text" style={{width:40,height:28}}/></div></div></div>
            <div className="dh-card"><div className="dh-card-icon skeleton" style={{width:42,height:42}}/><div className="dh-card-body"><div className="dh-card-label">Использовано</div><div className="dh-card-value"><div className="skeleton skeleton-text" style={{width:60,height:28}}/></div></div></div>
            <div className="dh-card"><div className="dh-card-icon skeleton" style={{width:42,height:42}}/><div className="dh-card-body"><div className="dh-card-label">За неделю</div><div className="dh-card-value"><div className="skeleton skeleton-text" style={{width:30,height:28}}/></div></div></div>
            <div className="dh-card"><div className="dh-card-icon skeleton" style={{width:42,height:42}}/><div className="dh-card-body"><div className="dh-card-label">Средний размер</div><div className="dh-card-value"><div className="skeleton skeleton-text" style={{width:55,height:28}}/></div></div></div>
          </>
        ) : (
          <>
            <div className="dh-card"><div className="dh-card-icon"><FileText size={20} /></div>
              <div className="dh-card-body"><div className="dh-card-label">Всего файлов</div>
                <div className="dh-card-value">{data.total}</div></div></div>
            <div className="dh-card"><div className="dh-card-icon"><HardDrive size={20} /></div>
              <div className="dh-card-body"><div className="dh-card-label">Использовано</div>
                <div className="dh-card-value">{fmtSize(data.totalSize)}</div></div></div>
            <div className="dh-card"><div className="dh-card-icon"><TrendingUp size={20} /></div>
              <div className="dh-card-body"><div className="dh-card-label">За неделю</div>
                <div className="dh-card-value">{data.weekFiles}</div></div></div>
            <div className="dh-card"><div className="dh-card-icon"><BarChart3Icon /></div>
              <div className="dh-card-body"><div className="dh-card-label">Средний размер</div>
                <div className="dh-card-value">{fmtSize(data.avgSize)}</div></div></div>
          </>
        )}
      </div>

      <div className="dh-grid">
        <div className="dh-panel">
          <div className="dh-panel-head"><h2>Файлы по типам</h2></div>
          <div style={{ width: '100%', height: 240 }}>
            <ResponsiveContainer>
              <BarChart data={chartData} margin={{ top: 28, right: 20, bottom: 50, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                <XAxis dataKey="name" stroke="#9ca3c4" fontSize={11} interval={0} tickLine={false} axisLine={false} />
                <YAxis stroke="#9ca3c4" fontSize={12} allowDecimals={false} width={36} axisLine={false} tickLine={false} />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(124,131,255,0.08)' }} />
                <Bar dataKey="value" fill="url(#dhBarGrad)" radius={[6, 6, 0, 0]}
                  activeBar={{ fill: 'url(#dhBarGradActive)', radius: [6, 6, 0, 0] } as any}>
                  <LabelList dataKey="value" position="top" fill="#e2e4f0" fontSize={13} fontWeight={600} />
                </Bar>
                <defs><linearGradient id="dhBarGrad" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#7c83ff" /><stop offset="100%" stopColor="#3a3fa4" />
                </linearGradient><linearGradient id="dhBarGradActive" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#a5aaff" /><stop offset="100%" stopColor="#5c61d4" />
                </linearGradient></defs>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="dh-panel">
          <div className="dh-panel-head"><h2>Последние файлы</h2></div>
          {!data || data.recent.length === 0 ? <div className="dh-empty">Файлов пока нет</div> : (
            <ul className="dh-recent">
              {data.recent.map(f => (
                <li key={f.messageId}>
                  <div className="dh-recent-name" title={f.fileName}>{f.fileName}</div>
                  <div className="dh-recent-meta">{fmtSize(f.fileSize)} • {new Date(((f.originalDate || f.uploadedAt) || 0) * 1000).toLocaleDateString()}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function BarChart3Icon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="M7 16V8"/><path d="M12 16v-5"/><path d="M17 16v-3"/></svg>
}

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const { name, value } = payload[0].payload
  return (
    <div style={{
      background: 'rgba(16,18,32,0.94)', border: '1px solid rgba(124,131,255,0.25)',
      borderRadius: 10, padding: '8px 14px', boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
    }}>
      <div style={{ fontSize: 12, color: '#9ca3c4', marginBottom: 2 }}>{name}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: '#e2e4f0' }}>{value}</div>
    </div>
  )
}
