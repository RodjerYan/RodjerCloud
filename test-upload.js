const { _electron: electron } = require('playwright')
const path = require('path')
const fs = require('fs')

const LOG_PATH = path.join(process.env.APPDATA, 'rodjercloud', 'rodjercloud.log')
const EXE = path.join(__dirname, 'dist', 'win-unpacked', 'RodjerCloud.exe')

function log(msg) { console.log(`[TEST ${new Date().toISOString().slice(11,19)}] ${msg}`) }

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function readLog() {
  try {
    const raw = fs.readFileSync(LOG_PATH, 'utf8')
    return raw.split('\n').filter(l => l.trim())
  } catch { return [] }
}

async function main() {
  if (!fs.existsSync(EXE)) {
    log('ERROR: Build first! npx electron-vite build && npx electron-builder --win --publish never')
    process.exit(1)
  }

  // Clear log
  try { fs.writeFileSync(LOG_PATH, '') } catch {}
  log('Launching Electron app...')

  const electronApp = await electron.launch({
    executablePath: EXE,
    args: ['.'],
    timeout: 30000,
  })

  log('Waiting for first window...')
  const window = await electronApp.firstWindow()
  log('Window found! Waiting for DOM...')

  await sleep(8000)

  // Screenshot initial state
  await window.screenshot({ path: path.join(__dirname, 'test-screenshots', '01-startup.png') }).catch(() => {})
  log('Screenshot saved: 01-startup.png')

  // Check log for startup
  let logLines = await readLog()
  log(`Log lines after startup: ${logLines.length}`)
  logLines.slice(-5).forEach(l => log(`  ${l}`))

  // Check if we need to login
  const url = window.url()
  log(`Current URL: ${url}`)

  // Check what's on screen
  const pageText = await window.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '')
  log(`Page text preview: ${pageText.slice(0, 200)}`)

  // Try to detect login screen vs main screen
  const hasLogin = await window.evaluate(() => !!document.querySelector('input[type="tel"], input[placeholder*="phone"], input[placeholder*="телефон"]')).catch(() => false)
  const hasUpload = await window.evaluate(() => document.body?.innerText?.includes('Загруз') || document.body?.innerText?.includes('Upload')).catch(() => false)
  const hasSidebar = await window.evaluate(() => !!document.querySelector('.sidebar, [class*="sidebar"]')).catch(() => false)

  log(`Login inputs: ${hasLogin}, Upload text: ${hasUpload}, Sidebar: ${hasSidebar}`)

  if (hasLogin) {
    log('LOGIN SCREEN detected. Session expired or no session.')
    log('Cannot auto-login - need phone number + code.')
    log('Taking screenshot and exiting...')
    await window.screenshot({ path: path.join(__dirname, 'test-screenshots', '02-login-screen.png') }).catch(() => {})
    await electronApp.close()
    process.exit(0)
  }

  // If we are on main screen, navigate to Upload page
  if (hasSidebar) {
    log('Main screen detected! Navigating to Upload...')

    // Try clicking Upload in sidebar
    const uploadClicked = await window.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, div[role="button"], div[class*="nav"], span'))
      const upload = links.find(el => el.textContent?.includes('Загруз') || el.textContent?.includes('Upload'))
      if (upload) { upload.click(); return true }
      return false
    })

    if (uploadClicked) {
      log('Clicked Upload in sidebar')
    } else {
      log('Could not find Upload link in sidebar, navigating directly...')
      await window.evaluate(() => { window.location.hash = '#/upload' }).catch(() => {})
    }

    await sleep(2000)
    await window.screenshot({ path: path.join(__dirname, 'test-screenshots', '03-upload-page.png') }).catch(() => {})
    log('Screenshot saved: 03-upload-page.png')

    // Now trigger file picker and select a test file
    const ARCHIVE = path.join(process.env.USERPROFILE, 'OneDrive', 'Рабочий стол', 'archive')
    let testFile = ''
    if (fs.existsSync(ARCHIVE)) {
      const files = fs.readdirSync(ARCHIVE).filter(f => f.toLowerCase().endsWith('.mov'))
      if (files.length > 0) testFile = path.join(ARCHIVE, files[0])
    }

    if (!testFile) {
      // Use a small HEIC
      if (fs.existsSync(ARCHIVE)) {
        const files = fs.readdirSync(ARCHIVE).filter(f => f.toLowerCase().endsWith('.heic'))
        if (files.length > 0) testFile = path.join(ARCHIVE, files[0])
      }
    }

    if (!testFile) {
      log('No test file found in archive folder')
      await electronApp.close()
      process.exit(1)
    }

    const fileSize = fs.statSync(testFile).size
    log(`Test file: ${path.basename(testFile)} (${(fileSize/1024/1024).toFixed(1)}MB)`)

    // Stub the dialog to return our test file
    await electronApp.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [filePath] })
      dialog.showOpenDialogSync = () => [filePath]
    }, testFile)
    log('Stubbed dialog.showOpenDialog')

    // Click "Add file" / "Выбрать файл" / "+" button
    const addClicked = await window.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, div[role="button"], a, span'))
      const add = btns.find(el => {
        const text = el.textContent?.toLowerCase() || ''
        return text.includes('выбрать файл') || text.includes('add file') || text.includes('выбрать') || text.includes('+') || text.includes('добавить')
      })
      if (add) { add.click(); return add.textContent?.trim() }
      return null
    })

    if (addClicked) {
      log(`Clicked button: "${addClicked}"`)
    } else {
      log('Could not find Add file button. Trying file input...')
      const fileInput = await window.$('input[type="file"]')
      if (fileInput) {
        await fileInput.setInputFiles(testFile)
        log('Set files on input[type="file"]')
      } else {
        log('ERROR: No file input found either!')
        // Try clicking anything that looks like it adds files
        const allBtns = await window.evaluate(() => {
          return Array.from(document.querySelectorAll('button, [role="button"]')).map(el => ({
            text: el.textContent?.trim()?.slice(0, 50),
            class: el.className?.slice(0, 50),
            tag: el.tagName
          }))
        })
        log(`Available buttons: ${JSON.stringify(allBtns)}`)
      }
    }

    await sleep(3000)
    await window.screenshot({ path: path.join(__dirname, 'test-screenshots', '04-after-add.png') }).catch(() => {})
    log('Screenshot saved: 04-after-add.png')

    // Check if file appeared in queue
    const queueText = await window.evaluate(() => document.body?.innerText?.slice(0, 1000) || '').catch(() => '')
    log(`Queue area text: ${queueText.slice(0, 300)}`)

    // Try clicking "Upload" / "Загрузить" button to start upload
    await sleep(1000)
    const startUploadClicked = await window.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, div[role="button"]'))
      const upload = btns.find(el => {
        const text = el.textContent?.toLowerCase() || ''
        return text.includes('загрузить') || text.includes('upload') || text.includes('начать')
      })
      if (upload) { upload.click(); return upload.textContent?.trim() }
      return null
    })

    if (startUploadClicked) {
      log(`Clicked upload button: "${startUploadClicked}"`)
    } else {
      log('No explicit upload button found (upload may auto-start)')
    }

    await sleep(2000)
    await window.screenshot({ path: path.join(__dirname, 'test-screenshots', '05-upload-started.png') }).catch(() => {})
    log('Screenshot saved: 05-upload-started.png')

    // Monitor log during upload
    log('Monitoring log during upload...')
    const monitorStart = Date.now()
    const MONITOR_TIME = 2 * 60 * 1000 // 2 minutes
    let prevCount = (await readLog()).length

    while (Date.now() - monitorStart < MONITOR_TIME) {
      await sleep(10000)
      const lines = await readLog()
      if (lines.length > prevCount) {
        const newLines = lines.slice(prevCount)
        newLines.forEach(l => log(`  ${l}`))
        prevCount = lines.length
      }

      // Check for diagnostic markers
      for (const m of ['[FATAL]', '[window.close]', '[window.all-closed]', '[before-quit]',
        '[unresponsive]', '[render-process-gone]', '[renderer beforeunload]']) {
        const found = lines.filter(l => l.includes(m))
        if (found.length > 0) {
          log(`*** ALERT: Found "${m}" (${found.length}x) ***`)
          log(`  Last: ${found[found.length - 1]}`)
        }
      }

      // Check if process is still alive
      const exited = electronApp.process().exitCode !== null && electronApp.process().exitCode !== undefined
      if (exited) {
        log(`Process exited! Code: ${electronApp.process().exitCode}`)
        break
      }

      // Take periodic screenshot
      if (Date.now() - monitorStart % 30000 < 10000) {
        await window.screenshot({ path: path.join(__dirname, 'test-screenshots', '06-during-upload.png') }).catch(() => {})
      }
    }

    // Final screenshot
    await window.screenshot({ path: path.join(__dirname, 'test-screenshots', '07-final.png') }).catch(() => {})
    log('Screenshot saved: 07-final.png')
  }

  // Final log analysis
  const finalLog = await readLog()
  log('\n=== FULL FINAL LOG ===')
  finalLog.forEach(l => log(l))

  log('\n=== DIAGNOSTIC SUMMARY ===')
  const markers = {
    'FATAL': finalLog.filter(l => l.includes('[FATAL]')),
    'window.close': finalLog.filter(l => l.includes('[window.close]')),
    'window.closed': finalLog.filter(l => l.includes('[window.closed]')),
    'window.all-closed': finalLog.filter(l => l.includes('[window-all-closed]')),
    'before-quit': finalLog.filter(l => l.includes('[before-quit]')),
    'will-quit': finalLog.filter(l => l.includes('[will-quit]')),
    'unresponsive': finalLog.filter(l => l.includes('[unresponsive]')),
    'render-process-gone': finalLog.filter(l => l.includes('[render-process-gone]')),
    'renderer beforeunload': finalLog.filter(l => l.includes('[renderer beforeunload]')),
    'window:close IPC': finalLog.filter(l => l.includes('[window:close IPC]')),
  }
  for (const [name, entries] of Object.entries(markers)) {
    log(`${name}: ${entries.length > 0 ? `${entries.length}x` : 'NONE'}`)
    if (entries.length > 0) entries.forEach(e => log(`  ${e}`))
  }

  log('\nClosing app...')
  await electronApp.close()
  log('Done.')
}

// Create screenshots dir
fs.mkdirSync(path.join(__dirname, 'test-screenshots'), { recursive: true })

main().catch(async e => {
  log(`FATAL ERROR: ${e.message}`)
  log(e.stack)
  process.exit(1)
})
