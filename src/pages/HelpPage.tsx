import React from "react"
import { Keyboard } from "lucide-react"

const SC = [
  ["Ctrl+K", "Поиск"],
  ["Ctrl+Shift+P", "Палитра команд"],
  ["Ctrl+A", "Выделить всё (в списках)"],
  ["Esc", "Снять выделение / закрыть окно"],
  ["Shift+Клик", "Выделение диапазона"],
  ["Ctrl+V", "Вставить и загрузить"],
  ["Ctrl+Клик", "Переключить выделение"],
  ["Ctrl+,", "Настройки"],
  ["Ctrl+1..9", "Переключить вкладку"],
]

export default function HelpPage() {
  return (
    <div className="v3-page" data-testid="help-page">
      <h1 className="v3-h1">Горячие клавиши</h1>
      <div className="v3-sub">Управляйте RodjerCloud с клавиатуры.</div>
      <div className="v3-card" style={{ marginTop: 18 }}>
        {SC.map(([k, d]) => (
          <div key={k} className="v3-row" style={{ padding: "10px 0", borderBottom: "1px solid var(--v3-border-soft)" }}>
            <Keyboard size={14}/>
            <kbd className="v3-chip v3-num" style={{ minWidth: 120 }}>{k}</kbd>
            <div>{d}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
