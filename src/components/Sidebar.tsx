import React, { useState } from "react"
import { NavLink } from "react-router-dom"
import { Home, FolderOpen, Upload, RefreshCw, BarChart3, Settings, Info,
  LogOut, Trash2, Star, Link2, Activity, Tag, Search, CalendarDays, Image as ImgIcon,
  StickyNote, Wifi, ChevronsLeft, ChevronsRight, Command, HelpCircle, Stethoscope, Headphones } from "lucide-react"

interface Props { channelInfo: any; onLogout: () => void }

const items = [
  { to: "/", label: "Главная", icon: Home, end: true },
  { to: "/files", label: "Мои файлы", icon: FolderOpen },
  { to: "/upload", label: "Загрузить", icon: Upload },
  { to: "/autosync", label: "Авто-синх.", icon: RefreshCw },
  { to: "/statistics", label: "Статистика", icon: BarChart3 },
  { to: "/trash", label: "Корзина", icon: Trash2 },
  { to: "/favorites", label: "Избранное", icon: Star },
  { to: "/shared", label: "Общее", icon: Link2 },
  { to: "/activity", label: "Активность", icon: Activity },
  { to: "/tags", label: "Теги", icon: Tag },
  { to: "/search", label: "Поиск", icon: Search },
  { to: "/calendar", label: "Календарь", icon: CalendarDays },
  { to: "/albums", label: "Альбомы", icon: ImgIcon },
  { to: "/audioplayer", label: "Аудиоплеер", icon: Headphones },
  { to: "/notes", label: "Заметки", icon: StickyNote },
  { to: "/network", label: "Сеть", icon: Wifi },
  { to: "/diagnostics", label: "Диагностика", icon: Stethoscope },
  { to: "/help", label: "Горячие клавиши", icon: HelpCircle },
  { to: "/settings", label: "Настройки", icon: Settings },
  { to: "/about", label: "О программе", icon: Info }
]

export default function Sidebar({ channelInfo, onLogout }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <aside className={"v2-sidebar" + (collapsed ? " collapsed" : "")} style={collapsed ? { width: 72 } : undefined} data-testid="v3-sidebar">
      <div className="v2-sidebar-head">
        <div className="v2-sidebar-logo">CS</div>
        {!collapsed && (
          <div className="v2-sidebar-title">
            <div className="v2-sidebar-brand">RodjerCloud</div>
            <span className="v2-sidebar-badge">v1</span>
          </div>
        )}
        <button className="v3-btn ghost" style={{ marginLeft: "auto", padding: 6, borderColor: "transparent" }} onClick={() => setCollapsed(c => !c)} title="Toggle sidebar" data-testid="sidebar-collapse">
          {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
        </button>
      </div>
      <nav className="v2-sidebar-nav">
        {items.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end}
            className={({ isActive }) => "v2-sidebar-link" + (isActive ? " active" : "")}
            title={collapsed ? label : undefined}>
            <Icon size={18} />
            {!collapsed && <span>{label}</span>}
          </NavLink>
        ))}
      </nav>
      <div className="v2-sidebar-foot">
        {!collapsed && (
          <div className="v2-sidebar-channel" title={channelInfo?.title}>
            <div className="v2-sidebar-channel-name">{channelInfo?.title || "Канал"}</div>
            <div className="v2-sidebar-channel-sub">Подключено</div>
          </div>
        )}
        <button className="v2-sidebar-logout" onClick={onLogout} data-testid="logout-btn">
          <LogOut size={16} />{!collapsed && <span>Выйти</span>}
        </button>
        {!collapsed && (
          <div className="v3-row" style={{ marginTop: 8, fontSize: 11, color: "var(--v3-text-mute)" }}>
            <Command size={12} /> + K — поиск
          </div>
        )}
      </div>
    </aside>
  )
}
