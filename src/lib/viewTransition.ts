let active = false

export function safeViewTransition(update: () => void): void {
  if (typeof document === 'undefined' || !('startViewTransition' in document) || active) {
    update()
    return
  }

  active = true
  let updated = false
  const runUpdate = () => {
    if (updated) return
    updated = true
    try { update() } catch {}
  }

  try {
    const t: any = (document as any).startViewTransition(() => {
      runUpdate()
    })
    // Safety: if the transition hangs (frozen dim overlay), skip after 400ms
    const timer = setTimeout(() => {
      runUpdate()
      try { t?.skipTransition?.() } catch {}
      active = false
    }, 400)
    const finish = () => {
      clearTimeout(timer)
      runUpdate()
      active = false
    }
    if (t?.finished && typeof t.finished.then === 'function') {
      t.finished.then(finish, finish)
    } else {
      finish()
    }
  } catch {
    runUpdate()
    active = false
  }
}
