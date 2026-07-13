const { Api, TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');

async function testSearch() {
  const storePath = './rodjercloud-store.json';
  if (!fs.existsSync(storePath)) {
    console.error('Store not found.');
    return;
  }
  const storeStr = fs.readFileSync(storePath, 'utf8');
  let store;
  try {
    store = JSON.parse(storeStr);
  } catch(e) {
    console.error('JSON parse error');
    return;
  }
  const sessionString = store.session;
  if (!sessionString) {
    console.error('No session found');
    return;
  }

  const apiId = 35766547;
  const apiHash = '5e37a0cba3964d7ca0814147562452ce';
  
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, { connectionRetries: 1 });
  await client.connect();

  console.log("Connected! Searching for 'Механик'...");

  try {
    const result = await client.invoke(new Api.messages.SearchGlobal({
      q: 'Механик',
      limit: 10,
      offsetRate: 0,
      offsetPeer: 'Empty',
      offsetId: 0,
      folderId: undefined
    }));
    
    console.log("Results found:", result.messages.length);
    result.messages.forEach(m => {
      console.log(`[${m.id}] ${m.message ? m.message.substring(0, 50) : ''}`);
    });
  } catch (err) {
    console.error("Search error:", err);
  }

  await client.disconnect();
}
testSearch();
