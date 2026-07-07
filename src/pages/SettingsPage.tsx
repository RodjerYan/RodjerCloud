import React, { useEffect, useState } from 'react'
import { FolderOpen, Copy, AlertTriangle } from 'lucide-react'

export default function SettingsPage({ channelInfo, onChangeChannel }: { channelInfo: any; onChangeChannel: () => void }) {
  const [downloadPath, setDownloadPath] = useState('')
  const [concurrency, setConcurrency] = useState(2)
  const [autoRename, setAutoRename] = useState(false)
  const [reduceAnim, setReduceAnim] = useState(false)
  const [compact, setCompact] = useState(false)
  const [toast, setToast] = useState('')

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
    })()
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

      <section className="se-card se-danger">
        <h2><AlertTriangle size={16} /> Опасная зона</h2>
        <button className="se-warn" onClick={clearAll}>Очистить локальные данные</button>
        <button className="se-warn" onClick={factoryReset}>Сброс настроек</button>
      </section>

      {toast && <div className="mf-toast">{toast}</div>}
    </div>
  )
}
