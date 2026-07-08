import React from 'react'

interface Props { children: React.ReactNode }
interface State { hasError: boolean; error: Error | null }

export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    try {
      if (window.electronAPI?.app?.log) {
        window.electronAPI.app.log('error', `ErrorBoundary: ${error.message}\nStack: ${error.stack}\nComponent: ${info.componentStack}`)
      }
    } catch(e) {}
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ position:'fixed',inset:0,display:'flex',alignItems:'center',justifyContent:'center',background:'#111',color:'#eee',fontFamily:'monospace',padding:40 }}>
          <div style={{ maxWidth:600 }}>
            <h2 style={{ color:'#f55',marginBottom:12 }}>Критическая ошибка</h2>
            <pre style={{ whiteSpace:'pre-wrap',fontSize:13,lineHeight:1.5,color:'#aaa' }}>{this.state.error?.message}</pre>
            <pre style={{ whiteSpace:'pre-wrap',fontSize:11,lineHeight:1.4,color:'#666',marginTop:12 }}>{this.state.error?.stack}</pre>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
