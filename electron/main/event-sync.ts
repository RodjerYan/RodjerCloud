import { TelegramService } from './telegram-service'
import { db, insertFolder, updateFolder, deleteFolder, addFileToFolder, removeFileFromFolder, setSyncState, getSyncState } from './db'

export type SyncEvent = 
  | { type: 'FOLDER_CREATE'; payload: { id: string; name: string; parentId: string | null; createdAt: number } }
  | { type: 'FOLDER_RENAME'; payload: { id: string; name: string } }
  | { type: 'FOLDER_DELETE'; payload: { id: string } }
  | { type: 'FILE_ADD'; payload: { messageId: number; folderId: string } }
  | { type: 'FILE_REMOVE'; payload: { messageId: number } }
  | { type: 'FILE_MOVE'; payload: { messageId: number; folderId: string | null } }

export class EventSyncService {
  private tg: TelegramService
  private syncing = false

  constructor(tg: TelegramService) {
    this.tg = tg
  }

  async publishEvent(event: SyncEvent) {
    try {
      const stateChannel = await this.tg.getOrCreateStateChannel()
      if (!stateChannel) return

      const jsonStr = JSON.stringify(event)
      await this.tg.client?.sendMessage(stateChannel, {
        message: '#event ' + jsonStr
      })
    } catch (e) {
      console.error('Failed to publish event:', e)
    }
  }

  async pullEvents() {
    if (this.syncing) return
    this.syncing = true
    try {
      const stateChannel = await this.tg.getOrCreateStateChannel()
      if (!stateChannel) return

      const lastEventIdStr = getSyncState('last_event_id') || '0'
      const lastEventId = parseInt(lastEventIdStr, 10)

      const messages = await this.tg.client?.getMessages(stateChannel, {
        limit: 100,
        minId: lastEventId
      }) as any[]

      if (!messages || messages.length === 0) return

      // Messages are returned newest first. We need oldest first to replay them sequentially.
      const sorted = [...messages].sort((a, b) => a.id - b.id)

      db.transaction(() => {
        let latestId = lastEventId
        for (const msg of sorted) {
          if (!msg.message || !msg.message.startsWith('#event ')) continue
          try {
            const jsonStr = msg.message.substring(7)
            const event: SyncEvent = JSON.parse(jsonStr)

            switch (event.type) {
              case 'FOLDER_CREATE':
                insertFolder(event.payload)
                break
              case 'FOLDER_RENAME':
                updateFolder(event.payload.id, event.payload.name)
                break
              case 'FOLDER_DELETE':
                deleteFolder(event.payload.id)
                break
              case 'FILE_ADD':
                addFileToFolder(event.payload.messageId, event.payload.folderId)
                break
              case 'FILE_REMOVE':
                removeFileFromFolder(event.payload.messageId)
                break
              case 'FILE_MOVE':
                if (event.payload.folderId) {
                  addFileToFolder(event.payload.messageId, event.payload.folderId)
                } else {
                  removeFileFromFolder(event.payload.messageId)
                }
                break
            }
          } catch (e) {
            console.error('Failed to process event message:', msg.id, e)
          }
          latestId = msg.id
        }
        setSyncState('last_event_id', latestId.toString())
      })()
      
    } catch (e) {
      console.error('Failed to pull events:', e)
    } finally {
      this.syncing = false
    }
  }

  startPolling() {
    setInterval(() => {
      this.pullEvents().catch(() => {})
    }, 15000)
  }
}
