// content.js v6 — reliable timestamp capture for Instagram + YouTube

(function () {

  // ── Site detection ─────────────────────────────────────────────────────────
  const isYouTube   = location.hostname.includes('youtube.com')
  const isInstagram = location.hostname.includes('instagram.com')

  // ── Video ID from URL ──────────────────────────────────────────────────────
  const getVideoInfo = () => {
    if (isYouTube) {
      const watchMatch  = location.search.match(/[?&]v=([^&]+)/)
      const shortsMatch = location.pathname.match(/\/shorts\/([^/?]+)/)
      const id = watchMatch?.[1] || shortsMatch?.[1] || null
      return id ? { id, site: 'youtube' } : null
    }
    if (isInstagram) {
      const m = location.pathname.match(/\/reels?\/([^/?]+)/)
      return m ? { id: m[1], site: 'instagram' } : null
    }
    return null
  }

  // ── Find the best video element ────────────────────────────────────────────
  const getActiveVideo = () => {
    const videos = Array.from(document.querySelectorAll('video'))
    if (!videos.length) return null

    if (isYouTube) {
      // YouTube: largest video with a source
      return videos
        .filter(v => v.src || v.currentSrc)
        .sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0]
        || videos[0]
    }

    // Instagram priority:
    // 1. Currently playing
    const playing = videos.find(v => !v.paused && !v.ended && v.readyState > 2)
    if (playing) return playing

    // 2. Largest by pixel area (most likely the main visible reel)
    const bySize = [...videos]
      .filter(v => v.videoWidth > 0)
      .sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))
    if (bySize.length) return bySize[0]

    // 3. Highest currentTime
    const byTime = [...videos].sort((a, b) => b.currentTime - a.currentTime)
    if (byTime[0]?.currentTime > 0) return byTime[0]

    // 4. Visible in viewport
    const visible = videos.find(v => {
      const r = v.getBoundingClientRect()
      return r.top >= 0 && r.bottom <= window.innerHeight && r.width > 100
    })
    return visible || videos[0]
  }

  // ── Timestamp tracking ─────────────────────────────────────────────────────
  // Key insight: track the PEAK time seen — Instagram reels loop back to 0
  // and popup opening pauses/blurs, so we can't rely on currentTime at save moment.
  let lastKnownTime  = 0  // most recent non-zero time
  let peakTime       = 0  // highest time seen this session (beats loop resets)
  let snapshotTime   = 0  // captured on blur/visibilitychange (right before popup opens)

  const readVideo = () => {
    const v = getActiveVideo()
    if (!v) return 0
    return Math.floor(v.currentTime)
  }

  const updateTime = () => {
    const t = readVideo()
    if (t > 0) {
      lastKnownTime = t
      if (t > peakTime) peakTime = t
    }
  }

  // Poll every 300ms while tab is visible
  const pollInterval = setInterval(updateTime, 300)

  // Snapshot RIGHT before focus leaves (popup opening causes blur)
  const onBlur = () => {
    const t = readVideo()
    if (t > 0) snapshotTime = t
    else if (lastKnownTime > 0) snapshotTime = lastKnownTime
  }

  window.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onBlur()
  })

  // Best timestamp = current live time > snapshot (most recent before popup) > lastKnown > peak
  const getBestTime = () => {
    const t = readVideo()
    if (t > 0) return t
    return snapshotTime || lastKnownTime || peakTime || 0
  }


  // ── Seek to saved timestamp on load ───────────────────────────────────────
  const applySavedTimestamp = () => {
    const info = getVideoInfo()
    if (!info) return
    chrome.storage.local.get('bookmarks', (data) => {
      const saved = (data.bookmarks || {})[info.id]
      if (!saved?.timestamp) return

      const doSeek = (video) => {
        const seek = () => { video.currentTime = saved.timestamp }
        if (video.readyState >= 1) seek()
        else video.addEventListener('loadedmetadata', seek, { once: true })
      }

      const v = getActiveVideo()
      if (v) { doSeek(v); return }

      const obs = new MutationObserver(() => {
        const v2 = getActiveVideo()
        if (v2) { obs.disconnect(); doSeek(v2) }
      })
      obs.observe(document.body, { childList: true, subtree: true })
    })
  }

  // ── In-page toast ─────────────────────────────────────────────────────────
  const showPageToast = (msg) => {
    document.getElementById('vbm-toast')?.remove()
    const el = document.createElement('div')
    el.id = 'vbm-toast'
    el.textContent = msg
    Object.assign(el.style, {
      position: 'fixed', bottom: '24px', left: '50%',
      transform: 'translateX(-50%)',
      background: '#3dd68c', color: '#0a0a0a',
      fontWeight: '700', fontSize: '13px',
      padding: '8px 18px', borderRadius: '24px',
      zIndex: '99999', boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      transition: 'opacity 0.4s', opacity: '1', pointerEvents: 'none'
    })
    document.body.appendChild(el)
    setTimeout(() => { el.style.opacity = '0' }, 2000)
    setTimeout(() => el.remove(), 2500)
  }

  // ── In-page edit modal ────────────────────────────────────────────────────
  const showPageEditModal = (data) => {
    document.getElementById('clipmark-edit-overlay')?.remove()

    const overlay = document.createElement('div')
    overlay.id = 'clipmark-edit-overlay'
    
    Object.assign(overlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100vw',
      height: '100vh',
      backgroundColor: 'rgba(0, 0, 0, 0.7)',
      backdropFilter: 'blur(4px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '999999',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      color: '#f3f4f6',
      opacity: '0',
      transition: 'opacity 0.25s ease-out'
    })

    const shadow = overlay.attachShadow({ mode: 'open' })

    const style = document.createElement('style')
    style.textContent = `
      .modal-box {
        background-color: #18181b;
        border: 1px solid #27272a;
        width: 100%;
        max-width: 400px;
        padding: 24px;
        border-radius: 16px;
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4);
        transform: scale(0.9);
        transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
        box-sizing: border-box;
      }
      .modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 18px;
      }
      .modal-title {
        font-size: 16px;
        font-weight: 700;
        color: #ffffff;
        margin: 0;
        letter-spacing: -0.3px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .modal-subtitle {
        font-size: 11px;
        color: #7c3aed;
        background: rgba(124, 58, 237, 0.15);
        border: 1px solid rgba(124, 58, 237, 0.3);
        padding: 2px 8px;
        border-radius: 20px;
        font-weight: 600;
        margin-top: 4px;
        display: inline-block;
      }
      .close-btn {
        background: transparent;
        border: none;
        color: #a1a1aa;
        font-size: 18px;
        cursor: pointer;
        padding: 4px;
        line-height: 1;
        transition: color 0.15s;
      }
      .close-btn:hover {
        color: #ffffff;
      }
      .form-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-bottom: 16px;
      }
      label {
        font-size: 10px;
        text-transform: uppercase;
        font-weight: 700;
        color: #71717a;
        letter-spacing: 0.5px;
      }
      textarea {
        background-color: #09090b;
        border: 1px solid #27272a;
        border-radius: 10px;
        padding: 10px 12px;
        color: #ffffff;
        font-size: 13px;
        font-family: inherit;
        resize: none;
        outline: none;
        transition: border-color 0.15s;
        box-sizing: border-box;
        width: 100%;
      }
      textarea:focus {
        border-color: #7c3aed;
      }
      input {
        background-color: #09090b;
        border: 1px solid #27272a;
        border-radius: 10px;
        padding: 10px 12px;
        color: #ffffff;
        font-size: 13px;
        font-family: inherit;
        outline: none;
        transition: border-color 0.15s;
        box-sizing: border-box;
        width: 100%;
      }
      input:focus {
        border-color: #7c3aed;
      }
      .actions {
        display: flex;
        gap: 10px;
        margin-top: 8px;
      }
      button.btn-primary {
        flex: 1;
        background-color: #7c3aed;
        color: #ffffff;
        border: none;
        border-radius: 10px;
        padding: 10px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: background-color 0.15s, transform 0.1s;
      }
      button.btn-primary:hover {
        background-color: #6d28d9;
      }
      button.btn-primary:active {
        transform: scale(0.98);
      }
    `

    const modalBox = document.createElement('div')
    modalBox.className = 'modal-box'
    modalBox.innerHTML = `
      <div class="modal-header">
        <div>
          <h2 class="modal-title">🔖 Bookmark Saved!</h2>
          <span class="modal-subtitle">${data.site === 'youtube' ? 'YouTube' : 'Instagram'} · ${data.timeLabel}</span>
        </div>
        <button class="close-btn" id="close-modal">✕</button>
      </div>
      <div class="form-group">
        <label>Comment / Note</label>
        <textarea id="bookmark-note" rows="3" placeholder="Add a comment... (optional)" maxlength="250"></textarea>
      </div>
      <div class="form-group">
        <label>Hashtags (comma or space separated)</label>
        <input type="text" id="bookmark-tags" placeholder="e.g. tutorial, coding, react" />
      </div>
      <div class="actions">
        <button class="btn-primary" id="save-modal">Done</button>
      </div>
    `

    shadow.appendChild(style)
    shadow.appendChild(modalBox)
    document.body.appendChild(overlay)

    setTimeout(() => {
      overlay.style.opacity = '1'
      modalBox.style.transform = 'scale(1)'
    }, 10)

    const noteTextarea = shadow.getElementById('bookmark-note')
    const tagsInput = shadow.getElementById('bookmark-tags')

    noteTextarea.focus()

    const saveAndClose = () => {
      const notes = noteTextarea.value.trim()
      const rawTags = tagsInput.value.trim()
      const tags = rawTags
        ? rawTags
            .split(/[,\s]+/)
            .map(t => t.replace(/^#/, '').trim())
            .filter(t => t.length > 0)
        : []

      chrome.runtime.sendMessage({
        action: 'UPDATE_METADATA',
        videoId: data.videoId,
        notes,
        tags
      }, (res) => {
        if (res?.ok) {
          showPageToast(`🔖 Saved: ${notes ? '"' + (notes.length > 20 ? notes.substring(0, 20) + '...' : notes) + '"' : 'tags updated'}`)
        }
      })

      overlay.style.opacity = '0'
      modalBox.style.transform = 'scale(0.9)'
      setTimeout(() => overlay.remove(), 250)
    }

    shadow.getElementById('close-modal').addEventListener('click', (e) => {
      e.stopPropagation()
      saveAndClose()
    })

    shadow.getElementById('save-modal').addEventListener('click', (e) => {
      e.stopPropagation()
      saveAndClose()
    })

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        saveAndClose()
      }
    })

    tagsInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        saveAndClose()
      }
    })

    const handleEsc = (e) => {
      if (e.key === 'Escape') {
        saveAndClose()
        document.removeEventListener('keydown', handleEsc)
      }
    }
    document.addEventListener('keydown', handleEsc)
  }

  // ── Message listener ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'GET_VIDEO_INFO') {
      // Do one final read in case poll hasn't run recently
      updateTime()
      const info = getVideoInfo()
      const timestamp = getBestTime()
      sendResponse({ id: info?.id || null, site: info?.site || null, timestamp })
      return false
    }
    if (msg.action === 'SHOW_SAVED_TOAST') {
      showPageToast(`🔖 Bookmarked at ${msg.timeLabel}`)
    }
    if (msg.action === 'OPEN_INPAGE_EDIT_MODAL') {
      showPageEditModal(msg)
    }
  })

  // ── Init ──────────────────────────────────────────────────────────────────
  applySavedTimestamp()

  // Instagram SPA nav — reset on reel change
  if (isInstagram) {
    let lastPath = location.pathname
    new MutationObserver(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname
        lastKnownTime = 0
        peakTime = 0
        snapshotTime = 0
        setTimeout(applySavedTimestamp, 800)
      }
    }).observe(document.body, { childList: true, subtree: true })
  }

  // YouTube SPA nav
  if (isYouTube) {
    let lastUrl = location.href
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href
        lastKnownTime = 0
        peakTime = 0
        snapshotTime = 0
        setTimeout(applySavedTimestamp, 1200)
      }
    }).observe(document.body, { childList: true, subtree: true })
  }

})()
