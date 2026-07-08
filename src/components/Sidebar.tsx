import React from "react"
import { NavLink } from "react-router-dom"
import { Home, FolderOpen, Upload, RefreshCw, BarChart3, Settings, Info,
  LogOut, Trash2, Star, Link2, Activity, Tag, Search, CalendarDays, Image as ImgIcon,
  StickyNote, Wifi, Command, HelpCircle, Stethoscope, Headphones } from "lucide-react"

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
  return (
    <aside className="v2-sidebar" data-testid="v3-sidebar">
      <div className="v2-sidebar-head" style={{ minHeight: 40 }}></div>
      <nav className="v2-sidebar-nav">
        {items.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end}
            className={({ isActive }) => "v2-sidebar-link" + (isActive ? " active" : "")}>
            <Icon size={18} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="v2-sidebar-foot">
        <div className="v2-sidebar-channel" title={channelInfo?.title}>
          <div className="v2-sidebar-channel-name">{channelInfo?.title || "Канал"}</div>
          <div className="v2-sidebar-channel-sub">Подключено</div>
        </div>
        <button className="v2-sidebar-logout" onClick={onLogout} data-testid="logout-btn">
          <LogOut size={16} /><span>Выйти</span>
        </button>
        <div className="v3-row" style={{ marginTop: 8, fontSize: 11, color: "var(--v3-text-mute)" }}>
          <Command size={12} /> + K — поиск
        </div>
      </div>
    </aside>
  )
}
