import React, { useEffect, useState, useRef, useCallback, useLayoutEffect } from 'react'
import { subscribeDialogs } from '../lib/dialogs'

export default function GlobalDialogs() {
  const [dialogs, setDialogs] = useState<any[]>([])
  const [holdProgress, setHoldProgress] = useState(0)
  const holdIntervalRef = useRef<any>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const prevFocusRef = useRef<HTMLElement | null>(null)
  const isHoldingRef = useRef(false)

  useEffect(() => {
    const unsub = subscribeDialogs((ds) => {
      setDialogs(ds)
      setHoldProgress(0)
      isHoldingRef.current = false
      if (holdIntervalRef.current) {
        clearInterval(holdIntervalRef.current)
        holdIntervalRef.current = null
      }
    })
    return () => {
      unsub()
      if (holdIntervalRef.current) clearInterval(holdIntervalRef.current)
    }
  }, [])

  const top = dialogs.length ? dialogs[dialogs.length - 1] : null
  const topId: number | null = top?.id ?? null

  useLayoutEffect(() => {
    if (topId == null) return
    prevFocusRef.current = document.activeElement as HTMLElement | null
    const raf = requestAnimationFrame(() => {
      cancelRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [topId])

  useEffect(() => {
    if (topId != null) return
    const el = prevFocusRef.current
    prevFocusRef.current = null
    if (el && typeof el.focus === 'function' && document.contains(el)) el.focus()
  }, [topId])

  useEffect(() => {
    if (!top) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        top.resolve(false)
        return
      }
      if (e.key === 'Tab') {
        const root = cardRef.current
        if (!root) return
        const list = Array.from(
          root.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')
        )
        if (list.length === 0) {
          e.preventDefault()
          return
        }
        const first = list[0]
        const last = list[list.length - 1]
        const active = document.activeElement
        if (e.shiftKey) {
          if (active === first || !root.contains(active)) {
            e.preventDefault()
            last.focus()
          }
        } else if (active === last || !root.contains(active)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [top])

  const stopHold = useCallback(() => {
    isHoldingRef.current = false
    if (holdIntervalRef.current) {
      clearInterval(holdIntervalRef.current)
      holdIntervalRef.current = null
    }
    setHoldProgress(0)
  }, [])

  const startHold = useCallback(
    (resolve: (v: boolean) => void) => {
      if (holdIntervalRef.current) return
      isHoldingRef.current = true
      setHoldProgress(0)
      let p = 0
      holdIntervalRef.current = setInterval(() => {
        p += 5
        setHoldProgress(p)
        if (p >= 100) {
          clearInterval(holdIntervalRef.current)
          holdIntervalRef.current = null
          isHoldingRef.current = false
          setHoldProgress(0)
          resolve(true)
        }
      }, 50)
    },
    []
  )

  useEffect(() => stopHold, [stopHold, topId])

  if (!top) return null

  const d = top
  const isDanger =
    d.type === 'confirm' &&
    (d.message.toLowerCase().includes('удал') || d.message.toLowerCase().includes('корзин'))

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 999999,
        background: 'rgba(10, 10, 15, 0.75)',
        backdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'fadeIn 0.2s ease',
      }}
    >
      <div
        ref={cardRef}
        className="v3-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gd-title"
        aria-describedby="gd-msg"
        tabIndex={-1}
        style={{
          width: 400,
          maxWidth: '90%',
          padding: '24px',
          background: isDanger ? 'rgba(30, 20, 24, 0.85)' : 'rgba(22, 24, 42, 0.85)',
          border: isDanger ? '1px solid rgba(239, 68, 68, 0.2)' : '1px solid rgba(255,255,255,0.08)',
          boxShadow: isDanger
            ? '0 20px 50px rgba(239, 68, 68, 0.15), inset 0 1px 0 rgba(255,255,255,0.06)'
            : '0 20px 40px rgba(0,0,0,0.4)',
          backdropFilter: 'blur(30px)',
          animation: 'zoomIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
          position: 'relative',
          overflow: 'hidden',
          outline: 'none',
        }}
      >
        {isDanger && (
          <div
            style={{
              position: 'absolute',
              top: -50,
              right: -50,
              width: 100,
              height: 100,
              background: 'rgba(239, 68, 68, 0.3)',
              filter: 'blur(40px)',
              borderRadius: '50%',
              pointerEvents: 'none',
            }}
          />
        )}

        <div
          id="gd-title"
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: isDanger ? '#fca5a5' : '#fff',
            marginBottom: 10,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {d.type === 'confirm' ? (isDanger ? '⚠️ Опасное действие' : 'Подтверждение') : 'Внимание'}
        </div>

        <div
          id="gd-msg"
          style={{
            fontSize: 14,
            color: 'var(--v3-text-dim)',
            marginBottom: 28,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {d.message}
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
          {d.type === 'confirm' && (
            <button
              ref={cancelRef}
              type="button"
              onClick={() => d.resolve(false)}
              style={{
                padding: '8px 24px',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.04)',
                color: 'var(--v3-text)',
                fontWeight: 500,
                cursor: 'pointer',
                fontSize: 13,
                lineHeight: '20px',
                width: 140,
              }}
            >
              Отмена
            </button>
          )}

          {isDanger ? (
            <button
              ref={d.type === 'confirm' ? undefined : cancelRef}
              type="button"
              aria-label="Удерживайте для подтверждения удаления"
              onPointerDown={(e) => {
                e.preventDefault()
                startHold(d.resolve)
              }}
              onPointerUp={stopHold}
              onPointerLeave={stopHold}
              onPointerCancel={stopHold}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault()
                  startHold(d.resolve)
                }
              }}
              onKeyUp={(e) => {
                if (e.key === ' ' || e.key === 'Enter') stopHold()
              }}
              onBlur={stopHold}
              style={{
                padding: '8px 24px',
                borderRadius: 8,
                border: '1px solid rgba(239, 68, 68, 0.35)',
                background: 'rgba(239, 68, 68, 0.1)',
                color: '#f87171',
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: 13,
                lineHeight: '20px',
                width: 140,
                position: 'relative',
                overflow: 'hidden',
                transition: 'transform 0.1s',
                transform: holdProgress > 0 ? 'scale(0.96)' : 'scale(1)',
                userSelect: 'none',
                touchAction: 'none',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  bottom: 0,
                  width: `${holdProgress}%`,
                  background: 'rgba(239, 68, 68, 0.4)',
                  transition: 'width 0.05s linear',
                }}
              />
              <span style={{ position: 'relative', zIndex: 1 }}>
                {holdProgress > 0 ? 'Удерживайте...' : 'Удалить'}
              </span>
            </button>
          ) : (
            <button
              ref={d.type === 'confirm' ? undefined : cancelRef}
              type="button"
              onClick={() => d.resolve(true)}
              style={{
                padding: '8px 24px',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.04)',
                color: 'var(--v3-text)',
                fontWeight: 500,
                cursor: 'pointer',
                fontSize: 13,
                lineHeight: '20px',
                width: 140,
              }}
            >
              ОК
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
