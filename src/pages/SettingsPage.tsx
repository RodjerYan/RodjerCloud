import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Bot, Info, Download, ExternalLink } from 'lucide-react'
import iconUrl from '../assets/icon.png'

export default function SettingsPage({ channelInfo, onChangeChannel }: { channelInfo: any; onChangeChannel: () => void }) {
  const [concurrency, setConcurrency] = useState(2)
  const [autoRename, setAutoRename] = useState(false)
  const [toast, setToast] = useState('')
  const [botToken, setBotToken] = useState('')
  const [botConfigured, setBotConfigured] = useState(false)
  const [version, setVersion] = useState("")

  const [updateModal, setUpdateModal] = useState<null | {
    hasUpdate: boolean
    currentVersion: string
    latestVersion: string
    releaseNotes: string
    assetId: number
    assetName: string
    htmlUrl: string
  }>(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [askDownloadPath, setAskDownloadPath] = useState(false)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [downloadPathState, setDownloadPathState] = useState('')

  useEffect(() => {
    (async () => {
      const a = await window.electronAPI.storage.getAskDownloadPath()
      if (a.success) setAskDownloadPath(a.data || false)
      const c = await window.electronAPI.storage.getUploadConcurrency()
      if (c.success) setConcurrency(c.data || 2)
      setAutoRename(localStorage.getItem('v2.autoRename') === '1')
      const v = await window.electronAPI.app.getVersion()
      if (v.success && v.data) setVersion(v.data)
    })()
    window.electronAPI.share.getBotToken().then((r: any) => {
      if (r.success && r.data) { setBotConfigured(true); setBotToken(r.data) }
    })
  }, [])

  const show = (s: string) => { setToast(s); setTimeout(() => setToast(''), 1800) }

  const onConcurrency = async (n: number) => {
    setConcurrency(n)
    await window.electronAPI.storage.setUploadConcurrency(n)
  }

  const copyKey = async () => {
    if (!channelInfo?.token) return
    await window.electronAPI.app.copyToClipboard(channelInfo.token)
    show('Ключ скопирован')
  }

  const checkUpdates = async () => {
    setCheckingUpdate(true)
    const r = await window.electronAPI.app.checkUpdate()
    setCheckingUpdate(false)
    if (r.success && r.data) {
      setUpdateModal(r.data)
      if (!r.data.hasUpdate) {
        show('У вас последняя версия')
      }
    } else {
      show(r.error || 'Ошибка проверки обновлений')
    }
  }

  const startDownload = async () => {
    if (!updateModal?.assetId) return
    setDownloading(true)
    setDownloadProgress(0)
    const unsub = window.electronAPI.app.onDownloadProgress((p) => {
      setDownloadProgress(p.percent)
    })
    const r = await window.electronAPI.app.downloadUpdate(updateModal.assetId)
    unsub()
    if (r.success && r.data) {
      setDownloadPathState(r.data.filePath)
      setDownloadProgress(100)
    } else {
      show(r.error || 'Ошибка загрузки')
      setDownloading(false)
    }
  }

  const installUpdate = async () => {
    if (!downloadPathState) return
    const r = await window.electronAPI.app.installUpdate(downloadPathState)
    if (!r.success) {
      show(r.error || 'Ошибка запуска установщика')
    }
    setDownloading(false)
    setUpdateModal(null)
  }

  return (
    <div className="se-root">
      <h1>Настройки</h1>

      <section className="v3-card">
        <h2>Загрузка</h2>
        <label className="se-row"><span>Всегда спрашивать куда загружать файлы</span>
          <input type="checkbox" checked={askDownloadPath} onChange={e => { setAskDownloadPath(e.target.checked); window.electronAPI.storage.setAskDownloadPath(e.target.checked) }} />
        </label>
      </section>

      <section className="v3-card">
        <h2>Отправка</h2>
        <label className="se-row"><span>Авто-переименование при совпадении</span>
          <input type="checkbox" checked={autoRename} onChange={e => { setAutoRename(e.target.checked); localStorage.setItem('v2.autoRename', e.target.checked ? '1' : '0') }} />
        </label>
        <div className="se-row"><span>Одновременных загрузок</span>
          <input type="number" min={1} max={5} value={concurrency} onChange={e => onConcurrency(Math.max(1, Math.min(5, parseInt(e.target.value) || 1)))} style={{ width: 80 }} />
        </div>
      </section>

      <section className="v3-card">
        <h2>Канал</h2>
        <div className="se-row"><span>Подключённый канал</span><strong>{channelInfo?.title || '—'}</strong></div>
        {channelInfo?.token && (
          <div className="se-row"><span>Ключ канала</span>
            <div className="se-path"><code>{String(channelInfo.token).slice(0, 12)}…</code>
              <button onClick={copyKey}><Copy size={14} /> Копировать ключ</button></div>
          </div>
        )}
        <button className="v3-btn" onClick={onChangeChannel}>Сменить канал</button>
      </section>

      <section className="v3-card">
        <h2><Bot size={16} /> Бот для ссылок</h2>
        <div className="se-row"><span>Токен бота</span>
          {botConfigured ? <span style={{ color: 'var(--accent)' }}>✓ Настроен</span> : <span style={{ color: 'var(--danger)' }}>Не настроен</span>}
        </div>
        <div className="se-row" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
          <input value={botToken} onChange={e => setBotToken(e.target.value)}
            placeholder="Введите токен бота: 123456:ABCdef..."
            style={{ background: 'var(--bg)', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '10px 12px', color: 'var(--text)', fontSize: 13, outline: 'none', fontFamily: 'monospace' }} />
          <button className="v3-btn" onClick={async () => {
            if (!botToken.trim()) return show('Введите токен')
            const r = await window.electronAPI.share.setBotToken(botToken.trim())
            if (r.success) { setBotConfigured(true); show('Токен сохранён') }
            else show(r.error || 'Ошибка')
          }}>Сохранить токен</button>
        </div>
        <div className="se-row" style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          @BotFather → создать бота → добавить администратором канала «My area» → написать боту /start
        </div>
      </section>

      <section className="v3-card">
        <h2><Info size={16} /> О программе</h2>
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <img src={iconUrl} alt="RodjerCloud" style={{ width: 72, height: 72, borderRadius: 20, marginBottom: 8 }} />
          <h3 style={{ margin: '4px 0' }}>RodjerCloud</h3>
          <div style={{ color: 'var(--accent)', fontSize: 13, marginBottom: 12 }}>{version ? `v${version}` : ''}</div>
          <p style={{ color: 'var(--text-dim)', lineHeight: 1.55, maxWidth: 500, margin: '0 auto 16px', fontSize: 13 }}>
            RodjerCloud превращает ваш приватный Telegram-канал в безлимитное облачное хранилище.
            Без шифрования, без ежемесячной платы, полностью в вашем распоряжении.
          </p>

          <button className="v3-btn" onClick={checkUpdates} disabled={checkingUpdate}
            style={{ margin: '0 auto 16px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Download size={14} />
            {checkingUpdate ? 'Проверка…' : 'Проверить обновления'}
          </button>

          <div style={{ marginTop: 16, fontSize: 12, color: 'var(--v3-text-mute)' }}>Распространяется под лицензией MIT</div>
        </div>
      </section>

      {updateModal && updateModal.hasUpdate && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)' }}
          onClick={() => { if (!downloading) setUpdateModal(null) }}>
          <div className="v3-card" style={{ padding: 20, minWidth: 360, maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 8px' }}>Доступно обновление v{updateModal.latestVersion}</h3>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
              Текущая версия: v{updateModal.currentVersion}
            </div>
            {updateModal.releaseNotes && (
              <div style={{ fontSize: 13, lineHeight: 1.5, maxHeight: 200, overflowY: 'auto', background: 'var(--bg)', borderRadius: 8, padding: 12, marginBottom: 16, whiteSpace: 'pre-wrap' }}>
                {updateModal.releaseNotes}
              </div>
            )}
            {downloading ? (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                  <span>Загрузка…</span><span>{downloadProgress}%</span>
                </div>
                <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: downloadProgress + '%', height: '100%', background: 'var(--accent)', borderRadius: 3, transition: 'width 0.3s' }} />
                </div>
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {!downloading && !downloadPathState && (
                <button className="v3-btn" onClick={() => setUpdateModal(null)}>Закрыть</button>
              )}
              {!downloading && !downloadPathState && (
                <button className="v3-btn primary" onClick={startDownload}>
                  <Download size={14} /> Скачать
                </button>
              )}
              {downloadProgress === 100 && downloadPathState && (
                <>
                  <button className="v3-btn" onClick={() => { setUpdateModal(null); setDownloadPathState(''); setDownloadProgress(0) }}>Закрыть</button>
                  <button className="v3-btn primary" onClick={installUpdate}>
                    <ExternalLink size={14} /> Установить
                  </button>
                </>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {toast && <div className="mf-toast">{toast}</div>}
    </div>
  )
}
