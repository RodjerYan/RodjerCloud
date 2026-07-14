import React, { useEffect, useState, useCallback, useRef } from "react"
import { MemoryRouter, Routes, Route, Navigate } from "react-router-dom"
import SplashScreen from "./components/SplashScreen"
import DuckSplash from "./components/DuckSplash"
import LoginScreen from "./components/LoginScreen"
import Sidebar from "./components/Sidebar"
import CommandPalette from "./components/CommandPalette"
import AggregateProgress from "./components/AggregateProgress"
import AudioPlayerBar from "./components/AudioPlayerBar"
import { AudioPlayerProvider } from "./lib/AudioPlayerContext"
import DashboardHome from "./pages/DashboardHome"
import MyFilesPage from "./pages/MyFilesPage"
import UploadPage from "./pages/UploadPage"
import AutoSyncPage from "./pages/AutoSyncPage"
import { UploadQueueProvider } from "./lib/UploadQueueContext"

import SettingsPage from "./pages/SettingsPage"
import TrashPage from "./pages/TrashPage"
import FavoritesPage from "./pages/FavoritesPage"
import SharedPage from "./pages/SharedPage"

import ActivityPage from "./pages/ActivityPage"
import TagsPage from "./pages/TagsPage"
import SearchPage from "./pages/SearchPage"
import CalendarPage from "./pages/CalendarPage"
import AlbumsPage from "./pages/AlbumsPage"
import AudioPlayerPage from "./pages/AudioPlayerPage"

import { v3store, loadStateFromTelegram } from "./lib/v3store"
import "./styles/tokens.css"
import "./styles/base.css"
import "./styles/components.css"
import "./styles/sidebar.css"
import "./styles/dashboard-home.css"
import "./styles/files.css"
import "./styles/upload.css"
import "./styles/statistics.css"
import "./styles/settings.css"
import "./styles/modal.css"
import ErrorBoundary from "./components/ErrorBoundary"

import GlobalDialogs from "./components/GlobalDialogs"

declare global { interface Window { electronAPI: any } }

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [showSplash, setShowSplash] = useState(true)
  const [showDuckSplash, setShowDuckSplash] = useState(false)
  const [channelInfo, setChannelInfo] = useState<any>(null)
  const [userInfo, setUserInfo] = useState<{ firstName: string; lastName?: string; username?: string; photoPath?: string } | null>(null)
  const [updateData, setUpdateData] = useState<{ version: string; assetId: number; assetName: string; latestVersion: string } | null>(null)
  const [dlProgress, setDlProgress] = useState(0)
  const [dlPath, setDlPath] = useState('')
  const [dlStatus, setDlStatus] = useState<'idle' | 'downloading' | 'done'>('idle')
  const unsubDlRef = useRef<(() => void) | null>(null)

  const fetchUserInfo = useCallback(async () => {
    try {
      const r = await window.electronAPI.telegram.getUserInfo()
      if (r.success && r.data) setUserInfo(r.data)
    } catch {}
  }, [])

  const handleDuckDone = useCallback(() => setShowDuckSplash(false), [])

  useEffect(() => {
    const t = setTimeout(() => setShowSplash(false), 1400)
    checkSession()
    const p = v3store.getPrefs()
    document.documentElement.dataset.theme = p.theme
    document.documentElement.dataset.density = p.density
    document.documentElement.dataset.animations = p.animations
    document.documentElement.style.setProperty("--v3-sans-active", p.font || "var(--v3-sans)")
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    const unsub = window.electronAPI.app?.onUpdateAvailable?.((data: { version: string; assetId: number; assetName: string }) => {
      setUpdateData({ version: data.version, assetId: data.assetId, assetName: data.assetName, latestVersion: data.version })
    })
    return () => unsub?.()
  }, [])

  const startDownload = async () => {
    if (!updateData?.assetId || dlStatus === 'downloading') return
    setDlStatus('downloading')
    setDlProgress(0)
    const unsub = window.electronAPI.app.onDownloadProgress((p: { percent: number }) => {
      setDlProgress(p.percent)
    })
    unsubDlRef.current = unsub
    const r = await window.electronAPI.app.downloadUpdate(updateData.assetId, updateData.assetName, updateData.latestVersion)
    unsubDlRef.current = null
    if (r.success && r.data) {
      setDlPath(r.data.filePath)
      setDlProgress(100)
      setDlStatus('done')
      await window.electronAPI.app.installUpdate(r.data.filePath)
    } else {
      setDlStatus('idle')
      setDlProgress(0)
    }
  }

  useEffect(() => {
    return () => { unsubDlRef.current?.() }
  }, [])

  const checkSession = async () => {
    try {
      const result = await window.electronAPI.telegram.checkSession()
      if (result.success && result.hasSession) {
        const reconnectResult = await window.electronAPI.telegram.reconnect()
        if (reconnectResult.success) {
          setIsAuthenticated(true); setChannelInfo(reconnectResult.data)
          fetchUserInfo()
          setShowDuckSplash(true)
          v3store.logActivity("login", "Reconnected to Telegram channel")
          loadStateFromTelegram()
        }
      }
    } catch (e) { console.error("Session check failed:", e) }
    finally { setIsLoading(false) }
  }

  const handleLoginSuccess = (channelData: any) => {
    setIsAuthenticated(true); setChannelInfo(channelData)
    fetchUserInfo()
    setShowDuckSplash(true)
    v3store.logActivity("login", "Login successful")
    loadStateFromTelegram()
  }
  const handleLogout = async () => {
    try {
      await window.electronAPI.telegram.logout()
      setIsAuthenticated(false); setChannelInfo(null)
      v3store.logActivity("login", "Logged out")
    } catch (e) { console.error("Logout failed:", e) }
  }

  if (showSplash || isLoading) return <ErrorBoundary><SplashScreen /></ErrorBoundary>
  if (showDuckSplash) return <ErrorBoundary><DuckSplash onDone={handleDuckDone} /></ErrorBoundary>
  if (!isAuthenticated) {
    return <ErrorBoundary><div className="app-container"><LoginScreen onLoginSuccess={handleLoginSuccess} /></div></ErrorBoundary>
  }

  return (
    <ErrorBoundary>
    <MemoryRouter initialEntries={["/"]}>
      <div className="v2-shell">
        <Sidebar channelInfo={channelInfo} userInfo={userInfo} onLogout={handleLogout} />
        <AudioPlayerProvider>
          <UploadQueueProvider>
            <main className="v2-main" style={{ position: "relative", overflow: "auto" }}>
              {updateData && dlStatus !== 'done' && (
                <div className={`update-banner ${dlStatus === 'idle' ? 'clickable' : ''}`} onClick={() => { if (dlStatus === 'idle') startDownload() }}>
                  <div className="update-banner-header">
                    <span>Обновление v{updateData.version}</span>
                    {dlStatus === 'idle' && <span className="update-banner-action">Скачать</span>}
                    {dlStatus === 'downloading' && <span className="update-banner-progress-text">Загрузка... {dlProgress}%</span>}
                    <span className="update-banner-close"
                      onClick={e => { e.stopPropagation(); setUpdateData(null) }}>×</span>
                  </div>
                  {dlStatus === 'downloading' && (
                    <div className="update-banner-bar-wrap">
                      <div className="update-banner-bar" style={{ width: dlProgress + '%' }} />
                    </div>
                  )}
                </div>
              )}
              <AggregateProgress />
              <Routes>
                <Route path="/" element={<DashboardHome channelInfo={channelInfo} userInfo={userInfo} />} />
                <Route path="/files" element={<MyFilesPage />} />
                <Route path="/upload" element={<UploadPage />} />
                <Route path="/autosync" element={<AutoSyncPage />} />

                <Route path="/trash" element={<TrashPage />} />
                <Route path="/favorites" element={<FavoritesPage />} />
                <Route path="/shared" element={<SharedPage />} />
                <Route path="/activity" element={<ActivityPage />} />
                <Route path="/tags" element={<TagsPage />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/calendar" element={<CalendarPage />} />
                <Route path="/albums" element={<AlbumsPage />} />
                <Route path="/audioplayer" element={<AudioPlayerPage />} />
                <Route path="/settings" element={<SettingsPage channelInfo={channelInfo} onChangeChannel={handleLogout} />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </main>
            <AudioPlayerBar />
          </UploadQueueProvider>
        </AudioPlayerProvider>
        <CommandPalette />
        <GlobalDialogs />
      </div>
    </MemoryRouter>
    </ErrorBoundary>
  )
}

export default App
