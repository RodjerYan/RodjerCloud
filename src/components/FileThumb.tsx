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

  useEffect(() => {
    let active = true
    loadThumb(messageId, fileName, (res) => {
      if (active && res) setUrl(res)
    })
    return () => { active = false }
  }, [messageId, fileName])

  if (url) {
    return (
      <>
        <img src={url} className="mf-gm-img" />
        {isVideo && <div className="mf-gm-play"><Play size={22} /></div>}
      </>
    )
  }

  return <>{isVideo ? '🎬' : (typeLabel === 'Изображения' ? '🖼️' : '📄')}</>
}
