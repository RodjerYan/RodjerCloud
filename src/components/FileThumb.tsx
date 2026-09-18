import React, { useState, useEffect, useRef } from 'react'
import { Play } from 'lucide-react'
import { loadThumb } from '../lib/thumbLoader'

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
}

export const FileThumb: React.FC<FileThumbProps> = ({ messageId, fileName, isVideo, typeLabel }) => {
  const [url, setUrl] = useState<string | null>(null)
  const [isVisible, setIsVisible] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (el) {
      observe(el, () => setIsVisible(true))
    }
    return () => {
      if (el) unobserve(el)
    }
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

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      {url ? (
        <>
          <img src={url} loading="lazy" decoding="async" className="mf-gm-img" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          {isVideo && <div className="mf-gm-play"><Play size={22} /></div>}
        </>
      ) : (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.02)' }}>
          {isVideo ? '🎬' : (typeLabel === 'Изображения' ? '🖼️' : '📄')}
        </div>
      )}
    </div>
  )
}
