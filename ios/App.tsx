import React, { useEffect, useState } from 'react'
import { StatusBar } from 'expo-status-bar'
import { NavigationContainer } from '@react-navigation/native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { TelegramService } from './src/services/telegram'
import { StorageService } from './src/services/storage'

const Tab = createBottomTabNavigator()
const Stack = createNativeStackNavigator()

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    checkSession()
  }, [])

  const checkSession = async () => {
    const hasSession = await StorageService.hasSession()
    if (hasSession) {
      const ok = await TelegramService.reconnect()
      setIsAuthenticated(ok)
    }
    setIsLoading(false)
  }

  if (isLoading) return <SplashScreen />
  if (!isAuthenticated) return <LoginScreen onLoginSuccess={() => setIsAuthenticated(true)} />

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <StatusBar style="light" />
        <Tab.Navigator screenOptions={{ headerShown: false, tabBarStyle: { backgroundColor: '#0a0a14' } }}>
          <Tab.Screen name="Home" component={DashboardScreen} />
          <Tab.Screen name="Files" component={FilesScreen} />
          <Tab.Screen name="Upload" component={UploadScreen} />
          <Tab.Screen name="Settings" component={SettingsScreen} />
        </Tab.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  )
}

// Placeholder screens — replace with full implementations
function SplashScreen() { return null }
function LoginScreen(props: { onLoginSuccess: () => void }) { return null }
function DashboardScreen() { return null }
function FilesScreen() { return null }
function UploadScreen() { return null }
function SettingsScreen() { return null }
