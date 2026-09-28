import React, { useState, useEffect, useRef } from 'react'
import { Play } from 'lucide-react'
import { loadThumb, invalidateThumb } from '../lib/thumbLoader'
import { resolutionLabel } from '../lib/utils'

let globalObserver: IntersectionObserver | null = null;
const observerCallbacks = new Map<Element, () => void>();

function observe(el: Element, cb: () => void) {
  if (!globalObserver) {
    globalObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const callback = observerCallbacks.get(entry.target);
          if (callback) {
            callback();
            globalObserver?.unobserve(entry.target);
            observerCallbacks.delete(entry.target);
          }
        }
      });
    }, { rootMargin: '400px' });
  }
  observerCallbacks.set(el, cb);
  globalObserver.observe(el);
}

function unobserve(el: Element) {
  if (globalObserver) globalObserver.unobserve(el);
  observerCallbacks.delete(el);
}

const thumbUrlCache = new Map<number, string>()
const thumbPendingCallbacks = new Map<number, Set<(url: string) => void>>()
// Track retry attempts per messageId to allow only one retry
const thumbRetryCount = new Map<number, number>()
let globalThumbListenerAttached = false

function ensureGlobalThumbListener() {
  if (globalThumbListenerAttached) return
  globalThumbListenerAttached = true
  window.electronAPI.telegram.onThumbnailReady?.((data: { messageId: number; path: string }) => {
    const cached = thumbUrlCache.get(data.messageId)
    if (cached) return
    window.electronAPI.file.getLocalUrl(data.path).then((d: any) => {
      if (d.success && d.data) {
        thumbUrlCache.set(data.messageId, d.data)
        const cbs = thumbPendingCallbacks.get(data.messageId)
        if (cbs) {
          cbs.forEach(cb => cb(d.data))
          thumbPendingCallbacks.delete(data.messageId)
        }
      }
    })
  })
}

interface FileThumbProps {
  messageId: number
  fileName: string
  isVideo: boolean
  typeLabel: string
  width?: number
  height?: number
}

export const FileThumb: React.FC<FileThumbProps> = React.memo(({ messageId, fileName, isVideo, typeLabel, width, height }) => {
  const [url, setUrl] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)
  const [isVisible, setIsVisible] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // retry if a new URL arrives after a failed load (e.g. later thumbnail-ready event)
  useEffect(() => { setBroken(false) }, [url])

  useEffect(() => {
    const el = containerRef.current
    if (el) {
      observe(el, () => {
        console.log(`[thumb] visible id=${messageId}`)
        setIsVisible(true)
      })
    }
    return () => {
      if (el) unobserve(el)
    }
  }, [])

  // Safety: if IntersectionObserver never fires (edge cases), force load after 800ms
  useEffect(() => {
    const t = setTimeout(() => {
      setIsVisible(v => {
        if (!v) console.log(`[thumb] isVisible fallback force id=${messageId}`)
        return v || true
      })
    }, 800)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!isVisible) return
    const cached = thumbUrlCache.get(messageId)
    if (cached) {
      setUrl(cached)
      return
    }
    let active = true
    loadThumb(messageId, fileName, (res) => {
      console.log(`[thumb] loadThumb id=${messageId} → ${res ? res.slice(0, 80) : 'null'}`)
      if (active && res) {
        thumbUrlCache.set(messageId, res)
        setUrl(res)
      }
    })
    return () => { active = false }
  }, [messageId, fileName, isVisible])

  useEffect(() => {
    ensureGlobalThumbListener()
    if (thumbUrlCache.has(messageId)) {
      setUrl(thumbUrlCache.get(messageId)!)
      return
    }
    if (!thumbPendingCallbacks.has(messageId)) {
      thumbPendingCallbacks.set(messageId, new Set())
    }
    const cb = (resolvedUrl: string) => setUrl(resolvedUrl)
    thumbPendingCallbacks.get(messageId)!.add(cb)
    return () => {
      const set = thumbPendingCallbacks.get(messageId)
      if (set) {
        set.delete(cb)
        if (set.size === 0) thumbPendingCallbacks.delete(messageId)
      }
    }
  }, [messageId])

  const handleImageError = () => {
    const retries = thumbRetryCount.get(messageId) || 0
    if (retries === 0) {
      // First error: invalidate cache and retry once
      console.log(`[thumb] img onError id=${messageId} src=${url?.slice(0, 120)} → retry 1/1`)
      thumbUrlCache.delete(messageId)
      invalidateThumb(messageId) // MAJOR 5 FIX: invalidate thumbLoader cache
      thumbRetryCount.set(messageId, 1)
      // Trigger reload by setting url to null then letting the effect re-run
      setUrl(null)
      setBroken(false)
      // Force re-load by toggling visibility
      setIsVisible(false)
      setTimeout(() => setIsVisible(true), 0)
    } else {
      // Retry exhausted: mark as broken
      console.log(`[thumb] img onError id=${messageId} retry exhausted → placeholder`)
      setBroken(true)
    }
  }

  const resolution = isVideo ? resolutionLabel(height) : null

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
        {url && !broken ? (
          <>
            <img
              src={url}
              loading="lazy"
              decoding="async"
              className="mf-gm-img"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={handleImageError}
            />
            {isVideo && <div className="mf-gm-play"><Play size={22} /></div>}
            {resolution && <div className="mf-gm-resolution">{resolution}</div>}
          </>
        ) : !url && !broken ? (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{
              width: 24, height: 24,
              border: '3px solid rgba(255,255,255,0.1)',
              borderTopColor: '#7c83ff',
              borderRadius: '50%',
              animation: 'spin .8s linear infinite'
            }} />
          </div>
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.02)', position: 'relative' }}>
            {isVideo ? '🎬' : (typeLabel === 'Изображения' ? '🖼️' : '📄')}
            {resolution && <div className="mf-gm-resolution">{resolution}</div>}
          </div>
        )}
    </div>
  )
})
