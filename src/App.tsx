import React, { useState, useEffect } from 'react'
import LoginScreen from './components/LoginScreen'
import KeyChoiceScreen from './components/KeyChoiceScreen'
import Dashboard from './components/Dashboard'
import './styles/glass.css'

declare global {
  interface Window {
    electronAPI: any
  }
}

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [needsKeyChoice, setNeedsKeyChoice] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [channelInfo, setChannelInfo] = useState<any>(null)

  useEffect(() => {
    checkSession()
  }, [])

  const checkSession = async () => {
    try {
      const result = await window.electronAPI.telegram.checkSession()
      if (result.success && result.hasSession) {
        const reconnectResult = await window.electronAPI.telegram.reconnect()
        if (reconnectResult.success) {
          setIsAuthenticated(true)
          setChannelInfo(reconnectResult.data)
        }
      }
    } catch (error) {
      console.error('Session check failed:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleLoginSuccess = (channelData: any) => {
    if (channelData && channelData.needsKeyChoice) {
      setNeedsKeyChoice(true)
      return
    }
    setIsAuthenticated(true)
    setChannelInfo(channelData)
  }

  const handleKeyChoiceComplete = (channelData: any) => {
    setNeedsKeyChoice(false)
    setIsAuthenticated(true)
    setChannelInfo(channelData)
  }

  const handleLogout = async () => {
    try {
      await window.electronAPI.telegram.logout()
      setIsAuthenticated(false)
      setNeedsKeyChoice(false)
      setChannelInfo(null)
    } catch (error) {
      console.error('Logout failed:', error)
    }
  }

  if (isLoading) {
    return (
      <div className="app-container">
        <div className="loading-screen">
          <div className="loading-spinner"></div>
          <p>Loading CloudSaver...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="app-container">
      {needsKeyChoice ? (
        <KeyChoiceScreen onComplete={handleKeyChoiceComplete} />
      ) : !isAuthenticated ? (
        <LoginScreen onLoginSuccess={handleLoginSuccess} />
      ) : (
        <Dashboard channelInfo={channelInfo} onLogout={handleLogout} />
      )}
    </div>
  )
}

export default App
