import React, { useEffect, useState } from "react"
import { Trash2, RotateCcw, X } from "lucide-react"
import { v3store, fmtBytes } from "../lib/v3store"

export default function TrashPage() {
  const [items, setItems] = useState(v3store.getTrash())
  useEffect(() => { v3store.clearOldTrash(); setItems(v3store.getTrash()) }, [])
  const restore = (id: number) => { v3store.removeTrash(id); setItems(v3store.getTrash()); v3store.logActivity("delete", "Восстановлен элемент " + id) }
  const purge = (id: number) => { v3store.removeTrash(id); setItems(v3store.getTrash()); v3store.logActivity("delete", "Навсегда удалён " + id) }
  return (
    <div className="v3-page" data-testid="trash-page">
      <h1 className="v3-h1">Корзина</h1>
      <div className="v3-sub">Элементы хранятся 30 дней, затем удаляются навсегда.</div>
      <div className="v3-card" style={{ marginTop: 18 }}>
        {items.length === 0 ? <div className="v3-sub">Корзина пуста.</div> :
          items.map(it => (
            <div key={it.messageId} className="v3-row" style={{ padding: "10px 0", borderBottom: "1px solid var(--v3-border-soft)" }}>
              <Trash2 size={16} />
              <div style={{ flex: 1 }}>
                <div>{it.fileName}</div>
                <div className="v3-sub v3-num">{fmtBytes(it.size)} · удалён {new Date(it.deletedAt).toLocaleString()}</div>
              </div>
              <button className="v3-btn" onClick={() => restore(it.messageId)} data-testid="trash-restore"><RotateCcw size={14}/> Восстановить</button>
              <button className="v3-btn" onClick={() => purge(it.messageId)} data-testid="trash-purge"><X size={14}/> Удалить</button>
            </div>
          ))
        }
      </div>
    </div>
  )
}
