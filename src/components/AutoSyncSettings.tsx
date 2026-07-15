import React, { useState, useEffect } from 'react'

interface AutoSyncSettingsProps {
  onClose: () => void
}

interface SyncConfig {
  enabled: boolean
  mode: 'all' | 'custom'
  customPaths: string[]
  fileFilters: { enabled: boolean; extensions: string[] }
  excludePatterns: string[]
}

const AutoSyncSettings: React.FC<AutoSyncSettingsProps> = ({ onClose }) => {
  const [config, setConfig] = useState<SyncConfig>({
    enabled: false, mode: 'custom', customPaths: [],
    fileFilters: { enabled: false, extensions: [] },
    excludePatterns: ['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information'],
  })
  const [syncStatus, setSyncStatus] = useState<any>(null)
  const [newExtension, setNewExtension] = useState('')
  const [newExclude, setNewExclude] = useState('')

  useEffect(() => {
    loadConfig(); loadStatus()
    const api: any = (window as any).electronAPI
    const unsub = api.autoSync.onStatus((data: any) => {
      loadStatus()
    })
    return () => { if (unsub) unsub() }
  }, [])

  const loadConfig = async () => {
    const api: any = (window as any).electronAPI
    const r = await api.autoSync.getConfig()
    if (r.success && r.data) setConfig(r.data)
  }
  const loadStatus = async () => {
    const api: any = (window as any).electronAPI
    const r = await api.autoSync.getStatus()
    if (r.success && r.data) setSyncStatus(r.data)
  }
  const saveConfig = async (c: SyncConfig) => {
    const api: any = (window as any).electronAPI
    await api.autoSync.updateConfig(c)
    setConfig(c)
    if (c.enabled) await api.autoSync.start()
    else await api.autoSync.stop()
    loadStatus()
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '90%', maxWidth: 640, maxHeight: '85vh', overflow: 'auto',
        background: 'rgba(15,18,30,0.85)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)', border: '1px solid var(--border-strong)',
        borderRadius: 20, boxShadow: '0 25px 60px rgba(0,0,0,0.6)',
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '22px 28px', borderBottom: '1px solid var(--border)',
        }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, background: 'var(--v3-grad-cool)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>
            Настройки авто-синхронизации
          </h2>
          <button onClick={onClose} style={{
            width: 34, height: 34, borderRadius: 10,
            background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)',
            color: 'var(--text-dim)', cursor: 'pointer', fontSize: 16,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>✕</button>
        </div>

        <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 24 }}>

          {syncStatus?.isRunning && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px',
              background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.3)',
              borderRadius: 12, fontSize: 13, color: '#34d399', fontWeight: 600,
            }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#34d399', boxShadow: '0 0 10px #34d399' }} />
              Активна • {syncStatus.queueLength} файл(ов) в очереди
            </div>
          )}

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 15 }}>Включить авто-синхронизацию</div>
                <div className="v3-sub" style={{ fontSize: 13, marginTop: 2 }}>Автоматически загружать файлы из отслеживаемых папок</div>
              </div>
              <label style={{ position: 'relative', display: 'inline-block', width: 50, height: 26, flexShrink: 0 }}>
                <input type="checkbox" checked={config.enabled}
                  onChange={() => saveConfig({ ...config, enabled: !config.enabled })}
                  style={{ opacity: 0, width: 0, height: 0 }} />
                <span style={{
                  position: 'absolute', cursor: 'pointer', inset: 0,
                  background: config.enabled ? 'linear-gradient(135deg, #7cc8ff, #a855f7)' : 'rgba(255,255,255,0.1)',
                  border: '1px solid var(--border)', borderRadius: 99, transition: '0.3s',
                }}>
                  <span style={{
                    position: 'absolute', content: '', height: 18, width: 18, borderRadius: '50%',
                    background: 'white', transition: '0.3s',
                    left: config.enabled ? 28 : 3, top: 3,
                  }} />
                </span>
              </label>
            </div>
          </div>

          {config.enabled && (
            <>
              <div>
                <div style={{ fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-dim)', marginBottom: 12 }}>Режим синхронизации</div>
                <div style={{ display: 'flex', gap: 10 }}>
                  {[
                    { key: 'all' as const, icon: '📁', title: 'Все папки', desc: 'Стандартные папки пользователя' },
                    { key: 'custom' as const, icon: '📂', title: 'Только выбранные', desc: 'Конкретные папки для отслеживания' },
                  ].map(opt => (
                    <div key={opt.key} onClick={() => saveConfig({ ...config, mode: opt.key })} style={{
                      flex: 1, padding: '14px 16px', borderRadius: 14, cursor: 'pointer',
                      border: `2px solid ${config.mode === opt.key ? 'rgba(124,200,255,0.45)' : 'var(--border)'}`,
                      background: config.mode === opt.key ? 'rgba(124,200,255,0.06)' : 'rgba(255,255,255,0.02)',
                      transition: 'all 0.2s',
                    }}>
                      <div style={{ fontSize: 24, marginBottom: 6 }}>{opt.icon}</div>
                      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>{opt.title}</div>
                      <div className="v3-sub" style={{ fontSize: 12 }}>{opt.desc}</div>
                    </div>
                  ))}
                </div>
              </div>

              {config.mode === 'custom' && (
                <div>
                  <div style={{ fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-dim)', marginBottom: 10 }}>Пользовательские папки</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                    {config.customPaths.length === 0 ? (
                      <div className="v3-sub" style={{ textAlign: 'center', padding: '16px 0' }}>Папки ещё не добавлены</div>
                    ) : config.customPaths.map((p, i) => (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                        background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: 10,
                      }}>
                        <span style={{ fontSize: 16 }}>📁</span>
                        <span style={{ flex: 1, fontSize: 13 }}>{p}</span>
                        <button onClick={() => saveConfig({ ...config, customPaths: config.customPaths.filter((_, j) => j !== i) })}
                          style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 12 }}>
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  <button className="v3-btn primary" onClick={async () => {
                    const api: any = (window as any).electronAPI
                    const r = await api.dialog.pickFolder()
                    if (r.success && r.data?.folderPath) {
                      saveConfig({ ...config, customPaths: [...config.customPaths, r.data.folderPath] })
                    }
                  }} style={{ width: '100%', justifyContent: 'center' }}>
                    + Добавить папку
                  </button>
                </div>
              )}

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>Фильтры типов файлов</div>
                    <div className="v3-sub" style={{ fontSize: 13 }}>Синхронизировать только определённые типы</div>
                  </div>
                  <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24, flexShrink: 0 }}>
                    <input type="checkbox" checked={config.fileFilters.enabled}
                      onChange={() => saveConfig({ ...config, fileFilters: { ...config.fileFilters, enabled: !config.fileFilters.enabled } })}
                      style={{ opacity: 0, width: 0, height: 0 }} />
                    <span style={{
                      position: 'absolute', cursor: 'pointer', inset: 0,
                      background: config.fileFilters.enabled ? 'linear-gradient(135deg, #7cc8ff, #a855f7)' : 'rgba(255,255,255,0.1)',
                      border: '1px solid var(--border)', borderRadius: 99, transition: '0.3s',
                    }}>
                      <span style={{
                        position: 'absolute', height: 16, width: 16, borderRadius: '50%', background: 'white', transition: '0.3s',
                        left: config.fileFilters.enabled ? 24 : 3, top: 3,
                      }} />
                    </span>
                  </label>
                </div>
                {config.fileFilters.enabled && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{
                      display: 'flex', flexWrap: 'wrap', gap: 6, minHeight: 38,
                      padding: 10, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: 10,
                    }}>
                      {config.fileFilters.extensions.length === 0 ? (
                        <div className="v3-sub" style={{ fontSize: 12, width: '100%', textAlign: 'center', padding: '4px 0' }}>Все типы файлов будут синхронизироваться</div>
                      ) : config.fileFilters.extensions.map((ext, i) => (
                        <span key={i} className="v3-chip" style={{ paddingRight: 4 }}>
                          {ext}
                          <button onClick={() => saveConfig({ ...config, fileFilters: { ...config.fileFilters, extensions: config.fileFilters.extensions.filter((_, j) => j !== i) } })}
                            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, display: 'flex', opacity: 0.6, fontSize: 12 }}>
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                    <div className="v3-row">
                      <input className="v3-input" placeholder=".jpg, .png, .pdf…" value={newExtension}
                        onChange={e => setNewExtension(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { const ext = newExtension.trim(); if (ext) { if (!config.fileFilters.extensions.includes(ext)) saveConfig({ ...config, fileFilters: { ...config.fileFilters, extensions: [...config.fileFilters.extensions, ext] } }); setNewExtension('') } } }}
                        style={{ flex: 1 }} />
                      <button className="v3-btn primary" onClick={() => { const ext = newExtension.trim(); if (ext) { if (!config.fileFilters.extensions.includes(ext)) saveConfig({ ...config, fileFilters: { ...config.fileFilters, extensions: [...config.fileFilters.extensions, ext] } }); setNewExtension('') } }}>
                        Добавить
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <div style={{ fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-dim)', marginBottom: 10 }}>Исключения</div>
                <div style={{
                  display: 'flex', flexWrap: 'wrap', gap: 6, minHeight: 38,
                  padding: 10, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 10,
                }}>
                  {config.excludePatterns.map((p, i) => (
                    <span key={i} className="v3-chip warm" style={{ paddingRight: 4 }}>
                      {p}
                      <button onClick={() => saveConfig({ ...config, excludePatterns: config.excludePatterns.filter((_, j) => j !== i) })}
                        style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, display: 'flex', opacity: 0.6 }}>
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
                <div className="v3-row">
                  <input className="v3-input" placeholder="*.tmp, *.log…" value={newExclude}
                    onChange={e => setNewExclude(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { const v = newExclude.trim(); if (v) { saveConfig({ ...config, excludePatterns: [...config.excludePatterns, v] }); setNewExclude('') } } }}
                    style={{ flex: 1 }} />
                  <button className="v3-btn primary" onClick={() => { const v = newExclude.trim(); if (v) { saveConfig({ ...config, excludePatterns: [...config.excludePatterns, v] }); setNewExclude('') } }}>
                    Добавить
                  </button>
                </div>
              </div>

              {syncStatus?.watchPaths?.length > 0 && (
                <div>
                  <div style={{ fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-dim)', marginBottom: 10 }}>Сейчас отслеживается</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {syncStatus.watchPaths.map((p: string, i: number) => (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                        background: 'rgba(52,211,153,0.05)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: 8, fontSize: 12,
                      }}>
                        <span>👁️</span>
                        <span>{p}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ padding: '16px 28px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
          <button className="v3-btn" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}

export default AutoSyncSettings
