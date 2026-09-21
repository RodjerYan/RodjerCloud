const { _electron: electron } = require('playwright')
const path = require('path')
const fs = require('fs')

const LOG_PATH = path.join(process.env.APPDATA, 'rodjercloud', 'rodjercloud.log')
const EXE = path.join(__dirname, 'dist', 'win-unpacked', 'RodjerCloud.exe')
const ARCHIVE = path.join(process.env.USERPROFILE, 'OneDrive', 'Рабочий стол', 'archive')

function log(msg) { console.log(`[TEST ${new Date().toISOString().slice(11,19)}] ${msg}`) }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
async function readLog() {
  try { return fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(l => l.trim()) } catch { return [] }
}

async function main() {
  if (!fs.existsSync(EXE)) { log('ERROR: no exe'); process.exit(1) }

  const testFiles = []
  for (let i = 1; i <= 5; i++) {
    const f = path.join(ARCHIVE, `test_300mb_${i}.bin`)
    if (fs.existsSync(f)) testFiles.push(f)
  }
  if (testFiles.length < 5) { log('ERROR: need 5 test files'); process.exit(1) }

  const totalMB = testFiles.reduce((s, f) => s + fs.statSync(f).size, 0) / 1024 / 1024
  log(`Test: ${testFiles.length} files, ${totalMB.toFixed(0)}MB total`)

  try { fs.writeFileSync(LOG_PATH, '') } catch {}
  log('Launching app...')

  const electronApp = await electron.launch({ executablePath: EXE, args: ['.'], timeout: 30000 })
  const window = await electronApp.firstWindow()
  log('Window found')
  await sleep(8000)

  const hasLogin = await window.evaluate(() => !!document.querySelector('input[type="tel"]')).catch(() => false)
  if (hasLogin) { log('Need login'); await electronApp.close(); process.exit(0) }

  // Navigate to upload page
  const navClicked = await window.evaluate(() => {
    const els = Array.from(document.querySelectorAll('a, span, div, button'))
    const upload = els.find(el => el.textContent?.trim() === 'Загрузить')
    if (upload) { upload.click(); return true }
    return false
  })
  log(`Nav: ${navClicked ? 'OK' : 'FAILED'}`)
  await sleep(3000)

  // Stub dialog to return 5 files
  await electronApp.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: files })
    dialog.showOpenDialogSync = () => files
  }, testFiles)
  log('Stubbed dialog for 5 files')

  // Click "Выбрать файлы"
  const clicked = await window.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'))
    const add = btns.find(el => el.textContent?.toLowerCase().includes('выбрать файл'))
    if (add) { add.click(); return add.textContent?.trim() }
    return null
  })
  log(`Clicked: ${clicked || 'NOTHING'}`)
  await sleep(5000)

  // Check renderer memory
  const rendererMem = await window.evaluate(() => {
    const p = performance
    return { heap: p.memory?.usedJSHeapSize || 0, total: p.memory?.totalJSHeapSize || 0, limit: p.memory?.jsHeapSizeLimit || 0 }
  }).catch(() => ({}))
  log(`Renderer memory: heap=${(rendererMem.heap/1024/1024).toFixed(0)}MB total=${(rendererMem.total/1024/1024).toFixed(0)}MB limit=${(rendererMem.limit/1024/1024).toFixed(0)}MB`)

  log('Monitoring for 15 minutes...')

  const monitorStart = Date.now()
  const MONITOR_TIME = 15 * 60 * 1000
  let prevCount = (await readLog()).length
  let uploadDone = false

  while (Date.now() - monitorStart < MONITOR_TIME) {
    await sleep(15000)

    let windowAlive = true
    try { const alive = await window.evaluate(() => true).catch(() => false); if (!alive) windowAlive = false } catch { windowAlive = false }

    const lines = await readLog()
    if (lines.length > prevCount) {
      lines.slice(prevCount).forEach(l => log(`  ${l}`))
      prevCount = lines.length
    }

    // Renderer memory
    const mem = await window.evaluate(() => {
      const p = performance
      return { heap: p.memory?.usedJSHeapSize || 0 }
    }).catch(() => ({ heap: 0 }))

    // Main process memory
    const procMem = lines.filter(l => l.includes('heap=')).pop()
    const heapMatch = procMem?.match(/heap=(\d+)MB/)
    const rssMatch = procMem?.match(/rss=(\d+)MB/)

    const oom = lines.some(l => l.includes('render-process-gone') || l.includes('oom'))
    const done = lines.filter(l => l.includes('[upload] done:'))
    if (done.length > 0 && !uploadDone) { uploadDone = true; log('*** UPLOAD COMPLETED ***') }

    const elapsed = Math.floor((Date.now() - monitorStart) / 1000)
    log(`  ${elapsed}s | window=${windowAlive ? 'ok' : 'DEAD'} | renderer=${(mem.heap/1024/1024).toFixed(0)}MB | main heap=${heapMatch?.[1] || '?'} rss=${rssMatch?.[1] || '?'} | done=${done.length}/5 | oom=${oom}`)

    const exited = electronApp.process().exitCode !== null
    if (exited) { log(`Process exited code=${electronApp.process().exitCode}`); break }

    if (oom) { log('*** OOM DETECTED ***'); break }
    if (done.length >= 5) { log('*** ALL UPLOADS DONE ***'); break }
  }

  const finalLog = await readLog()
  log('\n=== SUMMARY ===')
  log(`Upload done: ${finalLog.filter(l => l.includes('[upload] done:')).length}`)
  log(`OOM: ${finalLog.filter(l => l.includes('render-process-gone') || l.includes('oom')).length}`)
  log(`FATAL: ${finalLog.filter(l => l.includes('[FATAL]')).length}`)

  await window.screenshot({ path: path.join(__dirname, 'test-screenshots', 'bigfile-final.png') }).catch(() => {})
  log('Closing...')
  await electronApp.close()
  log('Done.')
}

fs.mkdirSync(path.join(__dirname, 'test-screenshots'), { recursive: true })
main().catch(async e => { log(`FATAL: ${e.message}`); process.exit(1) })
