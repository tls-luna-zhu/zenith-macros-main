(() => {
  // Store referral code from URL so it persists through the purchase flow
  try {
    const _urlRef = new URLSearchParams(location.search).get('ref')
    if (_urlRef) sessionStorage.setItem('zenith_referral_code', _urlRef.toLowerCase())
  } catch (_) {}

  const MODULES = {
    crystal: {
      label: 'Crystal', abbr: 'CRY', count: 10,
      subtitle: 'End crystal PvP automation',
      chips: ['Single Anchor','Safe Anchor','Double Anchor','Anchor Pearl','Hit Crystal','Auto Crystal','Key Pearl','Inv D-Hand','Offhand Totem','Fast XP'],
      cards: [
        { id:'SA', name:'Single Anchor',  desc:'Place, charge, and explode one anchor',                          keybind:'Mouse4', delay:45,  on:true  },
        { id:'SFA',name:'Safe Anchor',    desc:'Place, charge, flick down, place glowstone, switch to totem',   keybind:'R',      delay:30,  on:false },
        { id:'DA', name:'Double Anchor',  desc:'Place, charge, and explode two anchors in sequence', keybind:'G', delay:26,  on:false },
        { id:'AP', name:'Anchor Pearl',   desc:'Anchor sequence followed by instant pearl escape',   keybind:'—', delay:25,  on:false },
        { id:'HC', name:'Hit Crystal',    desc:'Obsidian place then immediate crystal placement',     keybind:'—', delay:1,   on:false },
        { id:'AC', name:'Auto Crystal',   desc:'Fully automated crystal rotation and detonation',    keybind:'Z', delay:8,   on:false },
        { id:'KP', name:'Key Pearl',      desc:'Switch slot, throw pearl, return to prior item',     keybind:'3', delay:30,  on:false },
        { id:'IDH',name:'Inv D-Hand',     desc:'Swap offhand inventory item without menu',           keybind:'—', delay:12,  on:false },
        { id:'OHT',name:'Offhand Totem',  desc:'Moves totem to offhand via inventory interaction',   keybind:'X', delay:8,   on:true  },
        { id:'FXP',name:'Fast XP',        desc:'Rapid XP bottle collection sequence',                keybind:'—', delay:6,   on:false },
      ]
    },
    sword: {
      label: 'Sword', abbr: 'SWD', count: 5,
      subtitle: 'Sword PvP consistency modules',
      chips: ['Shield Stun','Lunge Swap','Triggerbot','KB Disposal','Stun Web'],
      cards: [
        { id:'ASB',name:'Shield Stun',  desc:'Double-click timing to force a reliable shield stun', keybind:'F', delay:21, on:true  },
        { id:'LS', name:'Lunge Swap',   desc:'Lunge swap timing chain for consistent hits',          keybind:'C', delay:18, on:false },
        { id:'TB', name:'Triggerbot',   desc:'Pixel crosshair detection with Normal and S-Tap modes',keybind:'X', delay:600, on:true  },
        { id:'KBD',name:'KB Disposal',  desc:'Directional knockback flick — instantly snaps aim, clicks, and resets for server-registered KBs', keybind:'—', delay:50, on:false },
        { id:'SW', name:'Stun Web',     desc:'Stun chain into web placement for corner control',     keybind:'V', delay:28, on:false },
      ]
    },
    mace: {
      label: 'Mace', abbr: 'MCE', count: 5,
      subtitle: 'Mace combo automation',
      chips: ['Elytra Swap','Pearl Catch','Stun Slam','Auto Stun Slam','Breach Swap'],
      cards: [
        { id:'ES', name:'Elytra Swap',     desc:'Fast elytra swap timing sequence for slam setups',                      keybind:'Q', delay:20,  on:true  },
        { id:'PC', name:'Pearl Catch',     desc:'Pearl throw followed by immediate slam sequence',                        keybind:'E', delay:24,  on:false },
        { id:'SS', name:'Stun Slam',       desc:'Stun routing that sets up a guaranteed slam',                            keybind:'T', delay:16,  on:false },
        { id:'ASS',name:'Auto Stun Slam',  desc:'Auto-fires Stun Slam the instant the crosshair turns blue on target',   keybind:'—', delay:500, on:true  },
        { id:'BS', name:'Breach Swap',     desc:'Rapid weapon swap burst for mace breach situations',                     keybind:'Y', delay:5,   on:false },
      ]
    },
    cart: {
      label: 'Cart', abbr: 'CRT', count: 2,
      subtitle: 'Explosive cart sequencing',
      chips: ['Insta Cart','Crossbow'],
      cards: [
        { id:'IC', name:'Insta Cart', desc:'Bow charge, rail placement, and cart deploy sequence', keybind:'B', delay:26, on:true  },
        { id:'CB', name:'Crossbow',   desc:'Crossbow load and detonation chain timing',            keybind:'N', delay:20, on:false },
      ]
    },
    uhc: {
      label: 'UHC', abbr: 'UHC', count: 3,
      subtitle: 'UHC utility and support macros',
      chips: ['Drain','Lava Web','Lava'],
      cards: [
        { id:'DR', name:'Drain',    desc:'Fluid drain with reset spacing for controlled removal', keybind:'H', delay:30, on:false },
        { id:'LW', name:'Lava Web', desc:'Synchronized lava and web placement timing',            keybind:'J', delay:34, on:false },
        { id:'LV', name:'Lava',     desc:'Quick lava placement helper for rapid utility',         keybind:'K', delay:30, on:false },
      ]
    }
  }

  
  let showcaseView = 'crystal'
  let modTab = 'crystal'
  let authCache = null

  
  const $ = (id) => document.getElementById(id)
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel))

  
  function setupCursorBg() {
    const el = $('bg-cursor')
    if (!el) return
    let tx = 50, ty = 44, cx = 50, cy = 44, raf = 0
    const ease = 0.045
    const step = () => {
      cx += (tx - cx) * ease
      cy += (ty - cy) * ease
      el.style.setProperty('--cx', cx.toFixed(2) + '%')
      el.style.setProperty('--cy', cy.toFixed(2) + '%')
      raf = requestAnimationFrame(step)
    }
    window.addEventListener('mousemove', (e) => {
      tx = (e.clientX / window.innerWidth) * 100
      ty = (e.clientY / window.innerHeight) * 100
    }, { passive: true })
    raf = requestAnimationFrame(step)
  }

  
  function setupNav() {
    const nav = $('topnav')
    if (!nav) return
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 18)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
  }

  
  function setupHeroTitle() {
    const title = $('hero-title')
    if (!title) return
    requestAnimationFrame(() => title.classList.add('ready'))
  }

  
  function setupReveal() {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('vis')
          obs.unobserve(e.target)
        }
      })
    }, { threshold: 0.1, rootMargin: '0px 0px -4% 0px' })
    qsa('.reveal').forEach((el) => obs.observe(el))
  }

  
  function setupClock() {
    const el = $('sc-clock')
    if (!el) return
    const tick = () => {
      const now = new Date()
      el.textContent = now.toTimeString().slice(0, 8)
    }
    tick()
    setInterval(tick, 1000)
  }

  
  async function fetchAuth() {
    if (authCache !== null) return authCache
    try {
      const r = await fetch('/api/dashboard/me', { credentials: 'include' })
      if (!r.ok) { authCache = { ok: false }; return authCache }
      const d = await r.json().catch(() => ({}))
      authCache = { ok: !!d?.ok, data: d }
      return authCache
    } catch { authCache = { ok: false }; return authCache }
  }

  async function syncAuth() {
    const loginBtn = $('nav-login-btn')
    const dashBtn = $('nav-dash-btn')
    if (!loginBtn) return
    const state = await fetchAuth()
    if (state?.ok) {
      loginBtn.textContent = 'Dashboard'
      loginBtn.href = 'dashboard.html'
      loginBtn.classList.remove('btn-ghost')
      loginBtn.classList.add('btn-primary')
      if (dashBtn) dashBtn.style.display = 'none'
    } else {
      loginBtn.textContent = 'Login with Discord'
      loginBtn.href = '/api/auth/discord/start'
    }
  }

  
  async function loadPricing() {
    try {
      const r = await fetch('/api/pricing')
      if (!r.ok) return
      const d = await r.json().catch(() => ({}))
      const mp = $('monthly-price')
      const tp = $('threemonth-price')
      const lp = $('lifetime-price')
      if (mp && d?.monthly?.amount) mp.textContent = String(d.monthly.amount)
      if (tp && d?.['3month']?.amount) tp.textContent = String(d['3month'].amount)
      if (lp && d?.lifetime?.amount) lp.textContent = String(d.lifetime.standardAmount || d.lifetime.amount)
    } catch {  }
  }

  async function buyPlan(plan) {
    const state = await fetchAuth()
    if (!state?.ok) {
      const modal = document.getElementById('login-modal')
      const goBtn = document.getElementById('login-modal-go')
      const cancelBtn = document.getElementById('login-modal-cancel')
      const _ref2 = (() => { try { return sessionStorage.getItem('zenith_referral_code') || '' } catch (_) { return '' } })()
      const _refParam2 = _ref2 ? `&ref=${encodeURIComponent(_ref2)}` : ''
      const _spUrl = `/selectpayment?plan=${encodeURIComponent(plan)}${_refParam2}`
      if (!modal) { window.location.href = '/auth/discord/start?next=' + encodeURIComponent(_spUrl); return }
      modal.style.display = 'flex'
      goBtn.onclick = function() { window.location.href = '/auth/discord/start?next=' + encodeURIComponent(_spUrl) }
      cancelBtn.onclick = function() { modal.style.display = 'none' }
      modal.onclick = function(e) { if (e.target === modal) modal.style.display = 'none' }
      return
    }
    const _ref = (() => { try { return sessionStorage.getItem('zenith_referral_code') || '' } catch (_) { return '' } })()
    const _refParam = _ref ? `&ref=${encodeURIComponent(_ref)}` : ''
    window.location.href = `/selectpayment?plan=${encodeURIComponent(plan)}${_refParam}`
  }
  window.buyPlan = buyPlan

  
  function setupToast() {
    const params = new URLSearchParams(window.location.search)
    if (params.get('purchased') !== 'true') return
    const toast = $('purchase-toast')
    if (toast) { toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 10000) }
    history.replaceState({}, '', window.location.pathname + window.location.hash)
  }

  
  const SHOWCASE_ICONS = {
    crystal: `<path d="M8 2L2 5v4c0 3 2.5 5 6 6 3.5-1 6-3 6-6V5z"/>`,
    sword:   `<path d="M3 13L10 6M7 3l3 1 3-3-1-3-3 3z"/>`,
    mace:    `<path d="M2 14l5.5-5.5"/><circle cx="10.5" cy="5.5" r="3"/>`,
    cart:    `<rect x="2" y="5" width="10" height="7" rx="1"/><path d="M2 5l2-3h6l2 3"/>`,
    uhc:     `<path d="M8 2C5.5 2 3 4 3 6.5c0 3.5 5 7.5 5 7.5s5-4 5-7.5C13 4 10.5 2 8 2z"/>`,
    profiles:`<rect x="2" y="3" width="5" height="4" rx="1"/><rect x="9" y="3" width="5" height="4" rx="1"/><rect x="2" y="9" width="5" height="4" rx="1"/>`,
    settings:`<circle cx="8" cy="8" r="2"/><path d="M8 2v2M8 12v2M2 8h2M12 8h2"/>`,
  }

  function svgIcon16(paths) {
    return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">${paths}</svg>`
  }

  function renderShowcaseContent(view) {
    const el = $('sc-content')
    if (!el) return

    // update sidebar active state
    qsa('.sc-si').forEach((s) => {
      s.classList.toggle('on', s.dataset.sc === view)
    })

    // update tab active state
    qsa('.sc-tab').forEach((t) => {
      t.classList.toggle('on', t.dataset.view === view)
    })

    if (view === 'profiles') {
      el.innerHTML = `
        <div class="sc-pg-t">Profiles</div>
        <div class="sc-pg-s">Save and load full macro configurations</div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <span style="font-size:9px;font-weight:700;color:#3a3a52;letter-spacing:1px;text-transform:uppercase">Your profiles</span>
          <div style="display:flex;gap:5px"><span style="font-size:10px;font-weight:600;color:#e4e4eb;background:#121218;border:1px solid rgba(40,40,65,.9);border-radius:7px;padding:4px 11px;cursor:default">Load</span><span style="font-size:10px;font-weight:600;color:#e4e4eb;background:#121218;border:1px solid rgba(40,40,65,.9);border-radius:7px;padding:4px 11px;cursor:default">+ New</span></div>
        </div>
        <div class="zc-plist">
          <div class="zc-pc active"><div class="zc-pc-num">1</div><div class="zc-pc-name">Crystal Default</div><div class="zc-pc-sub">10 macros configured</div><div class="zc-pc-tag">Active</div></div>
          <div class="zc-pc"><div class="zc-pc-num">2</div><div class="zc-pc-name">Sword PvP</div><div class="zc-pc-sub">4 macros configured</div></div>
          <div class="zc-pc"><div class="zc-pc-num">3</div><div class="zc-pc-name">UHC Setup</div><div class="zc-pc-sub">3 macros configured</div></div>
          <div class="zc-pc zc-pc-new"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span style="font-size:10px;color:#4a4a62">New profile</span></div>
        </div>`
      return
    }

    if (view === 'settings') {
      el.innerHTML = `
        <div class="sc-pg-t">Settings</div>
        <div class="sc-pg-s">Application preferences and license info</div>
        <div style="margin-top:8px">
          ${[
            ['Focus Lock','Suspend macros automatically when Minecraft loses focus','on'],
            ['Chat Pause','Pause macros when the chat window is open','on'],
            ['Hide on Startup','Start the client minimized to the system tray','off'],
            ['Auto-update Check','Check for updates on launch','on'],
            ['Show Status Bar','Display the status bar at the bottom of the window','on'],
          ].map(([t,d,s]) => `
          <div class="zc-srow">
            <div class="zc-smeta"><div class="zc-st">${t}</div><div class="zc-sd">${d}</div></div>
            <div class="sc-tog ${s}" style="cursor:default"></div>
          </div>`).join('')}
        </div>`
      return
    }

    // macro category view
    const cat = MODULES[view]
    if (!cat) return

    const toggleStates = {}
    cat.cards.forEach((c) => { toggleStates[c.id] = c.on })

    el.innerHTML = `
      <div class="sc-pg-t">${cat.label}</div>
      <div class="sc-pg-s">${cat.subtitle}</div>
      <div class="sc-det">
        <div class="sc-det-l"><div class="det-dot on" style="background:var(--a3)"></div>Detection <strong style="color:#e0e0ea;font-weight:600;margin-left:4px">Running</strong></div>
        <span style="font-size:9.5px">Minecraft in background</span>
      </div>
      <div class="sc-sec">Modules</div>
      <div class="sc-chips">${cat.chips.map((c) => `<div class="sc-chip">${c}</div>`).join('')}</div>
      <div class="sc-sec">Configuration</div>
      <div class="sc-cards" id="sc-cards">
        ${cat.cards.map((card) => `
        <div class="sc-card" data-card-id="${card.id}">
          <div class="sc-card-h">
            <div class="sc-card-ico">${card.id}</div>
            <div class="sc-card-n">${card.name}</div>
            <div class="sc-tog ${card.on ? 'on' : 'off'}" data-tog="${card.id}"></div>
          </div>
          <div class="sc-card-d">${card.desc}</div>
          <div class="sc-card-meta">
            <span class="sc-meta-badge">⌨ ${card.keybind}</span>
            <span class="sc-meta-badge">⏱ ${card.delay}ms</span>
          </div>
        </div>`).join('')}
      </div>`

    // wire toggles
    el.querySelectorAll('.sc-tog').forEach((tog) => {
      tog.addEventListener('click', () => {
        tog.classList.toggle('on')
        tog.classList.toggle('off')
        const activeCount = el.querySelectorAll('.sc-tog.on').length
        const activeEl = $('sc-active')
        if (activeEl) activeEl.textContent = String(activeCount)
      })
    })
  }

  function setupShowcase() {
    // sidebar clicks
    qsa('.sc-si').forEach((si) => {
      si.addEventListener('click', () => {
        const v = si.dataset.sc
        if (!v) return
        showcaseView = v
        renderShowcaseContent(v)
      })
    })

    // top tabs
    qsa('.sc-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const v = tab.dataset.view
        if (!v) return
        showcaseView = v
        renderShowcaseContent(v)
      })
    })

    // initial render
    renderShowcaseContent(showcaseView)
  }

  
  function renderModPanel(key) {
    const cat = MODULES[key]
    if (!cat) return ''
    return `<div class="mod-panel vis" id="mod-panel-${key}">
      ${cat.cards.map((c) => `
      <div class="mod-card">
        <div class="mod-card-h">
          <div class="mod-card-ico">${c.id}</div>
          <div class="mod-card-name">${c.name}</div>
        </div>
        <div class="mod-card-desc">${c.desc}</div>
        <div class="mod-card-meta">
          <span class="meta-tag">⌨ ${c.keybind}</span>
          <span class="meta-tag">⏱ ${c.delay}ms</span>
          ${c.on ? '<span class="meta-tag" style="color:#c4b5fd;border-color:rgba(168,85,247,.3)">Default on</span>' : ''}
        </div>
      </div>`).join('')}
    </div>`
  }

  function setupModTabs() {
    const panels = $('mod-panels')
    if (!panels) return

    // render all panels, initially show crystal
    panels.innerHTML = Object.keys(MODULES).map((key) => {
      const cat = MODULES[key]
      return `<div class="mod-panel${key === 'crystal' ? ' vis' : ''}" id="mod-panel-${key}">
        ${cat.cards.map((c) => `
        <div class="mod-card">
          <div class="mod-card-h">
            <div class="mod-card-ico">${c.id}</div>
            <div class="mod-card-name">${c.name}</div>
          </div>
          <div class="mod-card-desc">${c.desc}</div>
          <div class="mod-card-meta">
            <span class="meta-tag">⌨ ${c.keybind}</span>
            <span class="meta-tag">⏱ ${c.delay}ms</span>
            ${c.on ? '<span class="meta-tag" style="color:#c4b5fd;border-color:rgba(168,85,247,.3)">Default on</span>' : ''}
          </div>
        </div>`).join('')}
      </div>`
    }).join('')

    qsa('.mct').forEach((tab) => {
      tab.addEventListener('click', () => {
        const key = tab.dataset.mod
        if (!key) return
        modTab = key
        qsa('.mct').forEach((t) => t.classList.toggle('on', t.dataset.mod === key))
        qsa('.mod-panel').forEach((p) => p.classList.toggle('vis', p.id === `mod-panel-${key}`))
      })
    })
  }

  
  function setupAffChart() {
    const chart = $('aff-chart-demo')
    if (!chart) return
    const vals = [4,6,2,8,5,10,7,12,9,6,11,8,14,10]
    const max = Math.max(...vals)
    chart.innerHTML = vals.map((v) => {
      const h = Math.max(8, (v / max) * 52)
      return `<div class="aff-bar" style="height:${h}px;opacity:${0.55 + (v/max)*0.45}"></div>`
    }).join('')
  }

  
  function setupFaq() {
    qsa('.fi').forEach((item) => {
      item.querySelector('.fq')?.addEventListener('click', () => {
        const isOpen = item.classList.contains('open')
        qsa('.fi').forEach((i) => i.classList.remove('open'))
        if (!isOpen) item.classList.add('open')
      })
    })
  }

  
  function setupFeatStagger() {
    const grid = $('feat-grid')
    if (!grid) return
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          qsa('.fc', grid).forEach((fc, i) => {
            fc.style.transitionDelay = `${i * 0.06}s`
            fc.classList.add('vis')
          })
          obs.unobserve(e.target)
        }
      })
    }, { threshold: 0.1 })
    obs.observe(grid)
  }

  
  setupCursorBg()
  setupNav()
  setupHeroTitle()
  setupReveal()
  setupClock()
  setupShowcase()
  setupModTabs()
  setupAffChart()
  setupFaq()
  setupFeatStagger()
  loadPricing()
  setupToast()
  syncAuth()
})()
