import React, { useEffect, useState, useCallback } from "react"
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
import StatisticsPage from "./pages/StatisticsPage"
import SettingsPage from "./pages/SettingsPage"
import AboutPage from "./pages/AboutPage"
import TrashPage from "./pages/TrashPage"
import FavoritesPage from "./pages/FavoritesPage"
import SharedPage from "./pages/SharedPage"
import ActivityPage from "./pages/ActivityPage"
import TagsPage from "./pages/TagsPage"
import SearchPage from "./pages/SearchPage"
import CalendarPage from "./pages/CalendarPage"
import AlbumsPage from "./pages/AlbumsPage"
import AudioPlayerPage from "./pages/AudioPlayerPage"
import NotesPage from "./pages/NotesPage"
import NetworkPage from "./pages/NetworkPage"
import DiagnosticsPage from "./pages/DiagnosticsPage"
import HelpPage from "./pages/HelpPage"
import { v3store } from "./lib/v3store"
import "./styles/glass.css"
import "./styles/sidebar.css"
import "./styles/dashboard-home.css"
import "./styles/files.css"
import "./styles/upload.css"
import "./styles/statistics.css"
import "./styles/settings.css"
import "./styles/about.css"
import "./styles/modal.css"
import "./styles/v3-theme.css"
import ErrorBoundary from "./components/ErrorBoundary"

declare global { interface Window { electronAPI: any } }

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [showSplash, setShowSplash] = useState(true)
  const [showDuckSplash, setShowDuckSplash] = useState(false)
  const [channelInfo, setChannelInfo] = useState<any>(null)

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

  const checkSession = async () => {
    try {
      const result = await window.electronAPI.telegram.checkSession()
      if (result.success && result.hasSession) {
        const reconnectResult = await window.electronAPI.telegram.reconnect()
        if (reconnectResult.success) {
          setIsAuthenticated(true); setChannelInfo(reconnectResult.data)
          setShowDuckSplash(true)
          v3store.logActivity("login", "Reconnected to Telegram channel")
        }
      }
    } catch (e) { console.error("Session check failed:", e) }
    finally { setIsLoading(false) }
  }

  const handleLoginSuccess = (channelData: any) => {
    setIsAuthenticated(true); setChannelInfo(channelData)
    setShowDuckSplash(true)
    v3store.logActivity("login", "Login successful")
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
        <Sidebar channelInfo={channelInfo} onLogout={handleLogout} />
        <AudioPlayerProvider>
        <main className="v2-main" style={{ position: "relative", overflow: "auto" }}>
          <AggregateProgress />
          <Routes>
            <Route path="/" element={<DashboardHome channelInfo={channelInfo} />} />
            <Route path="/files" element={<MyFilesPage />} />
            <Route path="/upload" element={<UploadPage />} />
            <Route path="/autosync" element={<AutoSyncPage />} />
            <Route path="/statistics" element={<StatisticsPage />} />
            <Route path="/trash" element={<TrashPage />} />
            <Route path="/favorites" element={<FavoritesPage />} />
            <Route path="/shared" element={<SharedPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/tags" element={<TagsPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/albums" element={<AlbumsPage />} />
            <Route path="/audioplayer" element={<AudioPlayerPage />} />
            <Route path="/notes" element={<NotesPage />} />
            <Route path="/network" element={<NetworkPage />} />
            <Route path="/diagnostics" element={<DiagnosticsPage />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="/settings" element={<SettingsPage channelInfo={channelInfo} onChangeChannel={handleLogout} />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <AudioPlayerBar />
        </AudioPlayerProvider>
        <CommandPalette />
      </div>
    </MemoryRouter>
    </ErrorBoundary>
  )
}

export default App
