import React, { useState, useRef, useEffect } from 'react'
import iconUrl from '../assets/icon.png'
import '../styles/login.css'

interface LoginScreenProps {
  onLoginSuccess: (channelData: any) => void
}

type Step = 'phone' | 'code' | '2fa'

const LoginScreen: React.FC<LoginScreenProps> = ({ onLoginSuccess }) => {
  const [step, setStep] = useState<Step>('phone')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [phoneDigits, setPhoneDigits] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [step])

  const getFullPhone = () => {
    const d = phoneDigits.replace(/\D/g, '')
    if (!d) return ''
    return '+' + d
  }

  const handleSubmitPhone = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    const fullPhone = getFullPhone()
    if (phoneDigits.replace(/\D/g, '').length < 5) {
      setError('Введите номер телефона')
      setLoading(false)
      return
    }
    try {
      const result = await window.electronAPI.telegram.login(fullPhone)
      if (result.success) {
        setStep('code')
        setTimeout(() => inputRef.current?.focus(), 100)
      } else {
        setError(result.error || 'Не удалось отправить код')
      }
    } catch (err: any) {
      setError(err.message || 'Произошла ошибка')
    } finally {
      setLoading(false)
    }
  }

  const handleSubmitCode = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await window.electronAPI.telegram.verifyCode(code)
      if (result.success) {
        onLoginSuccess(result.data)
      } else if (result.needs2FA) {
        setStep('2fa')
        setTimeout(() => inputRef.current?.focus(), 100)
      } else {
        setError(result.error || 'Неверный код')
      }
    } catch (err: any) {
      setError(err.message || 'Произошла ошибка')
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit2FA = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await window.electronAPI.telegram.verify2FA(password)
      if (result.success) {
        onLoginSuccess(result.data)
      } else {
        setError(result.error || 'Неверный пароль 2FA')
      }
    } catch (err: any) {
      setError(err.message || 'Произошла ошибка')
    } finally {
      setLoading(false)
    }
  }

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/[^\d+]/g, '')
    const digits = raw.replace(/\D/g, '')
    const hasPlus = raw.startsWith('+') || phoneDigits.startsWith('+')
    const prefix = hasPlus ? '+' : ''
    if (digits.length <= 15) {
      setPhoneDigits(prefix + digits)
    }
  }

  const formatDisplay = () => {
    const d = phoneDigits.replace(/\D/g, '')
    if (!d) return ''
    if (d.length <= 1) return d
    if (d.length <= 4) return `${d[0]} (${d.slice(1)}`
    if (d.length <= 7) return `${d[0]} (${d.slice(1, 4)}) ${d.slice(4)}`
    if (d.length <= 9) return `${d[0]} (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`
    return `${d[0]} (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9, 11)}`
  }

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value.replace(/\D/g, '').slice(0, 5)
    setCode(v)
  }

  return (
    <div className="login-container fade-in">
      <div className="login-bg-shapes">
        <div className="login-shape login-shape-1" />
        <div className="login-shape login-shape-2" />
        <div className="login-shape login-shape-3" />
      </div>

      <div className="login-card">
        <div className="login-header">
          <div className="login-logo-wrap">
            <img src={iconUrl} alt="RodjerCloud" className="login-logo" />
            <div className="login-logo-glow" />
          </div>
          <h1 className="login-title">
            Rodjer<span className="login-title-accent">Cloud</span>
          </h1>
          <p className="login-subtitle">Облачное хранилище в Telegram</p>
        </div>

        {error && (
          <div className="login-error">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        {step === 'phone' && (
          <form onSubmit={handleSubmitPhone} className="login-form">
            <div className="login-field">
              <label className="login-label">Номер телефона</label>
              <div className="login-phone-wrap">
                <span className="login-phone-prefix">{getFullPhone().replace(/\d/g, '').replace(/[+\s]/g, '') || '+'}</span>
                <input
                  ref={inputRef}
                  type="tel"
                  className="login-phone-input"
                  placeholder="7 (999) 123-45-67"
                  value={formatDisplay()}
                  onChange={handlePhoneChange}
                  data-testid="login-phone-input"
                  autoFocus
                />
              </div>
              <p className="login-hint">Введите номер телефона для входа в Telegram</p>
            </div>
            <button
              type="submit"
              className="login-btn"
              disabled={loading || phoneDigits.replace(/\D/g, '').length < 5}
            >
              {loading ? (
                <span className="login-btn-loading">
                  <span className="login-spinner" />
                  Отправка...
                </span>
              ) : (
                'Получить код'
              )}
            </button>
          </form>
        )}

        {step === 'code' && (
          <form onSubmit={handleSubmitCode} className="login-form">
            <button type="button" className="login-back" onClick={() => setStep('phone')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              Назад
            </button>
            <div className="login-field">
              <label className="login-label">Код подтверждения</label>
              <div className="login-code-wrap">
                <input
                  ref={inputRef}
                  type="text"
                  className="login-code-input"
                  placeholder="00000"
                  value={code}
                  onChange={handleCodeChange}
                  maxLength={5}
                  data-testid="login-code-input"
                  autoFocus
                  inputMode="numeric"
                />
                <div className="login-code-dashes">
                  {[0, 1, 2, 3, 4].map(i => (
                    <span key={i} className={`login-code-dash ${code.length > i ? 'filled' : ''}`} />
                  ))}
                </div>
              </div>
              <p className="login-hint">Код пришёл в Telegram</p>
            </div>
            <button
              type="submit"
              className="login-btn"
              disabled={loading || code.length < 4}
            >
              {loading ? (
                <span className="login-btn-loading">
                  <span className="login-spinner" />
                  Проверка...
                </span>
              ) : (
                'Подтвердить'
              )}
            </button>
          </form>
        )}

        {step === '2fa' && (
          <form onSubmit={handleSubmit2FA} className="login-form">
            <div className="login-field">
              <label className="login-label">Двухфакторная аутентификация</label>
              <div className="login-password-wrap">
                <input
                  ref={inputRef}
                  type="password"
                  className="login-input"
                  placeholder="Введите пароль 2FA"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid="login-2fa-input"
                  autoFocus
                />
              </div>
              <p className="login-hint">Облачный пароль Telegram</p>
            </div>
            <button
              type="submit"
              className="login-btn"
              disabled={loading || !password}
            >
              {loading ? (
                <span className="login-btn-loading">
                  <span className="login-spinner" />
                  Вход...
                </span>
              ) : (
                'Войти'
              )}
            </button>
          </form>
        )}

        <div className="login-footer">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.4">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span>Все данные зашифрованы</span>
        </div>
      </div>
    </div>
  )
}

export default LoginScreen
