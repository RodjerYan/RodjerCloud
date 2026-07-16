import React, { useState, useEffect, useRef } from 'react'
import { Play } from 'lucide-react'
import { loadThumb } from '../lib/thumbLoader'

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
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setIsVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' } // Load slightly before coming into view
    )

    if (containerRef.current) {
      observer.observe(containerRef.current)
    }

    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!isVisible) return

    let active = true
    loadThumb(messageId, fileName, (res) => {
      if (active && res) setUrl(res)
    })
    return () => { active = false }
  }, [messageId, fileName, isVisible])

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
