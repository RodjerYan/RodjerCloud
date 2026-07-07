import React, { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Command, Search } from "lucide-react"

const COMMANDS = [
  { id: "go-dashboard", label: "На главную", path: "/" },
  { id: "go-files", label: "Мои файлы", path: "/files" },
  { id: "go-upload", label: "Загрузить", path: "/upload" },
  { id: "go-autosync", label: "Авто-синхронизация", path: "/autosync" },
  { id: "go-statistics", label: "Статистика", path: "/statistics" },
  { id: "go-trash", label: "Корзина", path: "/trash" },
  { id: "go-favorites", label: "Избранное", path: "/favorites" },
  { id: "go-shared", label: "Общие ссылки", path: "/shared" },
  { id: "go-activity", label: "Журнал действий", path: "/activity" },
  { id: "go-tags", label: "Теги", path: "/tags" },
  { id: "go-search", label: "Поиск", path: "/search" },
  { id: "go-calendar", label: "Календарь", path: "/calendar" },
  { id: "go-albums", label: "Альбомы", path: "/albums" },
  { id: "go-notes", label: "Заметки", path: "/notes" },
  { id: "go-network", label: "Сеть", path: "/network" },
  { id: "go-diagnostics", label: "Диагностика", path: "/diagnostics" },
  { id: "go-settings", label: "Настройки", path: "/settings" },
  { id: "go-help", label: "Горячие клавиши", path: "/help" },
  { id: "go-about", label: "О RodjerCloud", path: "/about" },
]

export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const nav = useNavigate()
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "p" || e.key === "P")) { e.preventDefault(); setOpen(true) }
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); nav("/search") }
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [nav])
  const filtered = useMemo(() => {
    if (!q.trim()) return COMMANDS
    const ql = q.toLowerCase()
    return COMMANDS.filter(c => c.label.toLowerCase().includes(ql))
  }, [q])
  if (!open) return null
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(8px)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 100, zIndex: 1000 }} onClick={() => setOpen(false)} data-testid="cmd-palette">
      <div className="v3-card" style={{ width: 540, padding: 0 }} onClick={(e) => e.stopPropagation()}>
        <div className="v3-row" style={{ padding: "12px 14px", borderBottom: "1px solid var(--v3-border-soft)" }}>
          <Command size={16}/>
          <input autoFocus className="v3-input" placeholder="Введите команду…" value={q} onChange={(e) => setQ(e.target.value)} style={{ border: 0, background: "transparent" }} data-testid="cmd-input"/>
        </div>
        <div style={{ maxHeight: 360, overflowY: "auto", padding: 8 }}>
          {filtered.map(c => (
            <button key={c.id} className="v3-btn ghost" style={{ width: "100%", justifyContent: "flex-start", marginBottom: 4 }}
              onClick={() => { nav(c.path); setOpen(false); setQ("") }}>
              <Search size={14}/> {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
