import React, { useEffect, useState } from "react"
import { Star } from "lucide-react"
import { v3store } from "../lib/v3store"

export default function FavoritesPage() {
  const [items, setItems] = useState(v3store.getFavs())
  useEffect(() => { setItems(v3store.getFavs()) }, [])
  return (
    <div className="v3-page" data-testid="favorites-page">
      <h1 className="v3-h1">Избранное</h1>
      <div className="v3-sub">Файлы, отмеченные звёздочкой для быстрого доступа.</div>
      <div className="v3-card" style={{ marginTop: 18 }}>
        {items.length === 0 ? <div className="v3-sub">Пока ничего нет. Отметьте файл звёздочкой в «Мои файлы».</div> :
          <div className="v3-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
            {items.map(it => (
              <div key={it.messageId} className="v3-card" style={{ padding: 14 }}>
                <div className="v3-row"><Star size={16} fill="#fbbf24" stroke="#fbbf24"/><div style={{ flex: 1 }}>{it.fileName}</div></div>
                <div className="v3-sub v3-num">добавлено {new Date(it.addedAt).toLocaleDateString()}</div>
              </div>
            ))}
          </div>
        }
      </div>
    </div>
  )
}
