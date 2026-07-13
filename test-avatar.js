const { TelegramClient } = require('telegram')
const { StringSession } = require('telegram/sessions')
const fs = require('fs')

async function run() {
  const sessionData = fs.readFileSync('/Users/alexander/.rodjercloud_session', 'utf8').trim()
  const client = new TelegramClient(new StringSession(sessionData), 2040, 'b18441a1ff607e10a989891a5462e627', { connectionRetries: 1 })
  await client.connect()
  const me = await client.getMe()
  const tmpPath = 'avatar_tmp'
  try {
    const res = await client.downloadProfilePhoto(me, { outputFile: tmpPath })
    console.log('Result:', res)
    console.log('File size:', fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 'not found')
  } catch (e) {
    console.error('Error:', e)
  }
  process.exit(0)
}
run()
