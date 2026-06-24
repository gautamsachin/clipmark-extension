// background.js — Clipmark extension

const DASHBOARD_URL = 'https://clipmark-fawn.vercel.app'
const API_BASE = `${DASHBOARD_URL}/api`

// ── Promisified helpers ───────────────────────────────────────────────────────
const sendTabMessage = (tabId, msg) =>
  new Promise(resolve => chrome.tabs.sendMessage(tabId, msg, resp => {
    if (chrome.runtime.lastError) resolve(null); else resolve(resp)
  }))

const queryActiveTabs = () =>
  new Promise(resolve => chrome.tabs.query({ active: true, currentWindow: true }, resolve))

const captureTab = (windowId) =>
  new Promise(resolve => chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 72 }, img => {
    if (chrome.runtime.lastError) resolve(null); else resolve(img)
  }))

const getStorage = (key) => new Promise(resolve => chrome.storage.local.get(key, resolve))
const setStorage = (obj) => new Promise(resolve => chrome.storage.local.set(obj, resolve))

const formatTime = (secs) => {
  const m = Math.floor(secs / 60), s = secs % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
const getAuthToken = async () => {
  const data = await getStorage('sync_token')
  return data?.sync_token || null
}

const syncToCloud = async (bookmark) => {
  const token = await getAuthToken()
  if (!token) {
    console.log('Skipping cloud sync: Not connected to dashboard.')
    return { ok: false, error: 'Not connected' }
  }

  try {
    const response = await fetch(`${API_BASE}/bookmarks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        video_id: bookmark.video_id,
        site: bookmark.site,
        url: bookmark.url,
        timestamp: bookmark.timestamp,
        notes: bookmark.notes || null,
        tags: bookmark.tags || [],
        screenshot_url: bookmark.screenshot_url || bookmark.screenshot || null
      })
    })

    const data = await response.json()
    if (!response.ok) {
      if (response.status === 401) {
        chrome.storage.local.remove(['sync_token', 'user_profile'])
      }
      console.error('Cloud sync failed:', data.error)
      return { ok: false, error: data.error }
    }
    console.log('Cloud sync successful:', data)
    return { ok: true, bookmark: data.bookmark }
  } catch (err) {
    console.error('Cloud sync network error:', err)
    return { ok: false, error: err.message }
  }
}

const syncAllUnsyncedBookmarks = async () => {
  const token = await getAuthToken()
  if (!token) {
    console.log('Skipping batch sync: Not connected.')
    return
  }

  try {
    // 1. Fetch current cloud bookmarks to check what's already there
    const response = await fetch(`${API_BASE}/bookmarks`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    })

    if (!response.ok) {
      if (response.status === 401) {
        chrome.storage.local.remove(['sync_token', 'user_profile'])
      }
      console.error('Failed to fetch bookmarks for sync checking:', response.statusText)
      return
    }

    const resData = await response.json()
    const cloudBookmarks = resData.bookmarks || []
    const cloudVideoIds = new Set(cloudBookmarks.map(b => b.video_id))

    // 2. Fetch local bookmarks
    const localData = await getStorage('bookmarks')
    const localBookmarks = localData.bookmarks || {}
    let updatedLocalCount = 0

    // 3. Mark already synced items
    for (const videoId in localBookmarks) {
      if (cloudVideoIds.has(videoId)) {
        if (!localBookmarks[videoId].synced) {
          localBookmarks[videoId].synced = true
          const cloudBm = cloudBookmarks.find(b => b.video_id === videoId)
          if (cloudBm && cloudBm.screenshot_url) {
            localBookmarks[videoId].screenshot = cloudBm.screenshot_url
          }
          updatedLocalCount++
        }
      }
    }

    // 4. Sync unsynced bookmarks
    for (const videoId in localBookmarks) {
      const bm = localBookmarks[videoId]
      if (!bm.synced) {
        console.log(`Syncing bookmark to cloud: ${videoId}`)
        const syncRes = await syncToCloud({
          video_id: videoId,
          site: bm.site,
          url: bm.url,
          timestamp: bm.timestamp,
          notes: bm.notes || null,
          tags: bm.tags || [],
          screenshot_url: bm.screenshot || null,
        })

        if (syncRes.ok) {
          bm.synced = true
          if (syncRes.bookmark?.screenshot_url) {
            bm.screenshot = syncRes.bookmark.screenshot_url
          }
          updatedLocalCount++
        } else {
          console.error(`Failed to sync bookmark ${videoId}:`, syncRes.error)
        }
      }
    }

    // 5. Save updated local bookmarks if any changed
    if (updatedLocalCount > 0) {
      await setStorage({ bookmarks: localBookmarks })
      console.log(`Successfully synced/marked ${updatedLocalCount} bookmarks.`)
    }
  } catch (err) {
    console.error('Error during bookmarks sync:', err)
  }
}

// ── Context menu ──────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'saveBookmark',
    title: '🔖 Save Bookmark',
    contexts: ['page', 'video'],
    documentUrlPatterns: [
      'https://www.instagram.com/reel/*',
      'https://www.instagram.com/reels/*',
      'https://www.youtube.com/watch*',
      'https://www.youtube.com/shorts/*'
    ]
  })
})

// ── Core save ─────────────────────────────────────────────────────────────────
const captureAndSave = async (tab, extraData = {}) => {
  const igMatch = tab.url?.match(/instagram\.com\/reels?\/([^/]+)/)
  const ytMatch = tab.url?.match(/youtube\.com\/watch\?.*v=([^&]+)/)
  const ytShort = tab.url?.match(/youtube\.com\/shorts\/([^/?]+)/)

  const videoId = igMatch?.[1] || ytMatch?.[1] || ytShort?.[1]
  const site = igMatch ? 'instagram' : 'youtube'
  if (!videoId) return { ok: false, error: 'Not a supported page' }

  // Get timestamp
  let timestamp = 0
  const resp = await sendTabMessage(tab.id, { action: 'GET_VIDEO_INFO' })
  if (resp?.timestamp != null) timestamp = resp.timestamp

  // Screenshot
  const screenshot = await captureTab(tab.windowId)

  // Save locally
  const data = await getStorage('bookmarks')
  const bookmarks = data.bookmarks || {}
  const existing = bookmarks[videoId] || {}

  const bookmark = {
    ...existing,
    ...extraData,
    video_id: videoId,
    site,
    url: tab.url,
    timestamp,
    savedAt: Date.now(),
    screenshot: screenshot || existing.screenshot || null,
    synced: false
  }

  bookmarks[videoId] = bookmark
  await setStorage({ bookmarks })

  // Sync to cloud (handle asynchronously)
  syncToCloud({
    video_id: videoId,
    site,
    url: tab.url,
    timestamp,
    notes: extraData.notes || existing.notes || null,
    tags: extraData.tags || existing.tags || [],
    screenshot_url: screenshot || null,
  }).then(async (syncRes) => {
    if (syncRes.ok) {
      const updatedData = await getStorage('bookmarks')
      const currentBms = updatedData.bookmarks || {}
      if (currentBms[videoId]) {
        currentBms[videoId].synced = true
        if (syncRes.bookmark?.screenshot_url) {
          currentBms[videoId].screenshot = syncRes.bookmark.screenshot_url
        }
        await setStorage({ bookmarks: currentBms })
      }
    }
  })

  return { ok: true, videoId, site, timestamp }
}

// ── Context menu click ────────────────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'saveBookmark') return
  captureAndSave(tab).then(result => {
    if (!result.ok) return
    chrome.action.setBadgeText({ text: '✓', tabId: tab.id })
    chrome.action.setBadgeBackgroundColor({ color: '#3dd68c', tabId: tab.id })
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }), 2500)
    sendTabMessage(tab.id, {
      action: 'OPEN_INPAGE_EDIT_MODAL',
      videoId: result.videoId,
      site: result.site,
      timestamp: result.timestamp,
      timeLabel: formatTime(result.timestamp)
    })
  })
})

// ── Messages from popup ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'CAPTURE_AND_SAVE') {
    queryActiveTabs().then(([tab]) =>
      captureAndSave(tab, msg.extraData || {}).then(sendResponse)
    )
    return true
  }

  if (msg.action === 'OPEN_VIDEO') {
    const url = msg.site === 'youtube'
      ? `https://www.youtube.com/watch?v=${msg.videoId}&t=${msg.timestamp}`
      : `https://www.instagram.com/reel/${msg.videoId}/`
    chrome.tabs.create({ url }, tab => sendResponse({ tabId: tab.id }))
    return true
  }

  if (msg.action === 'UPDATE_METADATA') {
    getStorage('bookmarks').then(data => {
      const bookmarks = data.bookmarks || {}
      if (bookmarks[msg.videoId]) {
        bookmarks[msg.videoId].notes = msg.notes ?? bookmarks[msg.videoId].notes
        bookmarks[msg.videoId].tags = msg.tags ?? bookmarks[msg.videoId].tags
        bookmarks[msg.videoId].synced = false
        setStorage({ bookmarks }).then(() => {
          syncToCloud({ ...bookmarks[msg.videoId], video_id: msg.videoId }).then(async (syncRes) => {
            if (syncRes.ok) {
              const updatedData = await getStorage('bookmarks')
              const currentBms = updatedData.bookmarks || {}
              if (currentBms[msg.videoId]) {
                currentBms[msg.videoId].synced = true
                if (syncRes.bookmark?.screenshot_url) {
                  currentBms[msg.videoId].screenshot = syncRes.bookmark.screenshot_url
                }
                await setStorage({ bookmarks: currentBms })
              }
            }
          })
          sendResponse({ ok: true })
        })
      } else sendResponse({ ok: false })
    })
    return true
  }

  if (msg.action === 'SAVE_SYNC_TOKEN') {
    // If profile was passed directly from dashboard, skip /verify API call
    if (msg.profile && msg.profile.email) {
      setStorage({
        sync_token: msg.token,
        user_profile: { email: msg.profile.email, plan: msg.profile.plan || 'free' }
      }).then(() => {
        syncAllUnsyncedBookmarks()
        sendResponse && sendResponse({ ok: true, profile: msg.profile })
      })
      return true
    }

    // Fallback: verify via API (needs service role key or RPC function in Supabase)
    fetch(`${API_BASE}/sync-token/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: msg.token })
    })
      .then(r => r.json())
      .then(data => {
        if (data.valid) {
          setStorage({
            sync_token: msg.token,
            user_profile: { email: data.profile?.email || '', plan: data.profile?.plan || 'free' }
          }).then(() => {
            syncAllUnsyncedBookmarks()
            sendResponse({ ok: true, profile: data.profile })
          })
        } else {
          sendResponse({ ok: false, error: 'Invalid token' })
        }
      })
      .catch(err => sendResponse({ ok: false, error: err.message }))
    return true
  }

  if (msg.action === 'TRIGGER_SYNC') {
    syncAllUnsyncedBookmarks().then(() => sendResponse && sendResponse({ ok: true }))
    return true
  }

  if (msg.action === 'CLEAR_SYNC_TOKEN') {
    chrome.storage.local.remove(['sync_token', 'user_profile'], () => sendResponse({ ok: true }))
    return true
  }

  if (msg.action === 'GET_PREMIUM_STATUS') {
    getAuthToken().then(token => {
      if (!token) {
        sendResponse({ ok: false, error: 'No token' })
        return
      }
      fetch(`${API_BASE}/user/premium-status`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })
        .then(r => {
          if (!r.ok) {
            if (r.status === 401) {
              chrome.storage.local.remove(['sync_token', 'user_profile'])
            }
            throw new Error('API error')
          }
          return r.json()
        })
        .then(data => {
          // Sync plan status in storage
          if (data.plan) {
            getStorage('user_profile').then(d => {
              const u = d.user_profile || {}
              setStorage({ user_profile: { ...u, plan: data.plan } })
            })
          }
          sendResponse({ ok: true, data })
        })
        .catch(err => sendResponse({ ok: false, error: err.message }))
    })
    return true
  }

  if (msg.action === 'SYNC_BOOKMARK_TO_CLOUD') {
    syncToCloud(msg.bookmark).then(sendResponse)
    return true
  }

  if (msg.action === 'CLEAR_ALL_CLOUD') {
    getAuthToken().then(token => {
      if (!token) { sendResponse({ ok: false, error: 'Not connected' }); return }
      fetch(`${API_BASE}/bookmarks`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      })
        .then(r => r.json())
        .then(data => sendResponse({ ok: true, data }))
        .catch(err => sendResponse({ ok: false, error: err.message }))
    })
    return true
  }

  if (msg.action === 'OPEN_DASHBOARD') {
    chrome.tabs.create({ url: DASHBOARD_URL })
    return false
  }
})