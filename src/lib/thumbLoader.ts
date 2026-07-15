type ThumbCallback = (url: string | null) => void;

const queue: { messageId: number; fileName: string; cb: ThumbCallback }[] = [];
let processing = false;
const BATCH_SIZE = 10;
const cache: Record<number, string> = {};

export function loadThumb(messageId: number, fileName: string, cb: ThumbCallback) {
  if (cache[messageId]) {
    cb(cache[messageId]);
    return;
  }
  queue.push({ messageId, fileName, cb });
  if (!processing) processQueue();
}

async function processQueue() {
  processing = true;
  while (queue.length > 0) {
    const batch = queue.splice(0, BATCH_SIZE);
    await Promise.all(batch.map(async (item) => {
      try {
        const r = await window.electronAPI.telegram.downloadThumbnail(item.messageId, item.fileName);
        if (r.success && r.data) {
          const d = await window.electronAPI.file.getLocalUrl(r.data);
          if (d.success) {
            cache[item.messageId] = d.data;
            item.cb(d.data);
            return;
          }
        }
      } catch {}
      item.cb(null);
    }));
  }
  processing = false;
}
