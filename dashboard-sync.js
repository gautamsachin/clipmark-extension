// dashboard-sync.js
// Injected on the dashboard page to sync auth state with the extension.
// Reads clipmark_sync_token + clipmark_user_profile from localStorage (set by SyncTokenExposer)
// and forwards them to the background service worker via message.

(function () {
  let pollInterval = null

  const isExtensionAlive = () => {
    try { return !!chrome?.runtime?.id } catch { return false }
  }

  const stopPolling = () => {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null }
  }

  const safeSend = (msg) => {
    if (!isExtensionAlive()) { stopPolling(); return }
    try {
      chrome.runtime.sendMessage(msg, () => {
        if (chrome.runtime.lastError) { /* swallow */ }
      })
    } catch {
      stopPolling()
    }
  }

  const getToken = () => {
    try { return localStorage.getItem('clipmark_sync_token') } catch { return null }
  }

  const getProfile = () => {
    try {
      const raw = localStorage.getItem('clipmark_user_profile')
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  }

  const sync = (token) => {
    if (token) {
      // Pass profile alongside token so background.js doesn't need to call /verify
      const profile = getProfile()
      safeSend({ action: 'SAVE_SYNC_TOKEN', token, profile })
    } else {
      safeSend({ action: 'CLEAR_SYNC_TOKEN' })
    }
  }

  // Initial check
  sync(getToken())

  // Cross-tab login/logout
  window.addEventListener('storage', (e) => {
    if (e.key === 'clipmark_sync_token' || e.key === 'clipmark_user_profile') {
      try {
        if (!isExtensionAlive()) { stopPolling(); return }
        sync(getToken())
      } catch { stopPolling() }
    }
  })

  // SPA navigation poll
  let lastToken = getToken()
  pollInterval = setInterval(() => {
    try {
      if (!isExtensionAlive()) { stopPolling(); return }
      const current = getToken()
      if (current !== lastToken) { lastToken = current; sync(current) }
    } catch {
      stopPolling()
    }
  }, 2000)
})()