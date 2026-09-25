import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Bot, Info, Download, ExternalLink, HardDrive, Link2, Lock, CheckCircle2, ArrowRight, X, Rocket } from 'lucide-react'
import confetti from 'canvas-confetti'
import iconUrl from '../assets/icon.png'
import { toast } from '../lib/toast'

/** Light release-notes renderer: ##/### headings, - lists, **bold**, `code`. Safe (no HTML). */
function renderReleaseNotes(raw: string): React.ReactNode {
  if (!raw) return null
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const nodes: React.ReactNode[] = []
  let listItems: string[] = []
  let key = 0

  const flushList = () => {
    if (listItems.length === 0) return
    nodes.push(
      <ul key={`ul-${key++}`} className="se-notes-list">
        {listItems.map((item, i) => (
          <li key={i}>{inlineFmt(item)}</li>
        ))}
      </ul>
    )
    listItems = []
  }

  const inlineFmt = (text: string): React.ReactNode[] => {
    // split on **bold** and `code`
    const parts: React.ReactNode[] = []
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
    let last = 0
    let m: RegExpExecArray | null
    let i = 0
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parts.push(text.slice(last, m.index))
      const tok = m[0]
      if (tok.startsWith('**')) {
        parts.push(<strong key={i++}>{tok.slice(2, -2)}</strong>)
      } else {
        parts.push(<code key={i++}>{tok.slice(1, -1)}</code>)
      }
      last = m.index + tok.length
    }
    if (last < text.length) parts.push(text.slice(last))
    return parts
  }

  for (const line of lines) {
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      flushList()
      const level = h[1].length
      nodes.push(
        <div key={key++} className={level <= 2 ? 'se-notes-h' : 'se-notes-h3'}>
          {inlineFmt(h[2])}
        </div>
      )
      continue
    }
    const li = line.match(/^\s*[-*+]\s+(.*)$/)
    if (li) {
      listItems.push(li[1])
      continue
    }
    if (/^\s*$/.test(line)) {
      flushList()
      continue
    }
    flushList()
    nodes.push(
      <p key={key++} className="se-notes-p">
        {inlineFmt(line)}
      </p>
    )
  }
  flushList()
  return nodes
}

export default function SettingsPage({ channelInfo, onChangeChannel, updateAvailable }: { channelInfo: any; onChangeChannel: () => void; updateAvailable?: boolean }) {
  const [concurrency, setConcurrency] = useState(5)
  const [concurrencyDraft, setConcurrencyDraft] = useState(5)
  const [concurrencySaved, setConcurrencySaved] = useState(true)
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
  const modalCardRef = useRef<HTMLDivElement>(null)
  const primaryBtnRef = useRef<HTMLButtonElement>(null)
  const prevFocusRef = useRef<HTMLElement | null>(null)

  const closeModal = useCallback(() => {
    if (downloading) return
    setUpdateModal(null)
    setDownloadPathState('')
    setDownloadProgress(0)
  }, [downloading])

  // Focus trap + Esc for update modal
  useEffect(() => {
    if (!updateModal?.hasUpdate) return
    prevFocusRef.current = document.activeElement as HTMLElement | null
    const raf = requestAnimationFrame(() => primaryBtnRef.current?.focus())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (!downloading) {
          setUpdateModal(null)
          setDownloadPathState('')
          setDownloadProgress(0)
        }
        return
      }
      if (e.key === 'Tab') {
        const root = modalCardRef.current
        if (!root) return
        const list = Array.from(
          root.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')
        )
        if (list.length === 0) {
          e.preventDefault()
          return
        }
        const first = list[0]
        const last = list[list.length - 1]
        const active = document.activeElement
        if (e.shiftKey) {
          if (active === first || !root.contains(active)) {
            e.preventDefault()
            last.focus()
          }
        } else if (active === last || !root.contains(active)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      cancelAnimationFrame(raf)
      const el = prevFocusRef.current
      prevFocusRef.current = null
      if (el && typeof el.focus === 'function' && document.contains(el)) el.focus()
    }
  }, [updateModal?.hasUpdate, downloading])

  const notesNode = useMemo(
    () => (updateModal?.releaseNotes ? renderReleaseNotes(updateModal.releaseNotes) : null),
    [updateModal?.releaseNotes]
  )

  useEffect(() => {
    (async () => {
      const a = await window.electronAPI.storage.getAskDownloadPath()
      if (a.success) setAskDownloadPath(a.data || false)
      const c = await window.electronAPI.storage.getUploadConcurrency()
      if (c.success) { setConcurrency(c.data || 5); setConcurrencyDraft(c.data || 5) }
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

  const saveConcurrency = async () => {
    await window.electronAPI.storage.setUploadConcurrency(concurrencyDraft)
    setConcurrency(concurrencyDraft)
    setConcurrencySaved(true)
    toast.success('Сохранено')
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
    const unsub = window.electronAPI.app.onDownloadProgress((p: { percent: number }) => {
      setDownloadProgress(p.percent)
    })
    const r = await window.electronAPI.app.downloadUpdate(updateModal.assetId, updateModal.assetName, updateModal.latestVersion)
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
              <div className="settings-desc">По одной — стабильный режим для больших файлов</div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="number" min={1} max={1} value={1} disabled
                style={{ width: 60, textAlign: 'center', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', color: 'var(--text)', padding: '6px', borderRadius: '8px' }} />
              <button onClick={saveConcurrency} disabled
                style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: concurrencySaved ? 'rgba(255,255,255,0.05)' : '#7c83ff', color: concurrencySaved ? 'rgba(255,255,255,0.3)' : '#fff', fontWeight: 600, fontSize: 13, cursor: concurrencySaved ? 'default' : 'pointer', transition: 'background 0.2s, color 0.2s' }}>
                Стабильный режим
              </button>
            </div>
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
        <div
          className="se-modal-overlay"
          onClick={closeModal}
          role="presentation"
        >
          <div
            ref={modalCardRef}
            className="se-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="se-upd-title"
            aria-describedby="se-upd-ver"
            tabIndex={-1}
            onClick={e => e.stopPropagation()}
          >
            <button
              type="button"
              className="se-modal-x"
              onClick={closeModal}
              disabled={downloading}
              aria-label="Закрыть"
            >
              <X size={16} />
            </button>

            <div className="se-modal-hero">
              <div className="se-modal-icon" aria-hidden>
                <Rocket size={28} strokeWidth={1.75} />
              </div>
              <h3 id="se-upd-title" className="se-modal-title">
                Доступно обновление
              </h3>
              <p id="se-upd-ver" className="se-modal-sub">
                Установите свежую версию — займёт пару минут
              </p>
            </div>

            <div className="se-modal-versions" aria-label="Версии">
              <span className="se-ver-chip current">
                <span className="se-ver-label">сейчас</span>
                <span className="se-ver-num">v{updateModal.currentVersion}</span>
              </span>
              <ArrowRight size={16} className="se-ver-arrow" aria-hidden />
              <span className="se-ver-chip next">
                <span className="se-ver-label">новая</span>
                <span className="se-ver-num">v{updateModal.latestVersion}</span>
              </span>
            </div>

            {notesNode && (
              <div className="se-modal-notes" id="se-upd-notes">
                <div className="se-notes-label">Что нового</div>
                <div className="se-notes-body">{notesNode}</div>
              </div>
            )}

            {downloading && (
              <div className="se-modal-progress" role="progressbar" aria-valuenow={downloadProgress} aria-valuemin={0} aria-valuemax={100} aria-label="Загрузка обновления">
                <div className="se-modal-progress-text">
                  <span>
                    {downloadProgress < 100 ? 'Загрузка обновления…' : 'Готово к установке'}
                  </span>
                  <span className="se-progress-pct">{downloadProgress}%</span>
                </div>
                <div className="se-modal-progress-bar-wrap">
                  <div className="se-modal-progress-bar" style={{ width: downloadProgress + '%' }} />
                </div>
              </div>
            )}

            <div className="se-modal-actions">
              {!downloading && !downloadPathState && (
                <>
                  <button type="button" className="v3-btn ghost" onClick={closeModal}>
                    Позже
                  </button>
                  <button
                    ref={primaryBtnRef}
                    type="button"
                    className="v3-btn primary se-modal-cta"
                    onClick={startDownload}
                  >
                    <Download size={15} />
                    Обновить до v{updateModal.latestVersion}
                  </button>
                </>
              )}
              {downloading && (
                <button type="button" className="v3-btn" disabled>
                  Не закрывайте приложение
                </button>
              )}
              {downloadProgress === 100 && downloadPathState && (
                <>
                  <button type="button" className="v3-btn ghost" onClick={closeModal}>
                    Позже
                  </button>
                  <button
                    ref={primaryBtnRef}
                    type="button"
                    className="v3-btn primary se-modal-cta"
                    onClick={installUpdate}
                  >
                    <ExternalLink size={15} />
                    Установить сейчас
                  </button>
                </>
              )}
            </div>

            {updateModal.htmlUrl && (
              <a
                className="se-modal-notes-link"
                href={updateModal.htmlUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Полные заметки на GitHub
                <ExternalLink size={12} />
              </a>
            )}
          </div>
        </div>,
        document.body
      )}

      {showPwdPrompt && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setShowPwdPrompt(false)}>
          <div className="v3-card" style={{ padding: 24, width: 400, maxWidth: '90%', display: 'flex', flexDirection: 'column', gap: 16 }} onClick={e => e.stopPropagation()}>
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
