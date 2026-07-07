import React, { useEffect, useState } from "react"
import { Activity, Trash2 } from "lucide-react"
import { v3store } from "../lib/v3store"

export default function ActivityPage() {
  const [items, setItems] = useState(v3store.getActivity())
  const [q, setQ] = useState("")
  const [type, setType] = useState<string>("")
  useEffect(() => { setItems(v3store.getActivity()) }, [])
  const filtered = items.filter(i =>
    (!q || i.message.toLowerCase().includes(q.toLowerCase())) && (!type || i.type === type))
  return (
    <div className="v3-page" data-testid="activity-page">
      <h1 className="v3-h1">Журнал активности</h1>
      <div className="v3-row" style={{ margin: "10px 0 16px" }}>
        <input className="v3-input" placeholder="Поиск по активности..." value={q} onChange={e => setQ(e.target.value)} data-testid="activity-search"/>
        <select className="v3-input" value={type} onChange={e => setType(e.target.value)} style={{ maxWidth: 180 }} data-testid="activity-type">
          <option value="">Все типы</option>
          <option value="upload">Загрузка</option><option value="download">Скачивание</option>
          <option value="delete">Удаление</option><option value="rename">Переименование</option>
          <option value="share">Поделиться</option><option value="tag">Метка</option>
          <option value="login">Вход</option><option value="lock">Блокировка</option>
        </select>
        <button className="v3-btn" onClick={() => { v3store.clearActivity(); setItems([]) }} data-testid="activity-clear"><Trash2 size={14}/> Очистить</button>
      </div>
      <div className="v3-card">
        {filtered.length === 0 ? <div className="v3-sub">Нет подходящих событий.</div> :
          filtered.map(i => (
            <div key={i.id} className="v3-row" style={{ padding: "8px 0", borderBottom: "1px solid var(--v3-border-soft)" }}>
              <Activity size={14} />
              <span className="v3-chip">{i.type}</span>
              <div style={{ flex: 1 }}>{i.message}</div>
              <div className="v3-sub v3-num">{new Date(i.ts).toLocaleString()}</div>
            </div>
          ))
        }
      </div>
    </div>
  )
}
