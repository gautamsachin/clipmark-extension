// popup.js — Clipmark

const $ = id => document.getElementById(id)

const fmt = s => { const m = Math.floor(s / 60); return m > 0 ? `${m}m ${s % 60}s` : `${s}s` }
const ago = ts => {
  const d = Date.now() - ts, m = Math.floor(d / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
const toast = (msg, isError = false) => {
  const t = $('toast')
  t.textContent = msg
  t.className = 'toast' + (isError ? ' error' : '')
  t.classList.add('show')
  setTimeout(() => t.classList.remove('show'), 2200)
}

// ── Storage ───────────────────────────────────────────────────────────────────
const getBm   = () => new Promise(r => chrome.storage.local.get('bookmarks', d => r(d.bookmarks || {})))
const setBm   = o  => new Promise(r => chrome.storage.local.set({ bookmarks: o }, r))
const getAuth = () => new Promise(r => chrome.storage.local.get(['sync_token', 'user_profile'], d => r({
  token: d.sync_token, user: d.user_profile
})))

// ── State ─────────────────────────────────────────────────────────────────────
let _videoId  = null
let _timestamp = 0
let _site     = null
let _editingId = null  // ID of bookmark being edited in top panel

// ── Tag widget ────────────────────────────────────────────────────────────────
const tagWidget = (el, initial = [], chipClass = 'tag-chip', inputClass = 'tag-input') => {
  let tags = [...initial]
  const render = () => {
    el.innerHTML = ''
    tags.forEach((tag, i) => {
      const c = document.createElement('div')
      c.className = chipClass
      c.innerHTML = `<span>#${tag}</span><button>×</button>`
      c.querySelector('button').onclick = () => { tags.splice(i, 1); render() }
      el.appendChild(c)
    })
    const inp = document.createElement('input')
    inp.className = inputClass
    inp.placeholder = tags.length ? 'add…' : '# tags…'
    inp.onkeydown = e => {
      if ((e.key === 'Enter' || e.key === ',') && inp.value.trim()) {
        e.preventDefault()
        const v = inp.value.trim().replace(/^#/, '').replace(/,/g, '').trim()
        if (v && !tags.includes(v)) tags.push(v)
        inp.value = ''; render()
      }
      if (e.key === 'Backspace' && !inp.value && tags.length) { tags.pop(); render() }
    }
    el.appendChild(inp)
    el.onclick = () => inp.focus()
  }
  render()
  return { get: () => tags, set: t => { tags = [...t]; render() } }
}

// ── Auth pill ─────────────────────────────────────────────────────────────────
const renderAuth = async () => {
  const { token, user } = await getAuth()
  const btn = $('authBtn')
  if (!token || !user) {
    btn.className = 'auth-pill signed-out'
    btn.textContent = 'Sign in'
    btn.onclick = () => { chrome.runtime.sendMessage({ action: 'OPEN_DASHBOARD' }); window.close() }
  } else {
    const isPro = user.plan === 'pro'
    btn.className = 'auth-pill signed-in'
    btn.innerHTML = `<span class="plan-dot ${isPro ? 'pro' : 'free'}"></span>${user.email?.split('@')[0] || 'Account'}`
    btn.title = `${user.email} · ${isPro ? 'Pro' : 'Free'} plan`
    btn.onclick = () => { chrome.runtime.sendMessage({ action: 'OPEN_DASHBOARD' }); window.close() }
  }
}

// ── Edit panel (shown in top panel) ──────────────────────────────────────────
let _editTagWidget = null

const openEditPanel = async (videoId) => {
  _editingId = videoId
  const bm = await getBm()
  const b = bm[videoId]
  if (!b) return

  const panel = $('topPanel')

  const thumb = b.screenshot
    ? `<img src="${b.screenshot}"/>`
    : `<div class="edit-panel-thumb-empty"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>`

  panel.innerHTML = `
    <div class="edit-panel">
      <div class="edit-panel-header">
        <div class="edit-panel-meta">
          <div class="edit-panel-thumb">${thumb}</div>
          <div class="edit-panel-info">
            <div class="edit-panel-id" title="${videoId}">${videoId}</div>
            <div class="edit-panel-site">${b.site} · ${fmt(b.timestamp)}</div>
          </div>
        </div>
        <button class="edit-close-btn" id="editCloseBtn">✕</button>
      </div>
      <div class="edit-panel-body">
        <textarea class="edit-note-input" id="editNoteInput" rows="2"
          placeholder="Add a note… (optional)" maxlength="250">${b.notes || ''}</textarea>
        <div class="edit-tags-row" id="editTagsRow"></div>
        <div class="edit-actions">
          <button class="edit-cancel-btn" id="editCancelBtn">Cancel</button>
          <button class="edit-save-btn" id="editSaveBtn">Save Changes</button>
        </div>
      </div>
    </div>`

  _editTagWidget = tagWidget($('editTagsRow'), b.tags || [], 'tag-chip', 'tag-input')

  $('editCloseBtn').onclick = () => closeEditPanel()
  $('editCancelBtn').onclick = () => closeEditPanel()

  $('editSaveBtn').onclick = () => {
    const btn = $('editSaveBtn')
    btn.textContent = 'Saving…'; btn.disabled = true
    const notes = $('editNoteInput').value.trim()
    const tags = _editTagWidget.get()
    chrome.runtime.sendMessage({ action: 'UPDATE_METADATA', videoId, notes, tags }, res => {
      if (res?.ok) {
        toast('✓ Saved')
        closeEditPanel()
      } else {
        toast('Failed', true)
        btn.textContent = 'Save Changes'; btn.disabled = false
      }
    })
  }

  renderList() // highlight the editing item in list
}

const closeEditPanel = () => {
  _editingId = null
  _editTagWidget = null
  renderVideoPanel()
  renderList()
}

// ── Video panel (top) ─────────────────────────────────────────────────────────
const renderVideoPanel = async (forceExpand = false) => {
  // If we're in edit mode, don't replace the edit panel
  if (_editingId) return

  const panel = $('topPanel')
  if (!_videoId) {
    panel.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon-wrap">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </div>
        <p>Open a YouTube or Instagram video</p>
        <small>Then save your bookmark here</small>
      </div>`
    return
  }

  const bm = await getBm()
  const saved = bm[_videoId]

  if (saved && !forceExpand) {
    const tagsHTML = saved.tags?.length
      ? saved.tags.map(t => `<span class="bm-tag">#${t}</span>`).join('') : ''
    panel.innerHTML = `
      <div class="saved-state">
        <div class="saved-row">
          <div class="saved-check">✓</div>
          <div class="saved-meta">
            <div class="saved-time">Saved at ${fmt(saved.timestamp)}</div>
            ${saved.notes ? `<div class="saved-note">${saved.notes}</div>` : ''}
            ${tagsHTML ? `<div class="bm-tags-row" style="margin-top:3px">${tagsHTML}</div>` : ''}
          </div>
          <button class="update-btn" id="updateBtn">Edit</button>
        </div>
      </div>`
    $('updateBtn').onclick = () => renderVideoPanel(true)
    return
  }

  const platformLabel = _site === 'instagram' ? 'Instagram' : 'YouTube'
  const platformSvg = _site === 'instagram'
    ? '<svg viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M23.495 6.205a3.007 3.007 0 0 0-2.088-2.088c-1.87-.501-9.396-.501-9.396-.501s-7.507-.01-9.396.501A3.007 3.007 0 0 0 .527 6.205a31.247 31.247 0 0 0-.522 5.805 31.247 31.247 0 0 0 .522 5.783 3.007 3.007 0 0 0 2.088 2.088c1.868.502 9.396.502 9.396.502s7.506 0 9.396-.502a3.007 3.007 0 0 0 2.088-2.088 31.247 31.247 0 0 0 .5-5.783 31.247 31.247 0 0 0-.5-5.805zM9.609 15.601V8.408l6.264 3.602z"/></svg>';
  panel.innerHTML = `
    <div class="save-form">
      <div class="form-row">
        <span class="platform-badge ${_site}">${platformSvg} ${platformLabel}</span>
        <span class="video-id" title="${_videoId}">${_videoId}</span>
        <span class="ts-badge">
          <svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm.5 5v5.3l4.5 2.7-.8 1.2-5.2-3V7h1.5z"/></svg>
          ${fmt(_timestamp)}
        </span>
      </div>
      <textarea class="note-input" id="noteInput" rows="2"
        placeholder="Add a note\u2026 (optional)" maxlength="250">${saved?.notes || ''}</textarea>
      <div class="tags-row" id="tagsRow"></div>
      <button class="save-btn" id="saveBtn">
        <svg viewBox="0 0 24 24"><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>
        ${saved ? 'Update Bookmark' : 'Save Bookmark + Screenshot'}
      </button>
    </div>`

  const tw = tagWidget($('tagsRow'), saved?.tags || [])

  $('saveBtn').onclick = () => {
    const btn = $('saveBtn')
    btn.classList.add('saving'); btn.textContent = 'Saving…'
    chrome.runtime.sendMessage(
      { action: 'CAPTURE_AND_SAVE', extraData: { notes: $('noteInput').value.trim(), tags: tw.get() } },
      res => {
        if (res?.ok) toast(`🔖 Saved at ${fmt(res.timestamp)}`)
        else toast('Something went wrong', true)
        renderAll()
      }
    )
  }
}

// ── Bookmark list ─────────────────────────────────────────────────────────────
const renderList = async () => {
  const bm = await getBm()
  const list = $('bmList')
  const entries = Object.entries(bm).sort((a, b) => b[1].savedAt - a[1].savedAt)

  // Update count badge
  const countEl = $('listCount')
  if (countEl) countEl.textContent = entries.length

  if (!entries.length) {
    list.innerHTML = `<div class="empty-bm">No bookmarks yet — open a video to start</div>`
    return
  }

  list.innerHTML = entries.map(([id, b], i) => {
    const tagsHTML = b.tags?.length ? b.tags.map(t => `<span class="bm-tag">#${t}</span>`).join('') : ''
    const platform = b.site || 'youtube'
    const platformBadge = `<span class="bm-platform ${platform}">${platform === 'instagram' ? 'IG' : 'YT'}</span>`
    const syncedDot = b.synced ? `<span class="bm-synced-dot" title="Synced"></span>` : ''
    const thumb = b.screenshot
      ? `<div class="bm-thumb">${platformBadge}${syncedDot}<img src="${b.screenshot}"/><div class="bm-ts-badge">${fmt(b.timestamp)}</div></div>`
      : `<div class="bm-thumb">${platformBadge}<div class="bm-thumb-empty"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div><div class="bm-ts-badge">${fmt(b.timestamp)}</div></div>`
    const isEditing = _editingId === id
    const isCurrent = id === _videoId
    const currentIndicator = isCurrent ? `<span class="bm-current-indicator"></span>` : ''
    return `
    <div class="bm-item${isEditing ? ' editing' : ''}${isCurrent ? ' is-current' : ''}" data-id="${id}" style="animation-delay:${i * 0.04}s">
      ${thumb}
      <div class="bm-body">
        <div class="bm-id${isCurrent ? ' current' : ''}">${currentIndicator}${id}</div>
        <div class="bm-ago">${ago(b.savedAt)}</div>
        ${tagsHTML ? `<div class="bm-tags-row">${tagsHTML}</div>` : ''}
        ${b.notes ? `<div class="bm-note-preview">${b.notes}</div>` : ''}
      </div>
      <div class="bm-actions">
        <button class="bm-btn edit-btn" data-id="${id}" title="Edit">
          <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
        </button>
        <button class="bm-btn del bm-del" data-id="${id}" title="Delete">
          <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </div>
    </div>`
  }).join('')

  // Open video on click (body area)
  list.querySelectorAll('.bm-item').forEach(el => {
    el.querySelector('.bm-body').addEventListener('click', () => {
      const id = el.dataset.id
      const b = bm[id]
      if (b && !_editingId) {
        chrome.runtime.sendMessage({ action: 'OPEN_VIDEO', videoId: id, site: b.site, timestamp: b.timestamp })
        window.close()
      }
    })
    // Thumbnail click also opens
    el.querySelector('.bm-thumb').addEventListener('click', () => {
      const id = el.dataset.id
      const b = bm[id]
      if (b && !_editingId) {
        chrome.runtime.sendMessage({ action: 'OPEN_VIDEO', videoId: id, site: b.site, timestamp: b.timestamp })
        window.close()
      }
    })
  })

  // Edit → open top panel
  list.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const id = btn.dataset.id
      if (_editingId === id) {
        // Clicking edit again while already editing this one → close
        closeEditPanel()
      } else {
        openEditPanel(id)
      }
    })
  })

  // Delete
  list.querySelectorAll('.bm-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      const id = btn.dataset.id
      if (_editingId === id) closeEditPanel()
      const all = await getBm()
      delete all[id]
      await setBm(all)
      toast('Removed')
      renderAll()
      // Also remove from cloud in background (fire-and-forget)
      chrome.runtime.sendMessage({ action: 'DELETE_BOOKMARK_CLOUD', videoId: id })
    })
  })
}

// ── Premium Limit Check ───────────────────────────────────────────────────────
const checkPremiumStatus = () => {
  const banner = $('limitBanner')
  if (!banner) return

  chrome.runtime.sendMessage({ action: 'GET_PREMIUM_STATUS' }, res => {
    if (res?.ok && res.data) {
      const data = res.data
      const isLimitReached = !data.isPremium && data.bookmarkCount >= data.limit
      if (isLimitReached) {
        banner.style.display = 'flex'
        const bannerText = banner.querySelector('.limit-banner-content span')
        if (bannerText) {
          bannerText.textContent = `Cloud Sync Limit Reached (${data.bookmarkCount}/${data.limit})`
        }
      } else {
        banner.style.display = 'none'
      }
      renderAuth() // update auth pill dot color/title if plan changed in local storage
    } else {
      banner.style.display = 'none'
    }
  })
}

// Hook upgrade button
const upgradeBtn = $('limitUpgradeBtn')
if (upgradeBtn) {
  upgradeBtn.onclick = () => {
    chrome.runtime.sendMessage({ action: 'OPEN_DASHBOARD' })
    window.close()
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
const triggerSyncIfUnsynced = async () => {
  const { token } = await getAuth()
  if (!token) return

  const bm = await getBm()
  const hasUnsynced = Object.values(bm).some(b => !b.synced)
  if (hasUnsynced) {
    chrome.runtime.sendMessage({ action: 'TRIGGER_SYNC' }, () => {
      // Re-render list once sync complete to show updated screenshot URLs
      setTimeout(renderList, 1000)
    })
  }
}

const renderAll = () => {
  renderAuth()
  renderVideoPanel()
  renderList()
  checkPremiumStatus()
  triggerSyncIfUnsynced()
}

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab?.url) { renderAll(); return }
  const ig = tab.url.match(/instagram\.com\/reels?\/([^/?#]+)/)
  const yt = tab.url.match(/youtube\.com\/watch[^#]*[?&]v=([^&#]+)/)
  const ys = tab.url.match(/youtube\.com\/shorts\/([^/?#]+)/)
  _videoId = ig?.[1] || yt?.[1] || ys?.[1] || null
  _site = ig ? 'instagram' : 'youtube'
  if (_videoId) {
    chrome.tabs.sendMessage(tab.id, { action: 'GET_VIDEO_INFO' }, resp => {
      if (!chrome.runtime.lastError && resp) _timestamp = resp.timestamp || 0
      renderAll()
    })
  } else {
    renderAll()
  }
})

// ── Confirm overlay helpers ────────────────────────────────────────────────────
const showConfirm = () => $('confirmOverlay').classList.add('show')
const hideConfirm = () => $('confirmOverlay').classList.remove('show')

$('clearAll').onclick = () => showConfirm()

$('confirmCancel').onclick = () => hideConfirm()

// Clicking the dark backdrop dismisses
$('confirmOverlay').addEventListener('click', e => {
  if (e.target === $('confirmOverlay')) hideConfirm()
})

$('confirmDelete').onclick = async () => {
  hideConfirm()
  if (_editingId) closeEditPanel()
  // Clear locally immediately for instant UI response
  await setBm({})
  toast('Cleared')
  renderAll()
  // Also clear from cloud in background (fire-and-forget)
  chrome.runtime.sendMessage({ action: 'CLEAR_ALL_CLOUD' })
}
$('dashBtn').onclick = () => {
  chrome.runtime.sendMessage({ action: 'OPEN_DASHBOARD' })
  window.close()
}