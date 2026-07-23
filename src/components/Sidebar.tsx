import React from "react"
import { NavLink } from "react-router-dom"
import { Home, FolderOpen, Upload, RefreshCw, Settings,
  LogOut, Trash2, Star, Image as ImgIcon,
  Headphones, Cloud, ArrowRight } from "lucide-react"
import '../styles/logout-btn.css'

interface Props { channelInfo: any; userInfo?: { firstName: string; lastName?: string; username?: string; photoPath?: string; isVideo?: boolean } | null; onLogout: () => void; updateAvailable?: boolean }

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

export default function Sidebar({ channelInfo, userInfo, onLogout, updateAvailable }: Props) {
  const avatarSrc = userInfo?.photoPath ? 'file://' + userInfo.photoPath : null
  return (
    <aside className="v2-sidebar" data-testid="v3-sidebar">
      <div className="v2-sidebar-profile">
        {avatarSrc ? (userInfo?.isVideo ? (
          <video className="v2-sidebar-avatar" src={avatarSrc} autoPlay={!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches} loop muted playsInline />
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
            <div className="v2-sidebar-link-wrap">
              <Icon size={18} />
              {to === "/settings" && updateAvailable && <span className="update-badge" />}
            </div>
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
          <div className="v2-sidebar-logout-bg" />
          <span className="v2-sidebar-logout-text">Выйти</span>
          <div className="v2-sidebar-logout-icon-wrap">
            <span>Выйти</span>
            <ArrowRight size={16} />
          </div>
        </button>
      </div>
    </aside>
  )
}
