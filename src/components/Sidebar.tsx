import React from "react"
import { NavLink } from "react-router-dom"
import { Home, FolderOpen, Upload, RefreshCw, Settings,
  LogOut, Trash2, Star, Image as ImgIcon,
  Headphones, Cloud } from "lucide-react"

interface Props { channelInfo: any; userInfo?: { firstName: string; lastName?: string; username?: string; photoPath?: string; isVideo?: boolean } | null; onLogout: () => void }

const items = [
  { to: "/", label: "Главная", icon: Home, end: true },
  { to: "/files", label: "Мои файлы", icon: FolderOpen },
  { to: "/upload", label: "Загрузить", icon: Upload },
  { to: "/audioplayer", label: "Аудиоплеер", icon: Headphones },

  { to: "/albums", label: "Альбомы", icon: ImgIcon },
  { to: "/autosync", label: "Авто-синх.", icon: RefreshCw },

  { to: "/favorites", label: "Избранное", icon: Star },
  { to: "/settings", label: "Настройки", icon: Settings },
  { to: "/trash", label: "Корзина", icon: Trash2 },
]

export default function Sidebar({ channelInfo, userInfo, onLogout }: Props) {
  const avatarSrc = userInfo?.photoPath ? 'file://' + userInfo.photoPath : null
  return (
    <aside className="v2-sidebar" data-testid="v3-sidebar">
      <div className="v2-sidebar-profile">
        {avatarSrc ? (userInfo?.isVideo ? (
          <video className="v2-sidebar-avatar" src={avatarSrc} autoPlay loop muted playsInline />
        ) : (
          <img className="v2-sidebar-avatar" src={avatarSrc} alt="" />
        )) : (
          <div className="v2-sidebar-avatar v2-sidebar-avatar-fallback" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Cloud size={20} />
          </div>
        )}
        <div className="v2-sidebar-profile-info">
          <div className="v2-sidebar-profile-name">
            {userInfo?.firstName || channelInfo?.channelName || 'Аккаунт'}
          </div>
          <div className="v2-sidebar-profile-sub">
            {userInfo ? 'В сети' : 'Подключено'}
          </div>
        </div>
      </div>
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
        <div className="v2-sidebar-channel" title={channelInfo?.channelName}>
          <div className="v2-sidebar-channel-name">{channelInfo?.channelName || "Канал"}</div>
          <div className="v2-sidebar-channel-sub">Подключено</div>
        </div>
        <button className="v2-sidebar-logout" onClick={onLogout} data-testid="logout-btn">
          <LogOut size={16} /><span>Выйти</span>
        </button>
      </div>
    </aside>
  )
}
