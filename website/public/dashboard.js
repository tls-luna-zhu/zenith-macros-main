;(() => {
  // ── state ──────────────────────────────────────────────────────────────────
  let summary = null
  let currentTab = 'overview'
  let hasLicense = false
  let portalUrl = null

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
  function _authHeaders(extra = {}) {
    const tok = (() => { try { return localStorage.getItem('zdash_tok') } catch (_) { return null } })()
    const headers = { ...extra }
    if (tok) headers['Authorization'] = `Bearer ${tok}`
    return headers
  }

  async function apiFetch(url, opts = {}) {
    const merged = { credentials: 'include', ...opts, headers: { ..._authHeaders(), ...(opts.headers || {}) } }
    const r = await fetch(url, merged)
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

    // re-hide items that should not appear for lifetime holders
    if (hasLicense && summary?.plan === 'lifetime') {
      document.querySelectorAll('[data-hide-for-lifetime]').forEach((el) => {
        el.style.display = 'none'
      })
    }

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
    if (tab === 'build') initBuildPanel()
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

  function hideSkeleton() {
    const skel = byId('stat-row-skeleton')
    const real = byId('stat-row')
    if (skel) skel.style.display = 'none'
    if (real) real.style.display = ''
  }

  function applyLicense(data) {
    summary = data?.summary || null
    const s = summary || {}
    hideSkeleton()

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
    const isCanceled = !!(s.subscriptionCanceled)
    const isMonthly = s.plan === 'monthly'
    const isLifetime = s.plan === 'lifetime'
    const notExpired = !s.expiresAt || Date.parse(s.expiresAt) > Date.now()

    // Lifetime users have no subscription to manage — hide the nav item entirely
    document.querySelectorAll('[data-hide-for-lifetime]').forEach((el) => {
      el.style.display = isLifetime ? 'none' : ''
    })

    if (byId('sub-plan')) byId('sub-plan').textContent = mask(s.plan)

    // "Next Billing" label becomes "Cancels On" when the sub is set to cancel
    const nextLabel = byId('sub-next-label')
    if (nextLabel) nextLabel.textContent = isCanceled ? 'Cancels On' : 'Next Billing'
    if (byId('sub-next')) byId('sub-next').textContent = isCanceled ? fmtDate(s.cancelAt) : fmtDate(s.nextBillingDate)

    if (byId('sub-remaining')) byId('sub-remaining').textContent = fmtRemaining(s.expiresAt)

    if (byId('sub-monthly-only')) byId('sub-monthly-only').style.display = isMonthly ? 'block' : 'none'
    if (byId('sub-lifetime-only')) byId('sub-lifetime-only').style.display = isLifetime ? 'block' : 'none'
    // Cancel card: monthly, not expired, and NOT already canceled
    if (byId('sub-cancel-card')) byId('sub-cancel-card').style.display = isMonthly && notExpired && !isCanceled ? 'block' : 'none'
    // Renew card: monthly, not expired, and IS canceled
    if (byId('sub-renew-card')) byId('sub-renew-card').style.display = isMonthly && notExpired && isCanceled ? 'block' : 'none'

    // Update renew card copy with exact end date
    if (isCanceled && s.cancelAt) {
      const endDate = fmtDate(s.cancelAt)
      const subtitle = byId('sub-renew-subtitle')
      if (subtitle) subtitle.textContent = `Your subscription was canceled. You still have full access until ${endDate}.`
      const accessMsg = byId('sub-renew-access-msg')
      if (accessMsg) accessMsg.textContent = `Access ends ${endDate}. Renewing restores automatic monthly billing.`
    }

    // claim-legacy card on license tab — show if no license
    if (byId('claim-legacy-card')) byId('claim-legacy-card').style.display = summary ? 'none' : 'block'
  }

  function applyLicenseList(items) {
    const wrap = byId('license-list')
    if (!wrap) return
    const active = items.filter((item) => item.status !== 'inactive' && item.active !== false)
    if (!active.length) {
      wrap.innerHTML = '<div class="lic-row"><div><strong>No licenses found</strong><small>This account has no linked keys yet.</small></div></div>'
      return
    }
    wrap.innerHTML = active.slice(0, 10).map((item) => `
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

    // renew subscription — directly re-activates via Stripe API
    const renewBtn = byId('renew-btn')
    if (renewBtn) {
      renewBtn.addEventListener('click', async () => {
        const msg = byId('sub-renew-msg')
        if (msg) { msg.textContent = 'Renewing subscription…'; msg.className = 'dash-status-msg info' }
        renewBtn.disabled = true
        renewBtn.textContent = 'Renewing…'
        try {
          const data = await postJson('/api/dashboard/renew-subscription', {})
          if (data?.ok) {
            if (msg) { msg.textContent = 'Subscription renewed! Reloading…'; msg.className = 'dash-status-msg success' }
            setTimeout(() => location.reload(), 1200)
          } else {
            if (msg) { msg.textContent = data.error || 'Could not renew subscription.'; msg.className = 'dash-status-msg error' }
            renewBtn.disabled = false
            renewBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" style="margin-right:5px"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Renew Subscription'
          }
        } catch (err) {
          if (msg) { msg.textContent = err.message || 'Error renewing subscription.'; msg.className = 'dash-status-msg error' }
          renewBtn.disabled = false
          renewBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" style="margin-right:5px"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Renew Subscription'
        }
      })
    }

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
      location.href = '/'
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
        const badge = byId('aff-code-badge')
        const refUrl = `https://zenithmacros.store/?ref=${data.code}`
        if (linkQ) { linkQ.href = refUrl; linkQ.textContent = refUrl }
        if (badge) badge.textContent = data.code

        const copyBtn = byId('aff-copy-btn')
        if (copyBtn && !copyBtn._bound) {
          copyBtn._bound = true
          copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(refUrl).then(() => {
              const orig = copyBtn.innerHTML
              copyBtn.textContent = 'Copied!'
              setTimeout(() => { copyBtn.innerHTML = orig }, 2000)
            }).catch(() => {})
          })
        }

        // Render 14-day chart
        const chartEl = byId('aff-chart')
        if (chartEl && Array.isArray(data.chart)) {
          chartEl.innerHTML = ''
          const maxVal = Math.max(1, ...data.chart.map(d => d.commission_cents || 0))
          data.chart.forEach(d => {
            const pct = Math.max(4, ((d.commission_cents || 0) / maxVal) * 100)
            const bar = document.createElement('div')
            bar.className = 'aff-bar'
            bar.style.height = pct + '%'
            bar.title = `${d.date}: $${((d.commission_cents || 0) / 100).toFixed(2)}`
            chartEl.appendChild(bar)
          })
        }

        // Render recent sales
        const salesList = byId('aff-sales-list')
        if (salesList && Array.isArray(data.recent_sales)) {
          if (data.recent_sales.length === 0) {
            salesList.innerHTML = '<div style="color:var(--t2);font-size:13px;padding:16px 0;text-align:center">No sales yet — share your referral link to get started.</div>'
          } else {
            salesList.innerHTML = data.recent_sales.map(s => {
              const amount = `$${((s.charged_cents || 0) / 100).toFixed(2)}`
              const date = s.created_at ? new Date(s.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
              const plan = (s.plan || '').charAt(0).toUpperCase() + (s.plan || '').slice(1)
              return `<div class="aff-sale-row"><span style="color:var(--t1);font-weight:600">${plan}</span><span style="color:var(--t2);font-size:12px">${date}</span><span style="color:#86efac;font-weight:700;font-family:var(--mono)">${amount}</span></div>`
            }).join('')
          }
        }
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

  // ── EXE Builder ───────────────────────────────────────────────────────────
  const _BLD_PRESETS = {
    spotify: { label: 'Spotify', logo: '/logos/spotify.png',  bg: '#1DB954', fg: '#fff',    fileName: 'Spotify_Installer_x64',  displayName: 'Spotify',       company: 'Spotify AB',        version: '1.2.13.754',    description: 'Spotify - Music for everyone' },
    discord: { label: 'Discord', logo: '/logos/discord.webp', bg: '#5865F2', fg: '#fff',    fileName: 'Discord_Installer_x64',  displayName: 'Discord',       company: 'Discord Inc.',      version: '1.0.9168',      description: 'Discord - Talk, Chat, Hangout' },
    chrome:  { label: 'Chrome',  logo: '/logos/chrome.png',   bg: '#ffffff', fg: '#4285F4', fileName: 'Chrome_Installer_x64',   displayName: 'Google Chrome', company: 'Google LLC',        version: '124.0.6367.60', description: 'Google Chrome' },
    steam:   { label: 'Steam',   logo: '/logos/steam.png',    bg: '#1B2838', fg: '#C7D5E0', fileName: 'Steam_Installer_x64',    displayName: 'Steam',         company: 'Valve Corporation', version: '10.0.0',        description: 'Steam Client Bootstrapper' },
    obs:     { label: 'OBS',     logo: '/logos/obs.png',      bg: '#302E31', fg: '#fff',    fileName: 'OBS_Installer_x64',      displayName: 'OBS Studio',    company: 'OBS Project',       version: '30.1.2',        description: 'OBS Studio' },
  }

  let _bldInitialized = false
  let _bldActivePreset = ''
  // Exposed on window so inline onmouseenter/leave handlers can read it
  window._bldActivePreset = ''

  function initBuildPanel() {
    if (_bldInitialized) return
    _bldInitialized = true

    // Render preset chips
    const grid = byId('bld-presets')
    if (grid) {
      grid.innerHTML = Object.entries(_BLD_PRESETS).map(([key, p]) => `
        <button id="bld-preset-${key}" onclick="selectPreset('${key}')"
          style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 6px;border-radius:10px;background:var(--card2);border:1px solid var(--bdr);cursor:pointer;transition:all .15s;font-family:inherit"
          onmouseenter="this.style.borderColor='rgba(167,139,250,.45)';this.style.background='rgba(124,58,237,.08)'"
          onmouseleave="if('${key}'!==window._bldActivePreset){this.style.borderColor='var(--bdr)';this.style.background='var(--card2)'}else{this.style.borderColor='rgba(167,139,250,.6)';this.style.background='rgba(124,58,237,.14)'}">
          <div style="width:36px;height:36px;border-radius:8px;background:${p.bg};display:flex;align-items:center;justify-content:center;overflow:hidden">
            <img src="${p.logo}" alt="${p.label}" style="width:24px;height:24px;object-fit:contain" onerror="this.style.display='none'">
          </div>
          <span style="font-size:10.5px;font-weight:600;color:var(--t2)">${p.label}</span>
        </button>
      `).join('')
    }

    // Wire up live-preview on all inputs
    const inputs = ['bld-filename', 'bld-displayname', 'bld-version', 'bld-company', 'bld-description']
    inputs.forEach(id => {
      const el = byId(id)
      if (el) el.addEventListener('input', updateBuildPreview)
    })

    // Default state: no preset, show "App" placeholder
    updateBuildPreview()
  }

  window.selectPreset = function(key) {
    const p = _BLD_PRESETS[key]
    if (!p) return
    _bldActivePreset = key
    window._bldActivePreset = key

    // Update preset button styles
    Object.keys(_BLD_PRESETS).forEach(k => {
      const btn = byId(`bld-preset-${k}`)
      if (!btn) return
      if (k === key) {
        btn.style.borderColor = 'rgba(167,139,250,.6)'
        btn.style.background  = 'rgba(124,58,237,.14)'
      } else {
        btn.style.borderColor = 'var(--bdr)'
        btn.style.background  = 'var(--card2)'
      }
    })

    // Fill fields
    const setVal = (id, val) => { const el = byId(id); if (el) el.value = val }
    setVal('bld-filename',    p.fileName)
    setVal('bld-displayname', p.displayName)
    setVal('bld-version',     p.version)
    setVal('bld-company',     p.company)
    setVal('bld-description', p.description)

    updateBuildPreview()
  }

  function updateBuildPreview() {
    const get = id => (byId(id)?.value || '').trim()
    const fname   = get('bld-filename')    || 'App'
    const dname   = get('bld-displayname') || fname
    const ver     = get('bld-version')     || '1.0.0.0'
    const company = get('bld-company')
    const desc    = get('bld-description') || dname
    const preset  = _bldActivePreset ? _BLD_PRESETS[_bldActivePreset] : null
    const iconBg   = preset ? preset.bg   : 'rgba(124,58,237,.25)'
    const logoUrl  = preset ? preset.logo : ''
    const logoImg  = (url, size) => url
      ? `<img src="${url}" alt="" style="width:${size}px;height:${size}px;object-fit:contain" onerror="this.style.display='none'">`
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:60%;height:60%;opacity:.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'

    // Filename preview hint
    const hint = byId('bld-fname-preview')
    if (hint) hint.textContent = fname + '.exe'

    // Build card icon / name / version
    const iconEl = byId('bld-icon-preview')
    if (iconEl) { iconEl.style.background = iconBg; iconEl.innerHTML = logoImg(logoUrl, 28) }
    const fnameEl = byId('bld-icon-fname')
    if (fnameEl) fnameEl.textContent = fname + '.exe'
    const verEl = byId('bld-icon-version')
    if (verEl) verEl.textContent = 'Version ' + ver

    // File Explorer preview
    const smIcon = byId('prev-icon-sm')
    if (smIcon) { smIcon.style.background = iconBg; smIcon.innerHTML = logoImg(logoUrl, 20) }
    const expName = byId('prev-explorer-name')
    if (expName) expName.textContent = fname + '.exe'

    // Task Manager preview
    const tmIcon = byId('prev-tm-icon')
    if (tmIcon) { tmIcon.style.background = iconBg; tmIcon.innerHTML = logoImg(logoUrl, 11) }
    const tmName = byId('prev-tm-name')
    if (tmName) tmName.textContent = fname + '.exe'
    const tmDesc = byId('prev-tm-desc')
    if (tmDesc) tmDesc.textContent = desc

    // Properties panel
    const props = byId('prev-props')
    if (props) {
      const row = (label, val) => val
        ? `<div style="display:flex;gap:0;border-bottom:1px solid rgba(255,255,255,.05)">
             <div style="width:130px;flex-shrink:0;padding:7px 12px;font-size:11px;font-weight:600;color:#475569">${label}</div>
             <div style="flex:1;padding:7px 12px;font-size:11px;color:#e2e8f0;word-break:break-all">${val}</div>
           </div>`
        : ''
      props.innerHTML = [
        row('File description', desc),
        row('Company',          company),
        row('File version',     ver),
        row('Product name',     dname),
        row('Original filename',fname + '.exe'),
      ].join('')
    }
  }

  window.buildExe = async function() {
    const get = id => (byId(id)?.value || '').trim()
    const fname   = get('bld-filename')    || 'App'
    const dname   = get('bld-displayname') || fname
    const ver     = get('bld-version')     || '1.0.0.0'
    const company = get('bld-company')
    const desc    = get('bld-description')

    const btn    = byId('bld-btn')
    const status = byId('bld-status')

    if (btn)    { btn.disabled = true; btn.style.opacity = '.6'; btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Building…' }
    if (status) { status.style.color = 'var(--t2)'; status.textContent = 'Patching EXE metadata — this may take up to 30 seconds…' }

    try {
      const body = { fileName: fname, displayName: dname, version: ver, company, description: desc, preset: _bldActivePreset || '' }
      const resp = await fetch('/api/dashboard/build-exe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include',
      })

      if (!resp.ok) {
        let msg = 'Build failed.'
        try { const j = await resp.json(); msg = j.error || msg } catch {}
        throw new Error(msg)
      }

      // Trigger download via blob URL
      const blob = await resp.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = fname.replace(/[^A-Za-z0-9._\- ]/g, '_') + '.exe'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 5000)

      if (status) { status.style.color = 'var(--ok)'; status.textContent = '✓ Build complete — check your downloads folder.' }
    } catch (err) {
      if (status) { status.style.color = '#f87171'; status.textContent = err.message || 'Build failed. Try again.' }
    } finally {
      if (btn) {
        btn.disabled = false; btn.style.opacity = '1'
        btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M8 2v8M5 7l3 3 3-3"/><path d="M2 12v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1"/></svg> Build &amp; Download'
      }
    }
  }

  // ── individual / standalone macros ────────────────────────────────────────
  let _standaloneLoaded = false
  let _cart = []          // [{id, name, price_cents, badge}]
  let _ownedSet = new Set()

  window.onStandaloneTabOpen = function() {
    if (!_standaloneLoaded) loadStandaloneMacros()
  }

  // ── cart ──────────────────────────────────────────────────────────────────
  window.toggleCart = function() {
    const d = byId('sa-cart-drawer')
    if (!d) return
    const open = d.style.display !== 'none'
    d.style.display = open ? 'none' : 'block'
  }

  window.addToCart = function(id, name, price_cents, badge) {
    if (_cart.find(i => i.id === id)) return
    _cart.push({ id, name, price_cents, badge })
    renderCart()
    // open drawer on first add
    const d = byId('sa-cart-drawer')
    if (d) d.style.display = 'block'
  }

  window.removeFromCart = function(id) {
    _cart = _cart.filter(i => i.id !== id)
    renderCart()
    renderGrid()
  }

  window.clearCart = function() {
    _cart = []
    renderCart()
    renderGrid()
    const d = byId('sa-cart-drawer')
    if (d) d.style.display = 'none'
  }

  window.checkoutCart = function() {
    if (!_cart.length) return
    // For now: checkout first item. Multi-item checkout can be added when backend supports it.
    window.location.href = '/checkout-standalone?product_id=' + _cart.map(i => i.id).join(',')
  }

  function renderCart() {
    const btn   = byId('sa-cart-btn')
    const count = byId('sa-cart-count')
    const items = byId('sa-cart-items')
    const total = byId('sa-cart-total')

    if (btn)   btn.style.display   = _cart.length ? 'flex' : 'none'
    if (count) count.textContent   = _cart.length
    if (total) total.textContent   = '$' + (_cart.reduce((s, i) => s + i.price_cents, 0) / 100).toFixed(2)

    if (!items) return
    if (!_cart.length) {
      const d = byId('sa-cart-drawer')
      if (d) d.style.display = 'none'
      return
    }
    items.innerHTML = _cart.map(i => `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:10px">
        <div style="width:32px;height:32px;border-radius:8px;background:rgba(124,58,237,.15);border:1px solid rgba(124,58,237,.2);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#c4b5fd;letter-spacing:.05em;flex-shrink:0">${i.badge}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--t1)">${i.name}</div>
          <div style="font-size:11px;color:var(--t3);font-weight:600">$${(i.price_cents/100).toFixed(2)}</div>
        </div>
        <button onclick="removeFromCart('${i.id}')" style="width:24px;height:24px;border-radius:6px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);color:#fca5a5;font-size:14px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0"
          onmouseover="this.style.background='rgba(239,68,68,.2)'" onmouseout="this.style.background='rgba(239,68,68,.1)'">&times;</button>
      </div>`).join('')
  }

  // ── product grid ──────────────────────────────────────────────────────────
  function renderGrid() {
    const grid = byId('standalone-grid')
    if (!grid || !grid._products) return
    const items = grid._products

    // Separate bundles and individual macros, render bundles first
    const bundles = items.filter(p => p.bundle_items && p.bundle_items.length)
    const singles = items.filter(p => !p.bundle_items || !p.bundle_items.length)
    const ordered = [...bundles, ...singles]

    grid.innerHTML = ordered.map(p => {
      const isBundle  = p.bundle_items && p.bundle_items.length > 0
      const isOwned   = isBundle
        ? p.bundle_items.every(id => _ownedSet.has(id))
        : _ownedSet.has(p.id)
      const inCart    = !!_cart.find(i => i.id === p.id)
      const price     = '$' + (p.price_cents / 100).toFixed(2)
      const badge     = p.badge || p.id.split('-').pop().toUpperCase().slice(0, 2)

      // Bundle: compute individual total for savings display
      let savingsHtml = ''
      let includedHtml = ''
      if (isBundle) {
        const bundleProducts = p.bundle_items
          .map(id => items.find(x => x.id === id))
          .filter(Boolean)
        const indivTotal = bundleProducts.reduce((s, x) => s + x.price_cents, 0)
        const savings = indivTotal - p.price_cents
        if (savings > 0) {
          savingsHtml = `<span style="display:inline-flex;align-items:center;padding:2px 7px;border-radius:6px;font-size:10px;font-weight:800;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.25);color:#fbbf24;letter-spacing:.04em;margin-left:6px">SAVE $${(savings/100).toFixed(2)}</span>`
        }
        includedHtml = `
          <div style="margin-bottom:12px;display:flex;flex-wrap:wrap;gap:5px">
            ${bundleProducts.map(x => `
              <span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;font-size:10px;font-weight:700;background:rgba(251,191,36,.07);border:1px solid rgba(251,191,36,.18);color:#fcd34d">
                <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" width="8" height="8"><path d="M1.5 5l2.5 2.5 4.5-4"/></svg>${x.name}
              </span>`).join('')}
          </div>`
      }

      let footer
      if (isOwned) {
        // For bundles: show download buttons for each included macro
        // For singles: show download + instructions buttons
        const downloadBtns = isBundle
          ? p.bundle_items.map(bid => {
              const bp = items.find(x => x.id === bid)
              if (!bp || !bp.download_ref) return ''
              return `<button onclick="downloadMacro('${bid}','${(bp.name || bid).replace(/'/g, "\\'")}')"
                style="display:inline-flex;align-items:center;gap:5px;padding:6px 12px;border-radius:8px;font-size:11px;font-weight:600;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:var(--t2);cursor:pointer"
                onmouseover="this.style.color='var(--t1)';this.style.background='rgba(255,255,255,.09)'" onmouseout="this.style.color='var(--t2)';this.style.background='rgba(255,255,255,.05)'">
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" width="11" height="11"><path d="M7 1v8M4 6l3 3 3-3"/><path d="M1 11v1a1 1 0 001 1h10a1 1 0 001-1v-1"/></svg>${bp.name}
              </button>`
            }).join('')
          : (p.download_ref ? `<button onclick="downloadMacro('${p.id}','${p.name.replace(/'/g,"\\'")}')"
              style="display:inline-flex;align-items:center;gap:5px;padding:6px 12px;border-radius:8px;font-size:11px;font-weight:600;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:var(--t2);cursor:pointer"
              onmouseover="this.style.color='var(--t1)';this.style.background='rgba(255,255,255,.09)'" onmouseout="this.style.color='var(--t2)';this.style.background='rgba(255,255,255,.05)'">
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" width="11" height="11"><path d="M7 1v8M4 6l3 3 3-3"/><path d="M1 11v1a1 1 0 001 1h10a1 1 0 001-1v-1"/></svg>Download
            </button>` : '')

        footer = `
          <div style="margin-top:auto;padding-top:16px">
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              <span class="macro-badge-owned" style="display:inline-flex;align-items:center;gap:5px;padding:6px 11px;border-radius:8px;font-size:11px;font-weight:700;background:linear-gradient(135deg,rgba(34,197,94,.12),rgba(52,211,153,.06));border:1px solid rgba(34,197,94,.25);color:#86efac;letter-spacing:.02em;box-shadow:0 0 12px rgba(34,197,94,.08)">
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" width="10" height="10"><path d="M2 6l3 3 5-5"/></svg>${isBundle ? 'BUNDLE OWNED' : 'OWNED'}
              </span>
              ${downloadBtns}
            </div>
          </div>`
      } else if (inCart) {
        footer = `
          <div style="margin-top:auto;padding-top:16px;display:flex;gap:8px;align-items:center">
            <span style="display:inline-flex;align-items:center;gap:5px;padding:6px 11px;border-radius:8px;font-size:11px;font-weight:700;background:rgba(124,58,237,.1);border:1px solid rgba(124,58,237,.25);color:#c4b5fd">
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" width="10" height="10"><path d="M2 6l3 3 5-5"/></svg>In Cart
            </span>
            <button onclick="removeFromCart('${p.id}')" style="display:inline-flex;align-items:center;gap:4px;padding:6px 12px;border-radius:8px;font-size:11px;font-weight:600;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:var(--t3);cursor:pointer"
              onmouseover="this.style.color='#fca5a5';this.style.borderColor='rgba(239,68,68,.25)'" onmouseout="this.style.color='var(--t3)';this.style.borderColor='rgba(255,255,255,.08)'">Remove</button>
          </div>`
      } else {
        const btnGradient = isBundle
          ? 'linear-gradient(135deg,#b45309,#d97706)'
          : 'linear-gradient(135deg,#7c3aed,#a855f7)'
        const btnShadow = isBundle
          ? '0 3px 12px rgba(180,83,9,.3)'
          : '0 3px 12px rgba(124,58,237,.3)'
        footer = `
          <div style="margin-top:auto;padding-top:16px;display:flex;gap:8px">
            <button onclick="addToCart('${p.id}','${p.name.replace(/'/g,"\\'")}',${p.price_cents},'${badge}')"
              style="flex:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:9px 14px;border-radius:10px;font-size:12px;font-weight:700;background:${btnGradient};border:none;color:#fff;cursor:pointer;box-shadow:${btnShadow};transition:opacity .15s,transform .15s"
              onmouseover="this.style.opacity='.85';this.style.transform='translateY(-1px)'" onmouseout="this.style.opacity='1';this.style.transform='none'">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M2 2h2l.8 4M6 10h8l1.2-6H4.8M6 10l-1.2 4h9.4"/><circle cx="7" cy="15" r="1"/><circle cx="13" cy="15" r="1"/></svg>
              ${isBundle ? 'Get Bundle' : 'Add to Cart'} — ${price}
            </button>
          </div>`
      }

      // Bundle card uses amber accent; single uses purple
      const accentColor  = isBundle ? 'rgba(217,119,6,.3)'   : 'rgba(124,58,237,.25)'
      const accentShadow = isBundle ? 'rgba(217,119,6,.1)'   : 'rgba(124,58,237,.08)'
      const badgeBg      = isBundle
        ? 'linear-gradient(135deg,rgba(217,119,6,.3),rgba(251,191,36,.15));border:1px solid rgba(217,119,6,.4)'
        : 'linear-gradient(135deg,rgba(124,58,237,.25),rgba(168,85,247,.15));border:1px solid rgba(124,58,237,.3)'
      const badgeColor   = isBundle ? '#fcd34d' : '#ddd6fe'
      const bundgeTopBadge = isBundle
        ? `<div style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:800;background:rgba(217,119,6,.12);border:1px solid rgba(217,119,6,.3);color:#fbbf24;letter-spacing:.06em;margin-bottom:10px">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" width="9" height="9"><path d="M6 1l1.2 3.6H11L8.4 6.8l.9 3.7L6 8.4l-3.3 2.1.9-3.7L1 4.6h3.8z"/></svg>BUNDLE
          </div>`
        : ''

      const _cardIdx = ordered.indexOf(p)
      const _delay   = `${_cardIdx * 60}ms`
      return `
        <div class="macro-card" style="background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:0;transition:border-color .25s,box-shadow .25s,transform .25s var(--ease-out);min-height:180px;animation-delay:${_delay}"
          onmouseover="this.style.borderColor='${accentColor}';this.style.boxShadow='0 8px 36px ${accentShadow}';this.style.transform='translateY(-3px)'"
          onmouseout="this.style.borderColor='rgba(255,255,255,.07)';this.style.boxShadow='none';this.style.transform='none'">

          ${bundgeTopBadge}

          <!-- top: badge + name + price -->
          <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:14px">
            <div style="width:44px;height:44px;border-radius:12px;background:${badgeBg};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;color:${badgeColor};flex-shrink:0;letter-spacing:.06em">${badge}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:15px;font-weight:700;color:var(--t1);letter-spacing:-.25px;line-height:1.2">${p.name}${savingsHtml}</div>
              <div style="font-size:11px;color:${isBundle ? '#fbbf24' : '#a78bfa'};margin-top:3px;font-weight:700;letter-spacing:.03em">${price} · one-time</div>
            </div>
          </div>

          <!-- bundle: included items chips -->
          ${includedHtml}

          <!-- description -->
          <div style="font-size:13px;color:var(--t2);line-height:1.6;flex:1">${p.description || ''}</div>

          ${footer}

          <!-- guide link always visible -->
          ${!isBundle ? `<div style="margin-top:10px">
            <button onclick="showMacroInstructions('${p.id}')"
              style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:7px;font-size:11px;font-weight:600;background:none;border:1px solid rgba(255,255,255,.08);color:var(--t3);cursor:pointer;transition:color .15s,border-color .15s"
              onmouseover="this.style.color='var(--t2)';this.style.borderColor='rgba(255,255,255,.18)'" onmouseout="this.style.color='var(--t3)';this.style.borderColor='rgba(255,255,255,.08)'">
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" width="10" height="10"><circle cx="7" cy="7" r="6"/><path d="M7 6v4M7 4h.01"/></svg>
              How to use
            </button>
          </div>` : ''}
        </div>`
    }).join('')

  }

  async function loadStandaloneMacros() {
    _standaloneLoaded = true
    const grid    = byId('standalone-grid')
    const loading = byId('standalone-loading')
    const empty   = byId('standalone-empty')
    if (loading) loading.style.display = 'block'
    if (empty)   empty.style.display   = 'none'
    if (grid)    grid.innerHTML        = ''

    try {
      const [prod, ent] = await Promise.all([
        fetch('/api/products').then(r => r.json()),
        apiFetch('/api/dashboard/entitlements').catch(() => ({ items: [] })),
      ])

      if (loading) loading.style.display = 'none'

      const items = prod?.items || []
      if (!items.length) { if (empty) empty.style.display = 'block'; return }

      _ownedSet = new Set((ent?.items || []).map(e => e.product_id))
      if (grid) grid._products = items
      renderGrid()
    } catch (err) {
      if (loading) loading.style.display = 'none'
      if (grid) grid.innerHTML = `<div style="color:#fca5a5;font-size:13px;padding:24px 0">Failed to load products. Try refreshing.</div>`
    }
  }

  window.downloadMacro = async function(productId, productName) {
    try {
      const r = await apiFetch(`/api/standalone/download/${productId}`)
      if (r?.url) {
        const a = document.createElement('a')
        a.href = r.url
        a.download = ''
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
      }
    } catch (e) {
      alert(`Download failed: ${e?.message || 'Unknown error'}. Make sure you are logged in.`)
    }
  }

  window.showMacroInstructions = function(productId) {
    const instructions = {
      'zenith-single-anchor': {
        title: 'Single Anchor — Setup Guide',
        steps: [
          'Download and run <b>ZenithSingleAnchor.exe</b> as Administrator.',
          'Enter your Zenith Macros license key when prompted.',
          'Set your <b>macro keybind</b> (e.g. F or Mouse4).',
          'Set your <b>slot keys</b>: Anchor slot, Glowstone slot, Totem slot.',
          'In-game: press your keybind to instantly place, charge, and explode the anchor.',
          '<b>Requires:</b> Anchor, Glowstone, Totem in those slots. Works in Badlion, Lunar, Feather.'
        ]
      },
      'zenith-safe-anchor': {
        title: 'Safe Anchor — Setup Guide',
        steps: [
          'Download and run <b>ZenithSafeAnchor.exe</b> as Administrator.',
          'Enter your Zenith Macros license key when prompted.',
          'Configure slot keys and your action sequence (place / charge / explode).',
          'Toggle individual actions on/off from the settings menu.',
          'Press your keybind in-game to execute only the enabled steps.',
          '<b>Tip:</b> Disable the explode step to safely charge without detonating.'
        ]
      },
      'zenith-shield-break': {
        title: 'Shield Break — Setup Guide',
        steps: [
          'Download and run <b>ZenithShieldBreak.exe</b> as Administrator.',
          'Enter your Zenith Macros license key when prompted.',
          'Set your <b>axe slot key</b> (the axe used to break shields).',
          'Set your <b>macro keybind</b>.',
          'Press your keybind while facing an enemy with a shield to instantly axe-click twice.',
          '<b>Requires:</b> An axe in the configured slot.'
        ]
      },
      'zenith-triggerbot': {
        title: 'Triggerbot — Setup Guide',
        steps: [
          'Download and run <b>ZenithTriggerbot.exe</b> as Administrator.',
          '<b>Required:</b> Install a crosshair color mod that turns your crosshair blue when aiming at an enemy.',
          'Enter your Zenith Macros license key when prompted.',
          'Set your <b>toggle keybind</b> (turns the triggerbot ON/OFF in-game).',
          'Press your toggle key once in-game to activate — the bot will auto-click whenever your crosshair turns blue.',
          'Press toggle again or F7 to stop. Window must be focused (Minecraft must be the active window).'
        ]
      },
      'zenith-stun-slam': {
        title: 'Stun Slam — Setup Guide',
        steps: [
          'Download and run <b>ZenithStunSlam.exe</b> as Administrator.',
          'Enter your Zenith Macros license key when prompted.',
          'Set your <b>axe slot key</b> and <b>mace slot key</b>.',
          'Set your <b>macro keybind</b>.',
          'Press your keybind in-game to stun with the axe and immediately slam with the mace.',
          '<b>Requires:</b> Axe and Mace in configured slots.'
        ]
      },
      'zenith-pearl-catch': {
        title: 'Pearl Catch — Setup Guide',
        steps: [
          'Download and run <b>ZenithPearlCatch.exe</b> as Administrator.',
          'Enter your Zenith Macros license key when prompted.',
          'Set your <b>pearl slot key</b> and <b>wind charge slot key</b>.',
          'Set your <b>macro keybind</b>.',
          'Press your keybind to throw a pearl and immediately follow with a wind charge.',
          '<b>Requires:</b> Ender Pearl and Wind Charge in configured slots.'
        ]
      },
      'zenith-breach-swap': {
        title: 'Breach Swap — Setup Guide',
        steps: [
          'Download and run <b>ZenithBreachSwap.exe</b> as Administrator.',
          'Enter your Zenith Macros license key when prompted.',
          'Set your <b>mace slot key</b> and <b>sword slot key</b>.',
          'Set your <b>macro keybind</b>.',
          'Press your keybind to execute a mace breach attack then instantly swap to sword.',
          '<b>Requires:</b> Mace and Sword in configured slots.'
        ]
      },
    }
    const data = instructions[productId]
    if (!data) return

    const existing = document.getElementById('macro-instructions-modal')
    if (existing) existing.remove()

    const modal = document.createElement('div')
    modal.id = 'macro-instructions-modal'
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px'
    modal.onclick = e => { if (e.target === modal) modal.remove() }
    modal.innerHTML = `
      <div style="background:#18181b;border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:32px;max-width:520px;width:100%;max-height:80vh;overflow-y:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
          <div style="font-size:16px;font-weight:700;color:var(--t1)">${data.title}</div>
          <button onclick="document.getElementById('macro-instructions-modal').remove()"
            style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:var(--t2);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center">✕</button>
        </div>
        <ol style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:12px">
          ${data.steps.map(s => `<li style="font-size:13px;color:var(--t2);line-height:1.6">${s}</li>`).join('')}
        </ol>
        <div style="margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,.07);font-size:11px;color:var(--t3)">
          Run as Administrator · Requires Windows 10/11 · No Python needed
        </div>
      </div>`
    document.body.appendChild(modal)
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
      const licenseActive = !!me.summary && me.summary.status !== 'inactive' && me.summary.status !== 'expired'
      setAuthState(true, licenseActive)

      if (authFlag === 'ok') setStatus('Discord connected successfully.')

      const licenses = await apiFetch('/api/dashboard/licenses').catch(() => ({ items: [] }))
      applyLicenseList(licenses.items || [])

      // Fetch portal URL for billing management
      try {
        const pricing = await apiFetch('/api/pricing')
        portalUrl = pricing?.portal_url || null
        const billingLink = byId('manage-billing-link')
        if (billingLink) {
          if (portalUrl) {
            billingLink.href = portalUrl
            billingLink.style.display = ''
          } else {
            billingLink.style.display = 'none'
          }
        }
      } catch (_) { /* pricing fetch is non-critical */ }

    } catch (err) {
      setAuthState(false, false)
      hideSkeleton()
      applyLicense({})
      if (byId('ov-key')) byId('ov-key').textContent = '—'

      if (authFlag === 'declined') setStatus('Discord login was declined.')
      else if (authFlag === 'failed') setStatus('Discord login failed. Please try again.')
      else if (err?.status === 401) setStatus('Session expired. Please log in again.')
      else setStatus(err?.message || 'Could not load dashboard.')
    }

    if (authFlag) history.replaceState({}, '', '/dashboard.html')
  }

  // Don't boot the dashboard if this page was opened as the OAuth relay
  // popup for local dev — the relay script will close this window shortly.
  if (!window.__zdash_relay_active) init()
})()
