import React, { useEffect, useMemo, useState, useRef } from "react"
import { useNavigate } from "react-router-dom"
import { Search, FileText } from "lucide-react"
import { v3store, fmtBytes } from "../lib/v3store"

export default function SearchPage() {
  const [q, setQ] = useState("")
  const [debouncedQ, setDebouncedQ] = useState("")
  const [files, setFiles] = useState<any[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const nav = useNavigate()

  useEffect(() => {
    window.electronAPI?.telegram?.listFiles?.().then((r: any) => { if (r?.success) setFiles(r.data || []) })
  }, [])

  useEffect(() => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedQ(q), 300)
    return () => clearTimeout(debounceRef.current)
  }, [q])

  const results = useMemo(() => {
    if (!debouncedQ.trim()) return []
    const ql = debouncedQ.toLowerCase()
    return files.filter((f: any) => {
      const name = (f.fileName || "").toLowerCase()
      const tags = v3store.tagsForFile(f.messageId).join(" ").toLowerCase()
      const note = v3store.noteFor(f.messageId)?.markdown.toLowerCase() || ""
      return name.includes(ql) || tags.includes(ql) || note.includes(ql)
    }).slice(0, 100)
  }, [debouncedQ, files])
  return (
    <div className="v3-page" data-testid="search-page">
      <h1 className="v3-h1">Поиск</h1>
      <div className="v3-sub">Полнотекстовый поиск по именам файлов, тегам и заметкам.</div>
      <div className="v3-card" style={{ marginTop: 18 }}>
        <div className="v3-row">
          <Search size={16}/>
          <input autoFocus className="v3-input" placeholder="Поиск… (Ctrl+K)" value={q} onChange={e => setQ(e.target.value)} data-testid="search-input"/>
          <span className="v3-chip v3-num">{results.length} найдено</span>
        </div>
        <div style={{ marginTop: 14 }}>
          {results.length === 0 && debouncedQ.trim() && (
            <div className="v3-sub" style={{ padding: "10px 0" }}>Ничего не найдено</div>
          )}
          {results.map((f: any) => (
            <button
              key={f.messageId}
              type="button"
              className="v3-row"
              style={{ width: "100%", padding: "8px 0", borderBottom: "1px solid var(--v3-border-soft)", background: "transparent", border: "none", color: "inherit", textAlign: "left", cursor: "pointer" }}
              onClick={() => nav("/files")}
              title="Открыть «Мои файлы»"
            >
              <FileText size={14} style={{ flexShrink: 0, opacity: 0.7 }} />
              <div style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.fileName}</div>
              <div className="v3-sub v3-num">{fmtBytes(f.fileSize || 0)}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
