import React, { useEffect, useState } from 'react'
import { FolderOpen, Copy, AlertTriangle, Bot, Info } from 'lucide-react'

export default function SettingsPage({ channelInfo, onChangeChannel }: { channelInfo: any; onChangeChannel: () => void }) {
  const [downloadPath, setDownloadPath] = useState('')
  const [concurrency, setConcurrency] = useState(2)
  const [autoRename, setAutoRename] = useState(false)
  const [reduceAnim, setReduceAnim] = useState(false)
  const [compact, setCompact] = useState(false)
  const [toast, setToast] = useState('')
  const [botToken, setBotToken] = useState('')
  const [botConfigured, setBotConfigured] = useState(false)
  const [version, setVersion] = useState("3.0.0")

  useEffect(() => {
    (async () => {
      const a = await window.electronAPI.storage.getDownloadPath()
      if (a.success) setDownloadPath(a.data || '')
      const c = await window.electronAPI.storage.getUploadConcurrency()
      if (c.success) setConcurrency(c.data || 2)
      setAutoRename(localStorage.getItem('v2.autoRename') === '1')
      setReduceAnim(localStorage.getItem('v2.reduceAnim') === '1')
      setCompact(localStorage.getItem('v2.compact') === '1')
      if (localStorage.getItem('v2.reduceAnim') === '1') document.body.classList.add('reduce-anim')
      if (localStorage.getItem('v2.compact') === '1') document.body.classList.add('compact')
      const v = await window.electronAPI.app.getVersion()
      if (v.success && v.data) setVersion(v.data)
    })()
    window.electronAPI.share.getBotToken().then((r: any) => {
      if (r.success && r.data) { setBotConfigured(true); setBotToken(r.data) }
    })
  }, [])

  const show = (s: string) => { setToast(s); setTimeout(() => setToast(''), 1800) }

  const pickDownload = async () => {
    const r = await window.electronAPI.dialog.pickDownloadDir()
    if (r.success) {
      setDownloadPath(r.data.folderPath)
      await window.electronAPI.storage.setDownloadPath(r.data.folderPath)
      show('Сохранено')
    }
  }

  const onConcurrency = async (n: number) => {
    setConcurrency(n)
    await window.electronAPI.storage.setUploadConcurrency(n)
  }

  const toggle = (key: string, val: boolean, cls: string, setter: (v: boolean) => void) => {
    setter(val); localStorage.setItem(key, val ? '1' : '0')
    document.body.classList.toggle(cls, val)
  }

  const copyKey = async () => {
    if (!channelInfo?.token) return
    await window.electronAPI.app.copyToClipboard(channelInfo.token)
    show('Ключ скопирован')
  }

  const clearAll = async () => {
    if (!confirm('Очистить все локальные данные? Придётся заново войти.')) return
    await window.electronAPI.telegram.logout()
    onChangeChannel()
  }
  const factoryReset = async () => {
    if (!confirm('Сброс удалит ВСЕ локальные данные. Продолжить?')) return
    await window.electronAPI.storage.factoryReset()
    localStorage.clear()
    onChangeChannel()
  }
  const checkUpdates = () => {
    show('У вас последняя версия')
  }

  return (
    <div className="se-root">
      <h1>Настройки</h1>

      <section className="se-card">
        <h2>Внешний вид</h2>
        <label className="se-row"><span>Уменьшить анимации</span>
          <input type="checkbox" checked={reduceAnim} onChange={e => toggle('v2.reduceAnim', e.target.checked, 'reduce-anim', setReduceAnim)} />
        </label>
        <label className="se-row"><span>Компактный режим</span>
          <input type="checkbox" checked={compact} onChange={e => toggle('v2.compact', e.target.checked, 'compact', setCompact)} />
        </label>
      </section>

      <section className="se-card">
        <h2>Загрузка</h2>
        <div className="se-row">
          <span>Папка для скачивания</span>
          <div className="se-path"><code>{downloadPath || 'По умолчанию'}</code><button onClick={pickDownload}><FolderOpen size={14} /> Изменить</button></div>
        </div>
      </section>

      <section className="se-card">
        <h2>Отправка</h2>
        <label className="se-row"><span>Авто-переименование при совпадении</span>
          <input type="checkbox" checked={autoRename} onChange={e => { setAutoRename(e.target.checked); localStorage.setItem('v2.autoRename', e.target.checked ? '1' : '0') }} />
        </label>
        <div className="se-row"><span>Одновременных загрузок</span>
          <input type="number" min={1} max={5} value={concurrency} onChange={e => onConcurrency(Math.max(1, Math.min(5, parseInt(e.target.value) || 1)))} style={{ width: 80 }} />
        </div>
      </section>

      <section className="se-card">
        <h2>Канал</h2>
        <div className="se-row"><span>Подключённый канал</span><strong>{channelInfo?.title || '—'}</strong></div>
        {channelInfo?.token && (
          <div className="se-row"><span>Ключ канала</span>
            <div className="se-path"><code>{String(channelInfo.token).slice(0, 12)}…</code>
              <button onClick={copyKey}><Copy size={14} /> Копировать ключ</button></div>
          </div>
        )}
        <button className="se-secondary" onClick={onChangeChannel}>Сменить канал</button>
      </section>

      <section className="se-card">
        <h2><Bot size={16} /> Бот для ссылок</h2>
        <div className="se-row"><span>Токен бота</span>
          {botConfigured ? <span style={{ color: 'var(--accent-1)' }}>✓ Настроен</span> : <span style={{ color: 'var(--red)' }}>Не настроен</span>}
        </div>
        <div className="se-row" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
          <input value={botToken} onChange={e => setBotToken(e.target.value)}
            placeholder="Введите токен бота: 123456:ABCdef..."
            style={{ background: 'var(--bg)', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '10px 12px', color: 'var(--text)', fontSize: 13, outline: 'none', fontFamily: 'monospace' }} />
          <button className="se-secondary" onClick={async () => {
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

      <section className="se-card se-danger">
        <h2><AlertTriangle size={16} /> Опасная зона</h2>
        <button className="se-warn" onClick={clearAll}>Очистить локальные данные</button>
        <button className="se-warn" onClick={factoryReset}>Сброс настроек</button>
      </section>

      <section className="se-card">
        <h2><Info size={16} /> О программе</h2>
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ width: 72, height: 72, borderRadius: 20, background: 'var(--accent)', display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 700, color: '#fff', marginBottom: 8 }}>CS</div>
          <h3 style={{ margin: '4px 0' }}>RodjerCloud</h3>
          <div style={{ color: 'var(--accent-1)', fontSize: 13, marginBottom: 12 }}>v{version} — 100+ возможностей</div>
          <p style={{ color: 'var(--text-dim)', lineHeight: 1.55, maxWidth: 500, margin: '0 auto 16px', fontSize: 13 }}>
            RodjerCloud превращает ваш приватный Telegram-канал в безлимитное облачное хранилище.
            Без шифрования, без ежемесячной платы, полностью в вашем распоряжении.
          </p>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
            {['Electron','React','TypeScript','gramjs','chokidar'].map(s => (
              <span key={s} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--v3-border-soft)',
                padding: '4px 10px', borderRadius: 99, fontSize: 11, color: 'var(--v3-text-mute)' }}>{s}</span>
            ))}
          </div>
          <button className="se-secondary" onClick={checkUpdates}>Проверить обновления</button>
          <div style={{ marginTop: 16, fontSize: 12, color: 'var(--v3-text-mute)' }}>Распространяется под лицензией MIT</div>
        </div>
      </section>

      {toast && <div className="mf-toast">{toast}</div>}
    </div>
  )
}
