const { _electron: electron } = require('playwright')
const path = require('path')
const fs = require('fs')

const LOG_PATH = path.join(process.env.APPDATA, 'rodjercloud', 'rodjercloud.log')
const EXE = path.join(__dirname, 'dist', 'win-unpacked', 'RodjerCloud.exe')
const ARCHIVE = path.join(process.env.USERPROFILE, 'OneDrive', 'Рабочий стол', 'archive')
const SCREENSHOTS = path.join(__dirname, 'test-screenshots')

function log(msg) { console.log(`[TEST ${new Date().toISOString().slice(11,19)}] ${msg}`) }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
async function readLog() {
  try { return fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(l => l.trim()) } catch { return [] }
}

async function main() {
  if (!fs.existsSync(EXE)) { log('ERROR: Build first!'); process.exit(1) }
  fs.mkdirSync(SCREENSHOTS, { recursive: true })
  try { fs.writeFileSync(LOG_PATH, '') } catch {}

  log('=== STRESS TEST: Multiple MOV uploads + UI clicks ===')
  const electronApp = await electron.launch({ executablePath: EXE, args: ['.'], timeout: 30000 })
  const window = await electronApp.firstWindow()
  await sleep(10000)

  // Verify we're logged in
  const pageText = await window.evaluate(() => document.body?.innerText?.slice(0, 300) || '')
  if (!pageText.includes('Загрузить') && !pageText.includes('Мои файлы')) {
    log('Not logged in! Page: ' + pageText.slice(0, 200))
    await electronApp.close()
    process.exit(1)
  }
  log('Logged in. Main screen ready.')

  // Navigate to Upload
  await window.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a, div[role="button"], span'))
    const upload = links.find(el => el.textContent?.includes('Загрузить'))
    if (upload) upload.click()
  })
  await sleep(2000)

  // Get ALL MOV files
  const movFiles = fs.readdirSync(ARCHIVE).filter(f => f.toLowerCase().endsWith('.mov')).map(f => path.join(ARCHIVE, f))
  log(`Found ${movFiles.length} MOV files`)

  // Test 1: Upload first 3 MOVs sequentially via IPC (bypass file picker)
  for (let i = 0; i < Math.min(3, movFiles.length); i++) {
    const f = movFiles[i]
    const size = (fs.statSync(f).size / 1024 / 1024).toFixed(1)
    log(`\n--- Upload ${i+1}: ${path.basename(f)} (${size}MB) ---`)

    // Trigger upload via electron API (no dialog stubbing needed)
    const uploadId = `stress-${i}-${Date.now()}`
    await window.evaluate(async ({ filePath, id }) => {
      window.electronAPI.telegram.uploadFile(filePath, id)
    }, { filePath: f, id: uploadId })

    log(`Upload ${i+1} started (id=${uploadId})`)
  }

  // Also navigate around while uploading — click different sidebar items
  log('\n--- Navigating UI during uploads ---')
  const navItems = ['Мои файлы', 'Загрузить', 'Избранное', 'Корзина', 'Мои файлы', 'Загрузить']
  for (const item of navItems) {
    await sleep(5000)
    await window.evaluate((text) => {
      const els = Array.from(document.querySelectorAll('a, span, div[role="button"]'))
      const el = els.find(e => e.textContent?.includes(text))
      if (el) el.click()
    }, item)
    log(`Clicked: ${item}`)
    await window.screenshot({ path: path.join(SCREENSHOTS, `stress-nav-${item.replace(/\s/g, '-')}.png`) }).catch(() => {})
  }

  // Monitor for 2 minutes
  log('\n--- Monitoring log for crashes ---')
  let prevCount = (await readLog()).length
  const startTime = Date.now()
  while (Date.now() - startTime < 2 * 60 * 1000) {
    await sleep(5000)
    const lines = await readLog()
    if (lines.length > prevCount) {
      lines.slice(prevCount).forEach(l => log(`  ${l}`))
      prevCount = lines.length
    }

    for (const m of ['[FATAL]', '[window.close]', '[unresponsive]', '[render-process-gone]',
      '[window.all-closed]', '[before-quit]', '[will-quit]', '[renderer beforeunload]']) {
      const found = lines.filter(l => l.includes(m))
      if (found.length > 0) {
        log(`*** ALERT: "${m}" found (${found.length}x) ***`)
        found.forEach(f => log(`  ${f}`))
      }
    }

    // Periodic screenshot
    await window.screenshot({ path: path.join(SCREENSHOTS, `stress-${Math.floor((Date.now()-startTime)/1000)}s.png`) }).catch(() => {})
  }

  // Final
  await window.screenshot({ path: path.join(SCREENSHOTS, 'stress-final.png') }).catch(() => {})
  const finalLog = await readLog()

  log('\n=== FINAL LOG (all) ===')
  finalLog.forEach(l => log(l))

  log('\n=== DIAGNOSTIC SUMMARY ===')
  for (const m of ['FATAL', 'window.close', 'window.closed', 'window.all-closed', 'before-quit',
    'will-quit', 'unresponsive', 'render-process-gone', 'renderer beforeunload']) {
    const found = finalLog.filter(l => l.includes(`[${m}`) || l.includes(`[${m}]`))
    log(`${m}: ${found.length > 0 ? `${found.length}x` : 'NONE'}`)
    found.forEach(f => log(`  ${f}`))
  }

  await electronApp.close()
  log('Done.')
}

main().catch(async e => { log(`ERROR: ${e.stack}`); process.exit(1) })
