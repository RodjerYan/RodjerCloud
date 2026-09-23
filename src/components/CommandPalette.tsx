import React, { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Command, Search } from "lucide-react"

const COMMANDS = [
  { id: "go-dashboard", label: "На главную", path: "/" },
  { id: "go-files", label: "Мои файлы", path: "/files" },
  { id: "go-upload", label: "Загрузить", path: "/upload" },
  { id: "go-autosync", label: "Авто-синхронизация", path: "/autosync" },

  { id: "go-trash", label: "Корзина", path: "/trash" },
  { id: "go-favorites", label: "Избранное", path: "/favorites" },
  { id: "go-shared", label: "Общие ссылки", path: "/shared" },
  { id: "go-activity", label: "Журнал действий", path: "/activity" },
  { id: "go-tags", label: "Теги", path: "/tags" },
  { id: "go-search", label: "Поиск", path: "/search" },
  { id: "go-calendar", label: "Календарь", path: "/calendar" },
  { id: "go-albums", label: "Альбомы", path: "/albums" },
  { id: "go-settings", label: "Настройки", path: "/settings" },
]

export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const [active, setActive] = useState(0)
  const nav = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "p" || e.key === "P")) { e.preventDefault(); setOpen(true); setActive(0); setQ("") }
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); nav("/search") }
      if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false) }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [nav, open])

  useEffect(() => {
    if (open) {
      setActive(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const filtered = useMemo(() => {
    if (!q.trim()) return COMMANDS
    const ql = q.toLowerCase()
    return COMMANDS.filter(c => c.label.toLowerCase().includes(ql))
  }, [q])

  useEffect(() => { setActive(0) }, [q])

  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-cmd-index="${active}"]`)
    el?.scrollIntoView({ block: "nearest" })
  }, [active, open, filtered.length])

  const run = (path: string) => { nav(path); setOpen(false); setQ("") }

  if (!open) return null

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(8px)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 100, zIndex: 1000 }}
      onClick={() => setOpen(false)}
      data-testid="cmd-palette"
    >
      <div className="v3-card" style={{ width: 540, padding: 0 }} onClick={(e) => e.stopPropagation()}>
        <div className="v3-row" style={{ padding: "12px 14px", borderBottom: "1px solid var(--v3-border-soft)" }}>
          <Command size={16}/>
          <input
            ref={inputRef}
            className="v3-input"
            placeholder="Введите команду…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
                e.preventDefault()
                setActive(i => (filtered.length ? (i + 1) % filtered.length : 0))
              } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
                e.preventDefault()
                setActive(i => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0))
              } else if (e.key === "Home") {
                e.preventDefault(); setActive(0)
              } else if (e.key === "End") {
                e.preventDefault(); setActive(Math.max(0, filtered.length - 1))
              } else if (e.key === "Enter") {
                e.preventDefault()
                const c = filtered[active]
                if (c) run(c.path)
              }
            }}
            style={{ border: 0, background: "transparent" }}
            data-testid="cmd-input"
            role="combobox"
            aria-expanded={true}
            aria-controls="cmd-list"
            aria-activedescendant={filtered[active] ? `cmd-opt-${filtered[active].id}` : undefined}
          />
        </div>
        <div ref={listRef} id="cmd-list" role="listbox" style={{ maxHeight: 360, overflowY: "auto", padding: 8 }}>
          {filtered.length === 0 && (
            <div className="v3-sub" style={{ padding: "12px 10px" }}>Ничего не найдено</div>
          )}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              id={`cmd-opt-${c.id}`}
              data-cmd-index={i}
              role="option"
              aria-selected={i === active}
              className="v3-btn ghost"
              style={{
                width: "100%",
                justifyContent: "flex-start",
                marginBottom: 4,
                background: i === active ? "rgba(124,131,255,0.14)" : undefined,
                outline: i === active ? "1px solid rgba(124,131,255,0.45)" : undefined
              }}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(c.path)}
            >
              <Search size={14}/> {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
