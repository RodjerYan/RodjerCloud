// Типы навигации — соответствуют роутам в src/App.tsx

export type RootTabParamList = {
  Home: undefined
  Files: undefined
  Upload: undefined
  Settings: undefined
}

export type HomeStackParamList = {
  Dashboard: undefined
  Statistics: undefined
  Activity: undefined
  Diagnostics: undefined
  Network: undefined
  Help: undefined
  About: undefined
}

export type FilesStackParamList = {
  MyFiles: undefined
  Favorites: undefined
  Shared: undefined
  Tags: undefined
  Search: undefined
  Calendar: undefined
  Albums: undefined
  Notes: undefined
  Trash: undefined
  AutoSync: undefined
}
