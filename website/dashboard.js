;(() => {
  // ── state ──────────────────────────────────────────────────────────────────
  let summary = null
  let currentTab = 'overview'
  let hasLicense = false

  // ── helpers ────────────────────────────────────────────────────────────────
  const byId = (id) => document.getElementById(id)

  function fmtDate(v) {
    if (!v) return '—'
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
  }

  function fmtRemaining(v) {
    if (!v) return '—'
    const ms = Date.parse(v) - Date.now()
    if (!Number.isFinite(ms) || ms <= 0) return 'Expired'
    const d = Math.floor(ms / 86400000)
    const h = Math.floor((ms % 86400000) / 3600000)
    return `${d}d ${h}h`
  }

  function mask(v, fb = '—') { return String(v || '').trim() || fb }

  function setStatus(text) {
    const el = byId('action-status')
    if (el) el.textContent = text
  }

  // ── API ────────────────────────────────────────────────────────────────────
  async function apiFetch(url, opts = {}) {
    const r = await fetch(url, { credentials: 'include', ...opts })
    const data = await r.json().catch(() => ({}))
    if (!r.ok || data?.ok === false) throw Object.assign(new Error(data?.error || 'Request failed'), { status: r.status })
    return data
  }

  function postJson(url, body) {
    return apiFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
  }

  // ── auth state ─────────────────────────────────────────────────────────────
  function setAuthState(authenticated, licenseActive) {
    hasLicense = !!licenseActive
    const dot = byId('auth-dot')
    const label = byId('auth-status-label')
    const badge = byId('user-plan-badge')
    const loginPrompt = byId('login-prompt')

    if (dot) {
      dot.classList.toggle('inactive', !authenticated)
      dot.classList.toggle('active', authenticated)
    }
    if (label) {
      label.textContent = authenticated ? 'Authenticated' : 'Not authenticated'
      label.style.color = authenticated ? 'var(--a4, #c084fc)' : 'var(--t2)'
    }
    if (badge) {
      badge.classList.toggle('inactive', !hasLicense)
      if (hasLicense && summary?.plan) {
        badge.textContent = summary.plan
      } else {
        badge.textContent = authenticated ? 'No license' : '—'
      }
    }
    if (loginPrompt) loginPrompt.style.display = authenticated ? 'none' : 'block'

    // show/hide nav items that require a license
    document.querySelectorAll('[data-requires-license]').forEach((el) => {
      el.style.display = hasLicense ? '' : 'none'
    })

    // show/hide the no-license banner on overview
    const banner = byId('no-license-banner')
    if (banner) banner.style.display = authenticated && !hasLicense ? 'block' : 'none'
  }

  // ── tab navigation ─────────────────────────────────────────────────────────
  function switchTab(tab) {
    if (tab === 'affiliate' && !hasLicense) return
    currentTab = tab
    document.querySelectorAll('.dash-nav-item').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.tab === tab)
    })
    document.querySelectorAll('.dash-panel').forEach((panel) => {
      panel.classList.toggle('vis', panel.id === `panel-${tab}`)
    })
    if (tab === 'affiliate') loadAffiliate()
    if (tab === 'downloads') loadDownloads()
  }

  function setupTabs() {
    document.querySelectorAll('.dash-nav-item[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab))
    })
  }

  // ── apply user data ────────────────────────────────────────────────────────
  function applyUser(user) {
    const name = mask(user.globalName || user.username, 'Unknown')
    const email = mask(user.email, '')
    const avatar = user.avatarUrl || '/favicon.png'
    if (byId('user-name')) byId('user-name').textContent = name
    if (byId('user-email')) byId('user-email').textContent = email
    if (byId('user-avatar')) byId('user-avatar').src = avatar
    if (byId('actions-username')) byId('actions-username').textContent = name
    if (byId('actions-avatar')) byId('actions-avatar').src = avatar
  }

  function applyLicense(data) {
    summary = data?.summary || null
    const s = summary || {}

    // overview stats
    if (byId('hl-plan')) byId('hl-plan').textContent = mask(s.plan)
    if (byId('hl-status')) byId('hl-status').textContent = mask(s.status)
    if (byId('hl-remaining')) byId('hl-remaining').textContent = fmtRemaining(s.expiresAt)
    if (byId('hl-hwid')) byId('hl-hwid').textContent = mask(s.hwid, 'Unbound')

    // overview license card
    if (byId('ov-key')) byId('ov-key').textContent = mask(s.keyMasked, 'No license linked')
    if (byId('ov-plan')) byId('ov-plan').textContent = mask(s.plan)
    if (byId('ov-status')) byId('ov-status').textContent = mask(s.status)
    if (byId('ov-hwid')) byId('ov-hwid').textContent = mask(s.hwid, 'Unbound')

    // license tab
    if (byId('lic-key')) byId('lic-key').textContent = mask(s.keyMasked, '—')
    if (byId('lic-status')) byId('lic-status').textContent = mask(s.status)
    if (byId('lic-hwid')) byId('lic-hwid').textContent = mask(s.hwid, 'Unbound')
    if (byId('lic-exp')) byId('lic-exp').textContent = fmtDate(s.expiresAt)

    // subscription tab
    if (byId('sub-plan')) byId('sub-plan').textContent = mask(s.plan)
    if (byId('sub-next')) byId('sub-next').textContent = fmtDate(s.nextBillingDate)
    if (byId('sub-remaining')) byId('sub-remaining').textContent = fmtRemaining(s.expiresAt)

    const isMonthly = s.plan === 'monthly'
    const isLifetime = s.plan === 'lifetime'
    const notExpired = !s.expiresAt || Date.parse(s.expiresAt) > Date.now()

    if (byId('sub-monthly-only')) byId('sub-monthly-only').style.display = isMonthly ? 'block' : 'none'
    if (byId('sub-lifetime-only')) byId('sub-lifetime-only').style.display = isLifetime ? 'block' : 'none'
    if (byId('sub-cancel-card')) byId('sub-cancel-card').style.display = isMonthly && notExpired ? 'block' : 'none'

    // claim-legacy card on license tab — show if no license
    if (byId('claim-legacy-card')) byId('claim-legacy-card').style.display = summary ? 'none' : 'block'
  }

  function applyLicenseList(items) {
    const wrap = byId('license-list')
    if (!wrap) return
    if (!items.length) {
      wrap.innerHTML = '<div class="lic-row"><div><strong>No licenses found</strong><small>This account has no linked keys yet.</small></div></div>'
      return
    }
    wrap.innerHTML = items.slice(0, 10).map((item) => `
      <div class="lic-row">
        <div>
          <strong class="mono">${item.keyMasked || '—'}</strong>
          <small>${item.plan || '—'} | ${item.status || '—'}</small>
        </div>
        <small>${item.expiresAt ? new Date(item.expiresAt).toLocaleDateString() : 'Never'}</small>
      </div>
    `).join('')
  }

  // ── claim legacy key ───────────────────────────────────────────────────────
  async function submitClaim(inputEl, statusEl) {
    const key = (inputEl?.value || '').trim()
    if (!key) { if (statusEl) statusEl.textContent = 'Enter your key first.'; return }
    if (statusEl) statusEl.textContent = 'Linking…'
    try {
      const data = await postJson('/api/dashboard/claim-legacy', { key })
      if (statusEl) statusEl.textContent = data.message || 'Key linked!'
      setTimeout(() => location.reload(), 1200)
    } catch (err) {
      if (statusEl) statusEl.textContent = err.message || 'Could not link key.'
    }
  }

  function setupClaimFlow() {
    const claimBtn = byId('no-lic-claim-btn')
    const claimForm = byId('no-lic-claim-form')
    if (claimBtn && claimForm) {
      claimBtn.addEventListener('click', () => {
        claimForm.style.display = claimForm.style.display === 'none' ? 'block' : 'none'
      })
    }
    const noLicSubmit = byId('no-lic-claim-submit')
    if (noLicSubmit) noLicSubmit.addEventListener('click', () => submitClaim(byId('no-lic-key-input'), byId('no-lic-claim-status')))

    const legacyBtn = byId('claim-legacy-btn')
    if (legacyBtn) legacyBtn.addEventListener('click', () => submitClaim(byId('claim-key-input'), byId('claim-status-msg')))
  }

  // ── actions ────────────────────────────────────────────────────────────────
  function setupActions() {
    // copy key
    const copyHandler = async () => {
      try {
        if (!summary?.keyFull) return setStatus('No key to copy.')
        await navigator.clipboard.writeText(summary.keyFull)
        setStatus('Key copied.')
      } catch { setStatus('Could not copy.') }
    }
    ;[byId('copy-key-btn'), byId('copy-key-btn-2'), byId('qact-copy')].forEach((el) => el?.addEventListener('click', copyHandler))

    // reveal key
    const revealHandler = () => {
      if (!summary?.keyFull) return setStatus('No key to reveal.')
      if (byId('ov-key')) byId('ov-key').textContent = summary.keyFull
      if (byId('lic-key')) byId('lic-key').textContent = summary.keyFull
      setStatus('Key revealed.')
    }
    ;[byId('reveal-key-btn'), byId('reveal-key-btn-2')].forEach((el) => el?.addEventListener('click', revealHandler))

    // reset HWID
    const resetHandler = async () => {
      try {
        if (!summary?.keyFull) return setStatus('No key found.')
        await postJson('/api/dashboard/reset-hwid', { key: summary.keyFull })
        setStatus('HWID reset.')
        const me = await apiFetch('/api/dashboard/me')
        applyLicense(me)
      } catch (err) { setStatus(err.message) }
    }
    ;[byId('qact-hwid')].forEach((el) => el?.addEventListener('click', resetHandler))

    // cancel subscription
    const cancelBtn = byId('cancel-btn')
    const cancelModal = byId('cancel-modal')
    const cancelNo = byId('cancel-modal-no')
    const cancelYes = byId('cancel-modal-yes')
    if (cancelBtn && cancelModal) {
      cancelBtn.addEventListener('click', () => {
        cancelModal.style.opacity = '1'
        cancelModal.style.pointerEvents = 'auto'
      })
    }
    if (cancelNo) cancelNo.addEventListener('click', () => {
      if (cancelModal) { cancelModal.style.opacity = '0'; cancelModal.style.pointerEvents = 'none' }
    })
    if (cancelYes) cancelYes.addEventListener('click', async () => {
      try {
        const data = await postJson('/api/dashboard/cancel-subscription', {})
        if (data?.url) { window.location.href = data.url; return }
        const statusEl = byId('sub-status-msg')
        if (statusEl) statusEl.textContent = 'Cancellation submitted.'
        if (cancelModal) { cancelModal.style.opacity = '0'; cancelModal.style.pointerEvents = 'none' }
      } catch (err) {
        const statusEl = byId('sub-status-msg')
        if (statusEl) statusEl.textContent = err.message
      }
    })

    // upgrade buttons
    const upgradeMonthly = byId('upgrade-monthly-btn')
    const upgradeLifetime = byId('upgrade-lifetime-btn')
    if (upgradeMonthly) upgradeMonthly.addEventListener('click', () => { window.location.href = '/api/create-checkout?plan=monthly' })
    if (upgradeLifetime) upgradeLifetime.addEventListener('click', () => { window.location.href = '/api/create-checkout?plan=lifetime' })

    // affiliate quick action — requires an active license
    const qactAff = byId('qact-affiliate')
    if (qactAff) qactAff.addEventListener('click', () => {
      if (!hasLicense) {
        switchTab('overview')
        const banner = byId('no-license-banner')
        if (banner) {
          banner.scrollIntoView({ behavior: 'smooth', block: 'center' })
          banner.style.outline = '2px solid rgba(167,139,250,0.6)'
          setTimeout(() => { banner.style.outline = '' }, 2000)
        }
        return
      }
      switchTab('affiliate')
    })

    // discord support
    const qactDiscord = byId('qact-discord')
    if (qactDiscord) qactDiscord.addEventListener('click', () => { window.open('https://discord.gg/zenithmacros', '_blank') })

    // logout
    const logoutHandler = async () => {
      try { await postJson('/api/dashboard/logout', {}) } catch (_) {}
      location.href = '/dashboard.html'
    }
    ;[byId('logout-btn'), byId('logout-btn-nav')].forEach((el) => el?.addEventListener('click', logoutHandler))
  }

  // ── affiliate ──────────────────────────────────────────────────────────────
  async function loadAffiliate() {
    try {
      const data = await apiFetch('/api/affiliate/me')
      const createWrap = byId('aff-create-wrap')
      const dashWrap = byId('aff-dashboard-wrap')

      if (data?.code) {
        if (createWrap) createWrap.style.display = 'none'
        if (dashWrap) dashWrap.style.display = 'block'

        if (byId('aff-sales')) byId('aff-sales').textContent = data.total_sales ?? '0'
        if (byId('aff-earned')) byId('aff-earned').textContent = `$${((data.total_commission_cents || 0) / 100).toFixed(2)}`
        if (byId('aff-available')) byId('aff-available').textContent = `$${((data.available_cents || 0) / 100).toFixed(2)}`
        if (byId('aff-gross')) byId('aff-gross').textContent = `$${((data.gross_revenue_cents || 0) / 100).toFixed(2)}`
        if (byId('aff-pending')) byId('aff-pending').textContent = `$${((data.pending_cashouts_cents || 0) / 100).toFixed(2)}`
        if (byId('aff-code-stat')) byId('aff-code-stat').textContent = data.code || '—'

        const linkQ = byId('aff-link-q')
        const linkP = byId('aff-link-p')
        if (linkQ) { linkQ.href = `/?ref=${data.code}`; linkQ.textContent = `zenithmacros.store/?ref=${data.code}` }
        if (linkP) { linkP.href = `/pricing?ref=${data.code}`; linkP.textContent = `zenithmacros.store/pricing?ref=${data.code}` }
      } else {
        if (createWrap) createWrap.style.display = 'block'
        if (dashWrap) dashWrap.style.display = 'none'
      }
    } catch (_) {}

    const createBtn = byId('aff-create-btn')
    if (createBtn && !createBtn._bound) {
      createBtn._bound = true
      createBtn.addEventListener('click', async () => {
        const statusEl = byId('aff-create-status')
        try {
          if (statusEl) statusEl.textContent = 'Creating…'
          await postJson('/api/affiliate/create', {})
          if (statusEl) statusEl.textContent = 'Affiliate account created!'
          setTimeout(() => loadAffiliate(), 800)
        } catch (err) {
          if (statusEl) statusEl.textContent = err.message
        }
      })
    }

    const cashoutBtn = byId('aff-cashout-btn')
    if (cashoutBtn && !cashoutBtn._bound) {
      cashoutBtn._bound = true
      cashoutBtn.addEventListener('click', async () => {
        const statusEl = byId('aff-cashout-status')
        const amountEl = byId('aff-cashout-amount')
        const amount = parseFloat(amountEl?.value || '0')
        if (!amount || amount < 15) { if (statusEl) statusEl.textContent = 'Minimum cashout is $15.'; return }
        try {
          if (statusEl) statusEl.textContent = 'Requesting…'
          await postJson('/api/affiliate/cashout', { amount_cents: Math.round(amount * 100) })
          if (statusEl) statusEl.textContent = 'Cashout requested!'
        } catch (err) {
          if (statusEl) statusEl.textContent = err.message
        }
      })
    }
  }

  // ── downloads ──────────────────────────────────────────────────────────────
  async function loadDownloads() {
    const loading = byId('dl-loading')
    const error   = byId('dl-error')
    const none    = byId('dl-none')
    const list    = byId('dl-list')
    if (loading) loading.style.display = 'flex'
    if (error)   error.style.display   = 'none'
    if (none)    none.style.display    = 'none'
    if (list)    list.style.display    = 'none'

    try {
      const data = await apiFetch('/api/dashboard/download-latest')
      if (loading) loading.style.display = 'none'
      if (!data?.url) { if (none) none.style.display = 'block'; return }

      // Format file size
      function fmtSize(bytes) {
        if (!bytes) return ''
        if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
        return (bytes / 1024).toFixed(0) + ' KB'
      }

      // Format date
      function fmtDate(iso) {
        if (!iso) return ''
        try {
          return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        } catch { return '' }
      }

      // Parse changelog lines — strip markdown headers/bullets into clean lines
      function renderNotes(raw) {
        if (!raw) return ''
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
        return lines.map(line => {
          const clean = line.replace(/^#{1,3}\s*/, '').replace(/^\*+\s*/, '• ').replace(/^-\s*/, '• ')
          const isHeader = /^#{1,3}\s/.test(line)
          if (isHeader) return `<div style="font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:rgba(167,139,250,.6);margin-top:10px;margin-bottom:4px">${clean.replace(/^•\s*/, '')}</div>`
          return `<div style="display:flex;align-items:flex-start;gap:7px;font-size:13px;color:var(--t2);line-height:1.55;padding:1px 0">${clean.startsWith('•') ? `<span style="color:#7c3aed;flex-shrink:0;margin-top:2px">●</span><span>${clean.slice(2)}</span>` : `<span>${clean}</span>`}</div>`
        }).join('')
      }

      const ver       = data.version || 'v?.?.?'
      const name      = data.releaseName && data.releaseName !== ver ? data.releaseName : `Zenith Macros ${ver}`
      const dateStr   = fmtDate(data.publishedAt)
      const sizeStr   = fmtSize(data.size)
      const notes     = renderNotes(data.releaseNotes)

      if (list) {
        list.style.display = 'flex'
        list.innerHTML = `
          <!-- Release header card -->
          <div style="background:rgba(124,58,237,.06);border:1px solid rgba(124,58,237,.2);border-radius:16px;padding:28px 28px 24px;position:relative;overflow:hidden">
            <div style="position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,rgba(167,139,250,.8),transparent)"></div>

            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">
              <div>
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                  <span style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.05em;background:rgba(124,58,237,.15);border:1px solid rgba(124,58,237,.3);color:#c4b5fd">
                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" width="10" height="10"><circle cx="6" cy="6" r="4.5"/><path d="M6 3v3l2 1"/></svg>
                    LATEST
                  </span>
                  <span style="font-size:13px;font-weight:700;color:var(--t1);letter-spacing:-.2px">${ver}</span>
                </div>
                <div style="font-size:20px;font-weight:700;letter-spacing:-.4px;color:var(--t1);margin-bottom:5px">${name}</div>
                ${dateStr ? `<div style="font-size:12px;color:var(--t3);display:flex;align-items:center;gap:5px"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12"><rect x="1" y="2" width="12" height="11" rx="2"/><path d="M4 1v2M10 1v2M1 6h12"/></svg>${dateStr}</div>` : ''}
              </div>

              <!-- Download button -->
              <a href="${data.url}" style="display:inline-flex;align-items:center;gap:8px;padding:12px 22px;border-radius:12px;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;font-size:14px;font-weight:700;text-decoration:none;white-space:nowrap;box-shadow:0 4px 18px rgba(124,58,237,.35);transition:opacity .15s,transform .15s;flex-shrink:0"
                onmouseover="this.style.opacity='.88';this.style.transform='translateY(-1px)'" onmouseout="this.style.opacity='1';this.style.transform='none'">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M8 2v8M5 7l3 3 3-3"/><path d="M2 12v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1"/></svg>
                Download
              </a>
            </div>

            <!-- File info row -->
            <div style="margin-top:18px;padding-top:16px;border-top:1px solid rgba(255,255,255,.06);display:flex;align-items:center;gap:20px;flex-wrap:wrap">
              <div style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--t2)">
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><path d="M8 1H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z"/><path d="M8 1v4h4"/></svg>
                <span style="font-weight:600;color:var(--t1)">${data.assetName || 'ZenithMacros.exe'}</span>
              </div>
              ${sizeStr ? `<div style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--t3)"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12"><circle cx="7" cy="7" r="6"/><path d="M5 7h4M7 5v4"/></svg>${sizeStr}</div>` : ''}
              <div style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--t3)">
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12"><path d="M7 1L8.6 4.3 12.3 4.9 9.7 7.4 10.3 11 7 9.3 3.7 11 4.3 7.4 1.7 4.9 5.4 4.3z"/></svg>
                Windows 64-bit
              </div>
            </div>
          </div>

          ${notes ? `
          <!-- Changelog -->
          <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:22px 24px">
            <div style="font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--t3);margin-bottom:14px;display:flex;align-items:center;gap:7px">
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><path d="M1 2h12M1 5h8M1 8h10M1 11h6"/></svg>
              What's new
            </div>
            <div style="display:flex;flex-direction:column;gap:2px">${notes}</div>
          </div>` : ''}
        `
      }
    } catch (err) {
      if (loading) loading.style.display = 'none'
      if (error) {
        error.style.display = 'block'
        const msg = byId('dl-error-msg')
        if (msg) msg.textContent = err.message || 'Could not load download.'
      }
    }
  }

  // ── init ───────────────────────────────────────────────────────────────────
  async function init() {
    setupTabs()
    setupActions()
    setupClaimFlow()

    const authFlag = new URLSearchParams(location.search).get('auth')

    try {
      const me = await apiFetch('/api/dashboard/me')
      applyUser(me.user || {})
      applyLicense(me)
      setAuthState(true, !!me.summary)

      if (authFlag === 'ok') setStatus('Discord connected successfully.')

      const licenses = await apiFetch('/api/dashboard/licenses').catch(() => ({ items: [] }))
      applyLicenseList(licenses.items || [])

    } catch (err) {
      setAuthState(false, false)
      applyLicense({})
      if (byId('ov-key')) byId('ov-key').textContent = '—'

      if (authFlag === 'declined') setStatus('Discord login was declined.')
      else if (authFlag === 'failed') setStatus('Discord login failed. Please try again.')
      else if (err?.status === 401) setStatus('Session expired. Please log in again.')
      else setStatus(err?.message || 'Could not load dashboard.')
    }

    if (authFlag) history.replaceState({}, '', '/dashboard.html')
  }

  init()
})()
