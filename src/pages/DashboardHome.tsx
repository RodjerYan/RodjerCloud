import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LabelList } from 'recharts'
import { Upload, HardDrive, FileText, TrendingUp } from 'lucide-react'

function fmtSize(n: number) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0; let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return v.toFixed(v < 10 && i > 0 ? 1 : 0) + ' ' + u[i]
}
function typeOf(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'Изображения'
  if (['mp4', 'mov', 'mkv', 'avi', 'webm'].includes(ext)) return 'Видео'
  if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(ext)) return 'Аудио'
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md'].includes(ext)) return 'Документы'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'Архивы'
  return 'Другое'
}

function timeGreeting(): string {
  const h = new Date().getHours()
  if (h >= 6 && h < 12) return 'Доброе утро'
  if (h >= 12 && h < 18) return 'Добрый день'
  if (h >= 18 && h < 24) return 'Добрый вечер'
  return 'Доброй ночи'
}

export default function DashboardHome({ channelInfo, userInfo }: { channelInfo: any; userInfo?: { firstName?: string } | null }) {
  const navigate = useNavigate()
  const [files, setFiles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      const res = await window.electronAPI.telegram.listFiles()
      if (res.success) setFiles(res.data || [])
      setLoading(false)
    })()
  }, [])

  const total = files.length
  const totalSize = files.reduce((s, f) => s + (f.fileSize || 0), 0)
  const oneWeekAgo = Date.now() / 1000 - 7 * 24 * 3600
  const weekFiles = files.filter(f => (f.uploadedAt || 0) >= oneWeekAgo).length
  const avgSize = total ? totalSize / total : 0

  const typeMap: Record<string, number> = {}
  const CATS = ['Изображения', 'Видео', 'Аудио', 'Документы', 'Архивы', 'Другое']
  CATS.forEach(c => typeMap[c] = 0)
  files.forEach(f => { const t = typeOf(f.fileName || ''); typeMap[t] = (typeMap[t] || 0) + 1 })
  const chartData = CATS.filter(c => typeMap[c] > 0).map(name => ({ name, value: typeMap[name] }))

  const recent = [...files].sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0)).slice(0, 5)

  const onQuickUpload = async () => {
    const r = await window.electronAPI.dialog.pickMultipleFiles()
    if (r.success) navigate('/upload', { state: { initialFiles: r.data } })
  }

  return (
    <div className="dh-root">
      <div className="dh-banner">
        <div>
          <h1>{timeGreeting()}{userInfo?.firstName ? `, ${userInfo.firstName}` : ''}</h1>
          <p>{channelInfo?.title ? `Подключено к ${channelInfo.title}` : 'Ваше приватное облако в Telegram'}</p>
        </div>
        <button className="dh-cta" onClick={() => navigate('/upload')}>
          <Upload size={16} /> Загрузить файлы
        </button>
      </div>

      <div className="dh-stats">
        <div className="dh-card"><div className="dh-card-icon"><FileText size={20} /></div>
          <div className="dh-card-body"><div className="dh-card-label">Всего файлов</div>
            <div className="dh-card-value">{loading ? '…' : total}</div></div></div>
        <div className="dh-card"><div className="dh-card-icon"><HardDrive size={20} /></div>
          <div className="dh-card-body"><div className="dh-card-label">Использовано</div>
            <div className="dh-card-value">{loading ? '…' : fmtSize(totalSize)}</div></div></div>
        <div className="dh-card"><div className="dh-card-icon"><TrendingUp size={20} /></div>
          <div className="dh-card-body"><div className="dh-card-label">За неделю</div>
            <div className="dh-card-value">{loading ? '…' : weekFiles}</div></div></div>
        <div className="dh-card"><div className="dh-card-icon"><BarChart3Icon /></div>
          <div className="dh-card-body"><div className="dh-card-label">Средний размер</div>
            <div className="dh-card-value">{loading ? '…' : fmtSize(avgSize)}</div></div></div>
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
                  activeBar={{ fill: 'url(#dhBarGradActive)', radius: [6, 6, 0, 0] }}>
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
          {recent.length === 0 ? <div className="dh-empty">Файлов пока нет</div> : (
            <ul className="dh-recent">
              {recent.map(f => (
                <li key={f.messageId}>
                  <div className="dh-recent-name" title={f.fileName}>{f.fileName}</div>
                  <div className="dh-recent-meta">{fmtSize(f.fileSize)} • {new Date((f.uploadedAt || 0) * 1000).toLocaleDateString()}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="dh-quick" onClick={onQuickUpload}>
        <Upload size={28} />
        <div className="dh-quick-title">Быстрая загрузка</div>
        <div className="dh-quick-sub">Нажмите, чтобы выбрать файлы</div>
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
