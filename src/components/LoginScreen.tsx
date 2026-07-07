import React, { useState } from 'react'
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

  const [phoneNumber, setPhoneNumber] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')

  const handleSubmitPhone = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await window.electronAPI.telegram.login(phoneNumber)
      if (result.success) {
        setStep('code')
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

  return (
    <div className="login-container fade-in">
      <div className="login-box glass-card">
        <div className="login-header">
          <div className="logo-container">
            <img src={iconUrl} alt="RodjerCloud" className="logo-img" />
          </div>
          <h1 className="login-title">
            Rodjer<span className="text-gradient">Cloud</span>
          </h1>
          <p className="login-subtitle">My area — облачное хранилище в Telegram</p>
        </div>

        {error && (
          <div className="error-box" data-testid="login-error-message">
            <span className="error-icon">!</span>
            <span>{error}</span>
          </div>
        )}

        {step === 'phone' && (
          <form onSubmit={handleSubmitPhone} className="login-form">
            <div className="form-group">
              <label htmlFor="phoneNumber" className="form-label">Номер телефона</label>
              <input
                id="phoneNumber"
                type="tel"
                className="glass-input"
                placeholder="+79001234567"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                data-testid="login-phone-input"
                autoFocus
              />
              <p className="form-hint">Введите номер с кодом страны</p>
            </div>
            <button
              type="submit"
              className="glass-button glass-button-primary submit-button"
              disabled={loading}
              data-testid="login-phone-submit-button"
            >
              {loading ? 'Отправка...' : 'Отправить код'}
            </button>
          </form>
        )}

        {step === 'code' && (
          <form onSubmit={handleSubmitCode} className="login-form">
            <button
              type="button"
              className="back-button"
              onClick={() => setStep('phone')}
            >
              ← Назад
            </button>
            <div className="form-group">
              <label htmlFor="code" className="form-label">Код подтверждения</label>
              <input
                id="code"
                type="text"
                className="glass-input code-input"
                placeholder="12345"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={6}
                data-testid="login-code-input"
                autoFocus
              />
              <p className="form-hint">Проверьте Telegram — код придёт в приложение</p>
            </div>
            <button
              type="submit"
              className="glass-button glass-button-primary submit-button"
              disabled={loading}
              data-testid="login-code-submit-button"
            >
              {loading ? 'Проверка...' : 'Подтвердить'}
            </button>
          </form>
        )}

        {step === '2fa' && (
          <form onSubmit={handleSubmit2FA} className="login-form">
            <div className="form-group">
              <label htmlFor="password" className="form-label">Двухфакторная аутентификация</label>
              <input
                id="password"
                type="password"
                className="glass-input"
                placeholder="Введите пароль 2FA"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="login-2fa-input"
                autoFocus
              />
              <p className="form-hint">Ваш облачный пароль Telegram</p>
            </div>
            <button
              type="submit"
              className="glass-button glass-button-primary submit-button"
              disabled={loading}
              data-testid="login-2fa-submit-button"
            >
              {loading ? 'Проверка...' : 'Войти'}
            </button>
          </form>
        )}

        <div className="login-footer">
          <p>Все данные зашифрованы и хранятся локально</p>
        </div>
      </div>
    </div>
  )
}

export default LoginScreen
