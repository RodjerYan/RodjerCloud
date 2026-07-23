import React, { useEffect, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Bot, Info, Download, ExternalLink, HardDrive, Link2, Lock, CheckCircle2 } from 'lucide-react'
import confetti from 'canvas-confetti'
import iconUrl from '../assets/icon.png'
import { toast } from '../lib/toast'

export default function SettingsPage({ channelInfo, onChangeChannel, updateAvailable }: { channelInfo: any; onChangeChannel: () => void; updateAvailable?: boolean }) {
  const [concurrency, setConcurrency] = useState(2)
  const [autoRename, setAutoRename] = useState(false)
  const [turboMode, setTurboMode] = useState(false)
  const [botToken, setBotToken] = useState('')
  const pwdInputRef = useRef<HTMLInputElement>(null)
  const [botConfigured, setBotConfigured] = useState(false)
  const [version, setVersion] = useState("")
  const [showPwdPrompt, setShowPwdPrompt] = useState(false)
  const [checkingOldPwd, setCheckingOldPwd] = useState(false)
  const [pwdError, setPwdError] = useState('')

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
      const tm = await window.electronAPI.storage.getTurboMode?.()
      if (tm?.success) setTurboMode(tm.data || false)
      setAutoRename(localStorage.getItem('v2.autoRename') === '1')
      const v = await window.electronAPI.app.getVersion()
      if (v.success && v.data) setVersion(v.data)
    })()
    window.electronAPI.share.getBotToken().then((r: any) => {
      if (r.success && r.data) { setBotConfigured(true); setBotToken(r.data) }
    })
  }, [])

  const onConcurrency = async (n: number) => {
    setConcurrency(n)
    await window.electronAPI.storage.setUploadConcurrency(n)
  }

  const copyKey = async () => {
    if (!channelInfo?.token) return
    await window.electronAPI.app.copyToClipboard(channelInfo.token)
    toast.success('Ключ скопирован')
  }

  const checkUpdates = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (rect.left + rect.width / 2) / window.innerWidth
    const y = (rect.top + rect.height / 2) / window.innerHeight

    setCheckingUpdate(true)
    const r = await window.electronAPI.app.checkUpdate()
    setCheckingUpdate(false)
    if (r.success && r.data) {
      setUpdateModal(r.data)
      if (!r.data.hasUpdate) {
        toast.success('У вас последняя версия')
        confetti({
          particleCount: 100,
          spread: 70,
          origin: { x, y },
          colors: ['#7c83ff', '#b14aff', '#ffffff']
        })
      }
    } else {
      toast.error(r.error || 'Ошибка проверки обновлений')
    }
  }

  const startDownload = async () => {
    if (!updateModal?.assetId) { toast.error('Ошибка: файл обновления не найден'); return }
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
      toast.error(r.error || 'Ошибка загрузки')
      setDownloading(false)
    }
  }

  const installUpdate = async () => {
    if (!downloadPathState) return
    const r = await window.electronAPI.app.installUpdate(downloadPathState)
    if (!r.success) {
      toast.error(r.error || 'Ошибка запуска установщика')
    }
    setDownloading(false)
    setUpdateModal(null)
  }

  return (
    <div className="se-root">
      <h1>Настройки</h1>

      <div className="settings-card">
        <div className="settings-header">
          <HardDrive size={18} className="settings-header-icon" />
          <h2>Загрузка и отправка</h2>
        </div>
        <div className="settings-body">
          <label className="settings-row">
            <div className="settings-info">
              <div className="settings-title">Всегда спрашивать куда загружать файлы</div>
              <div className="settings-desc">Выбирать папку для сохранения скачиваемых файлов вручную</div>
            </div>
            <div className="v3-switch">
              <input type="checkbox" checked={askDownloadPath} onChange={e => { setAskDownloadPath(e.target.checked); window.electronAPI.storage.setAskDownloadPath(e.target.checked) }} />
              <div className="v3-switch-knob"></div>
            </div>
          </label>
          <div className="settings-divider" />
          <label className="settings-row">
            <div className="settings-info">
              <div className="settings-title">Авто-переименование при совпадении</div>
              <div className="settings-desc">Автоматически добавлять (1) к имени файла при конфликте имён</div>
            </div>
            <div className="v3-switch">
              <input type="checkbox" checked={autoRename} onChange={e => { setAutoRename(e.target.checked); localStorage.setItem('v2.autoRename', e.target.checked ? '1' : '0') }} />
              <div className="v3-switch-knob"></div>
            </div>
          </label>
          <div className="settings-divider" />
          <div className="settings-row">
            <div className="settings-info">
              <div className="settings-title">Одновременных загрузок</div>
              <div className="settings-desc">Количество файлов, загружаемых параллельно (до 5)</div>
            </div>
            <input type="number" min={1} max={5} value={concurrency} onChange={e => onConcurrency(Math.max(1, Math.min(5, parseInt(e.target.value) || 1)))} style={{ width: 60, textAlign: 'center', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', color: 'var(--text)', padding: '6px', borderRadius: '8px' }} />
          </div>
          <div className="settings-divider" />
          <label className="settings-row">
            <div className="settings-info">
              <div className="settings-title">🚀 Турбо-режим загрузки</div>
              <div className="settings-desc">Агрессивное многопоточное разделение (до 16 потоков). Увеличивает скорость, но сильно нагружает сеть.</div>
            </div>
            <div className="v3-switch">
              <input type="checkbox" checked={turboMode} onChange={e => { setTurboMode(e.target.checked); window.electronAPI.storage.setTurboMode?.(e.target.checked) }} />
              <div className="v3-switch-knob"></div>
            </div>
          </label>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-header">
          <Lock size={18} className="settings-header-icon" />
          <h2>Безопасность</h2>
        </div>
        <div className="settings-body">
          <div className="settings-row">
            <div className="settings-info">
              <div className="settings-title">Мастер-пароль Сейфа</div>
              <div className="settings-desc">Сменить пароль для сквозного шифрования (Внимание: старые файлы не откроются с новым паролем)</div>
            </div>
            <button className="v3-btn" onClick={async () => {
              const has = await window.electronAPI.vault.hasPassword()
              setCheckingOldPwd(has)
              setPwdError('')
              setShowPwdPrompt(true)
            }}>Изменить</button>
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-header">
          <Link2 size={18} className="settings-header-icon" />
          <h2>Канал</h2>
        </div>
        <div className="settings-body">
          <div className="settings-row">
            <div className="settings-info">
              <div className="settings-title">Подключённый канал</div>
              <div className="settings-desc">Текущий канал, используемый для хранения файлов</div>
            </div>
            <strong style={{ fontSize: 15 }}>{channelInfo?.channelName || channelInfo?.title || '—'}</strong>
          </div>
          {channelInfo?.channelId && (
            <>
              <div className="settings-divider" />
              <div className="settings-row">
                <div className="settings-info">
                  <div className="settings-title">ID канала</div>
                  <div className="settings-desc">Идентификатор канала в Telegram</div>
                </div>
                <code style={{ fontSize: 13 }}>{channelInfo.channelId}</code>
              </div>
            </>
          )}
          {channelInfo?.token && (
            <>
              <div className="settings-divider" />
              <div className="settings-row">
                <div className="settings-info">
                  <div className="settings-title">Ключ канала</div>
                  <div className="settings-desc">Ключ для авторизации в этом канале</div>
                </div>
                <div className="se-path">
                  <code>{String(channelInfo.token).slice(0, 12)}…</code>
                  <button onClick={copyKey}><Copy size={14} /> Копировать</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-header">
          <Bot size={18} className="settings-header-icon" />
          <h2>Бот для ссылок</h2>
        </div>
        <div className="settings-body">
          <div className="settings-row">
            <div className="settings-info">
              <div className="settings-title">Токен бота</div>
              <div className="settings-desc">Позволяет генерировать прямые ссылки на файлы</div>
            </div>
            {botConfigured ? <span style={{ color: 'var(--success)', fontWeight: 500, fontSize: 13, background: 'rgba(52,211,153,0.1)', padding: '4px 10px', borderRadius: 99 }}>✓ Настроен</span> : <span style={{ color: 'var(--danger)', fontWeight: 500, fontSize: 13, background: 'rgba(248,113,113,0.1)', padding: '4px 10px', borderRadius: 99 }}>Не настроен</span>}
          </div>
          <div style={{ display: 'flex', gap: 10, paddingBottom: 16 }}>
            <input type={botConfigured ? "password" : "text"} value={botToken} onChange={e => setBotToken(e.target.value)}
              placeholder="Введите токен бота: 123456:ABCdef..."
              style={{ flex: 1, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', color: 'var(--text)', fontSize: 13, outline: 'none', fontFamily: 'var(--font-mono, monospace)' }} />
            <button className="v3-btn primary" onClick={async () => {
              if (!botToken.trim()) return toast.error('Введите токен')
              const r = await window.electronAPI.share.setBotToken(botToken.trim())
              if (r.success) { setBotConfigured(true); toast.success('Токен сохранён') }
              else toast.error(r.error || 'Ошибка')
            }}>Сохранить</button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6, paddingBottom: 16, borderTop: '1px solid var(--border-soft)', paddingTop: 16 }}>
            Инструкция: зайдите в @BotFather → создайте бота → добавьте его администратором вашего канала → напишите боту /start
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-header">
          <Info size={18} className="settings-header-icon" />
          <h2>О программе</h2>
        </div>
        <div className="se-about-wrapper">
          <img src={iconUrl} alt="RodjerCloud" className="se-logo" />
          <h3 className="se-app-name">RodjerCloud</h3>
          <div className="se-app-version">{version ? `Версия ${version}` : ''}</div>
          <p className="se-app-desc">
            RodjerCloud превращает ваш приватный Telegram-канал в безлимитное облачное хранилище.
            Полный контроль, никаких лимитов на объем и отсутствие абонентской платы.
          </p>

          <button className="v3-btn primary se-update-btn" onClick={checkUpdates} disabled={checkingUpdate}>
            {checkingUpdate ? <Download size={16} /> : <CheckCircle2 size={16} />}
            {checkingUpdate ? 'Проверка обновлений…' : 'Проверить обновления'}
          </button>
          {updateAvailable && !checkingUpdate && (
            <div className="se-update-hint">Доступно обновление</div>
          )}

          <div className="se-app-license">Распространяется под лицензией MIT</div>
        </div>
      </div>

      {updateModal && updateModal.hasUpdate && createPortal(
        <div className="se-modal-overlay" onClick={() => { if (!downloading) setUpdateModal(null) }}>
          <div className="settings-card se-modal-content" onClick={e => e.stopPropagation()} style={{ margin: 0 }}>
            <h3 className="se-modal-title">Доступно обновление v{updateModal.latestVersion}</h3>
            <div className="se-modal-version">Текущая версия: v{updateModal.currentVersion}</div>
            
            {updateModal.releaseNotes && (
              <div className="se-modal-notes">
                {updateModal.releaseNotes}
              </div>
            )}
            
            {downloading ? (
              <div className="se-modal-progress">
                <div className="se-modal-progress-text">
                  <span>Загрузка…</span><span>{downloadProgress}%</span>
                </div>
                <div className="se-modal-progress-bar-wrap">
                  <div className="se-modal-progress-bar" style={{ width: downloadProgress + '%' }} />
                </div>
              </div>
            ) : null}
            
            <div className="se-modal-actions">
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

      {showPwdPrompt && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="v3-card" style={{ padding: 24, width: 400, maxWidth: '90%', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <h3 style={{ margin: 0 }}>{checkingOldPwd ? 'Подтверждение пароля' : 'Изменение мастер-пароля'}</h3>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--text-mute)' }}>
              {checkingOldPwd 
                ? 'Введите ваш текущий мастер-пароль для продолжения.'
                : 'Внимание: Изменение пароля сделает старые зашифрованные файлы недоступными!'}
            </p>
            <input type="password" ref={pwdInputRef} placeholder={checkingOldPwd ? 'Текущий мастер-пароль' : 'Новый мастер-пароль'} style={{ padding: '12px 16px', borderRadius: 8, border: `1px solid ${pwdError ? '#e74c3c' : 'var(--border)'}`, background: 'var(--bg-card)', color: 'var(--text-main)', width: '100%', boxSizing: 'border-box', fontSize: 16 }} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') document.getElementById('vault-btn-ok')?.click() }} onChange={() => setPwdError('')} />
            {pwdError && <div style={{ color: '#e74c3c', fontSize: 13, marginTop: -8 }}>{pwdError}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="v3-btn ghost" onClick={() => setShowPwdPrompt(false)}>Отмена</button>
              <button id="vault-btn-ok" className="v3-btn primary" onClick={async () => {
                const input = pwdInputRef.current
                if (!input) return
                const pwd = input.value
                if (!pwd) return
                if (checkingOldPwd) {
                  const ok = await window.electronAPI.vault.checkPassword(pwd)
                  if (!ok) {
                    setPwdError('Неверный пароль!')
                    return
                  }
                  setCheckingOldPwd(false)
                  setPwdError('')
                  input.value = ''
                  input.focus()
                } else {
                  await window.electronAPI.vault.setPassword(pwd)
                  setShowPwdPrompt(false)
                  toast.success('Пароль успешно изменен')
                }
              }}>{checkingOldPwd ? 'Далее' : 'Сохранить'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
