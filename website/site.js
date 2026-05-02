(() => {
  const API = window.location.port === '4000' ? 'http://localhost:3001' : ''
  let authCache = null
  let moduleKey = 'crystal'

  const moduleData = {
    crystal: {
      label: 'Crystal',
      count: 10,
      summary: 'SA, SFA, DA, AP, HC, AC, KP, IDH, OHT, FXP',
      subtitle: 'End crystal PvP automation',
      chips: ['Single Anchor', 'Safe Anchor', 'Double Anchor', 'Anchor Pearl', 'Hit Crystal', 'Auto Crystal', 'Key Pearl', 'Inv D-Hand', 'Offhand Totem', 'Fast XP'],
      cards: [
        { name: 'Single Anchor', desc: 'Place, charge and explode one anchor', keybind: 'R', delay: 11, on: true },
        { name: 'Double Anchor', desc: 'Place, charge and explode two anchors', keybind: 'G', delay: 26, on: false },
        { name: 'Anchor Pearl', desc: 'Anchor sequence then pearl escape', keybind: 'None', delay: 25, on: false },
        { name: 'Hit Crystal', desc: 'Obsidian place then crystal place', keybind: 'None', delay: 1, on: false }
      ]
    },
    sword: {
      label: 'Sword',
      count: 4,
      summary: 'ASB, LS, Triggerbot, SW',
      subtitle: 'Sword PvP consistency modules',
      chips: ['Shield Stun', 'Lunge Swap', 'Triggerbot', 'Stun Web'],
      cards: [
        { name: 'Shield Stun', desc: 'Double-click timing to force shield stun', keybind: 'F', delay: 21, on: true },
        { name: 'Triggerbot', desc: 'Center crosshair red/blue click logic', keybind: 'X', delay: 600, on: true },
        { name: 'Lunge Swap', desc: 'Lunge swap timing chain for consistent hits', keybind: 'C', delay: 18, on: false },
        { name: 'Stun Web', desc: 'Stun chain into web placement', keybind: 'V', delay: 28, on: false }
      ]
    },
    mace: {
      label: 'Mace',
      count: 4,
      summary: 'ES, PC, SS, BS',
      subtitle: 'Mace combo automation',
      chips: ['Elytra Swap', 'Pearl Catch', 'Stun Slam', 'Breach Swap'],
      cards: [
        { name: 'Elytra Swap', desc: 'Fast elytra swap timing sequence for slam setups', keybind: 'Q', delay: 20, on: true },
        { name: 'Pearl Catch', desc: 'Pearl throw followed by immediate slam sequence', keybind: 'E', delay: 24, on: false },
        { name: 'Stun Slam', desc: 'Stun routing for slam setups', keybind: 'T', delay: 16, on: false },
        { name: 'Breach Swap', desc: 'Weapon swap burst routine', keybind: 'Y', delay: 5, on: false }
      ]
    },
    cart: {
      label: 'Cart',
      count: 2,
      summary: 'Insta Cart, Crossbow',
      subtitle: 'Explosive cart sequencing',
      chips: ['Insta Cart', 'Crossbow'],
      cards: [
        { name: 'Insta Cart', desc: 'Bow, rail, cart sequence', keybind: 'B', delay: 26, on: true },
        { name: 'Crossbow', desc: 'Crossbow detonation chain', keybind: 'N', delay: 20, on: false }
      ]
    },
    uhc: {
      label: 'UHC',
      count: 3,
      summary: 'Drain, Lava Web, Lava',
      subtitle: 'UHC utility and support macros',
      chips: ['Drain', 'Lava Web', 'Lava'],
      cards: [
        { name: 'Drain', desc: 'Drain fluid and reset spacing', keybind: 'H', delay: 30, on: false },
        { name: 'Lava Web', desc: 'Lava and web placement timing', keybind: 'J', delay: 34, on: false },
        { name: 'Lava', desc: 'Quick lava placement helper', keybind: 'K', delay: 30, on: false }
      ]
    }
  }

  function byId(id) {
    return document.getElementById(id)
  }

  async function fetchAuthState() {
    if (authCache !== null) return authCache
    try {
      const r = await fetch('/api/dashboard/me', { credentials: 'include' })
      if (!r.ok) {
        authCache = { ok: false }
        return authCache
      }
      const data = await r.json().catch(() => ({}))
      authCache = { ok: !!data?.ok, data }
      return authCache
    } catch (_) {
      authCache = { ok: false }
      return authCache
    }
  }

  async function ensureAuthForCheckout() {
    const state = await fetchAuthState()
    if (state?.ok) return true
    window.location.href = '/auth/discord/start?next=%2F%23pricing'
    return false
  }

  async function buyPlan(plan) {
    const ok = await ensureAuthForCheckout()
    if (!ok) return
    window.location.href = `${API}/api/create-checkout?plan=${encodeURIComponent(plan)}`
  }

  window.buyPlan = buyPlan

  async function loadPricing() {
    try {
      const r = await fetch(`${API}/api/pricing`)
      if (!r.ok) return
      const data = await r.json().catch(() => ({}))
      const monthlyPrice = byId('monthly-price')
      const lifetimePrice = byId('lifetime-price')
      const lifetimeSub = byId('lifetime-sub')
      if (monthlyPrice && data?.monthly?.amount) monthlyPrice.textContent = String(data.monthly.amount)
      if (lifetimePrice && data?.lifetime?.amount) lifetimePrice.textContent = String(data.lifetime.standardAmount || data.lifetime.amount)
      if (lifetimeSub) lifetimeSub.textContent = 'One-time payment with lifetime access and updates.'
    } catch (_) {}
  }

  function setupPurchaseToast() {
    const params = new URLSearchParams(window.location.search)
    if (params.get('purchased') !== 'true') return

    const toast = byId('purchase-toast')
    const sessionId = params.get('session_id') || ''
    const resendBtn = byId('resend-email-btn')
    const statusEl = byId('purchase-toast-status')
    if (!toast) return
    toast.classList.add('show')

    if (sessionId && resendBtn && statusEl) {
      resendBtn.style.display = 'inline-flex'
      resendBtn.addEventListener('click', async () => {
        resendBtn.disabled = true
        resendBtn.textContent = 'Sending...'
        statusEl.style.display = 'none'
        try {
          const r = await fetch(`${API}/api/resend-license-email`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId })
          })
          const data = await r.json().catch(() => ({}))
          statusEl.style.display = 'block'
          statusEl.textContent = (r.ok && data?.ok)
            ? 'License email resent. Please check inbox/spam.'
            : (data?.error || 'Could not resend email right now.')
        } catch (_) {
          statusEl.style.display = 'block'
          statusEl.textContent = 'Could not resend email right now.'
        } finally {
          resendBtn.disabled = false
          resendBtn.textContent = 'Resend License Email'
        }
      })
    }

    history.replaceState({}, '', window.location.pathname + window.location.hash)
    setTimeout(() => toast.classList.remove('show'), 12000)
  }

  function getCategoryEntries() {
    return Object.entries(moduleData)
  }

  function renderModuleUI(nextKey) {
    const data = moduleData[nextKey] || moduleData.crystal
    moduleKey = nextKey in moduleData ? nextKey : 'crystal'

    const list = byId('module-category-list')
    const side = byId('app-sidebar-list')
    const chips = byId('app-chip-row')
    const cards = byId('app-card-grid')
    const scene = byId('module-scene')

    if (list) {
      list.innerHTML = getCategoryEntries().map(([key, item]) => `
        <article class="module-item ${key === moduleKey ? 'on' : ''}" data-module="${key}">
          <h4><span>${item.label}</span><small>${item.count}</small></h4>
          <p>${item.count} macros - ${item.summary}</p>
        </article>
      `).join('')
    }

    if (side) {
      side.innerHTML = getCategoryEntries().map(([key, item]) => `
        <button class="${key === moduleKey ? 'on' : ''}" data-side="${key}">
          <span>${item.label}</span>
          <small>${item.count}</small>
        </button>
      `).join('')
    }

    const title = byId('app-cat-title')
    const subtitle = byId('app-subtitle')
    if (title) title.textContent = data.label
    if (subtitle) subtitle.textContent = data.subtitle

    if (chips) {
      chips.innerHTML = data.chips.map((chip) => `<i>${chip}</i>`).join('')
    }

    if (cards) {
      cards.innerHTML = data.cards.map((card) => `
        <article>
          <h4>${card.name}</h4>
          <p>${card.desc}</p>
          <div class="toggle ${card.on ? 'on' : ''}"></div>
          <div class="meta">
            <span>Keybind: ${card.keybind}</span>
            <span>Delay: ${card.delay}ms</span>
          </div>
        </article>
      `).join('')
    }

    if (scene) {
      scene.classList.remove('switching')
      window.requestAnimationFrame(() => scene.classList.add('switching'))
    }

    document.querySelectorAll('[data-module]').forEach((el) => {
      el.addEventListener('click', () => renderModuleUI(el.getAttribute('data-module') || 'crystal'))
    })

    document.querySelectorAll('[data-side]').forEach((el) => {
      el.addEventListener('click', () => renderModuleUI(el.getAttribute('data-side') || 'crystal'))
    })
  }

  function setupModuleAutoplay() {
    const order = getCategoryEntries().map(([key]) => key)
    if (!order.length) return

    const shell = byId('module-preview-shell')
    let index = order.indexOf(moduleKey)
    let active = true

    const tick = () => {
      if (!active) return
      index = (index + 1) % order.length
      renderModuleUI(order[index])
    }

    const timer = window.setInterval(tick, 5200)

    if (shell) {
      shell.addEventListener('mouseenter', () => { active = false })
      shell.addEventListener('mouseleave', () => { active = true })
    }

    window.addEventListener('beforeunload', () => clearInterval(timer), { once: true })
  }

  async function syncTopbarAuth() {
    const loginBtn = byId('nav-login-btn')
    const dashboardBtn = byId('nav-dashboard-btn')
    const heroDashboardBtn = byId('hero-dashboard-btn')
    const authPill = byId('auth-pill')
    if (!loginBtn) return

    const state = await fetchAuthState()
    if (state?.ok) {
      loginBtn.textContent = 'Dashboard'
      loginBtn.href = '/dashboard.html'
      loginBtn.classList.add('btn-primary')
      loginBtn.classList.remove('btn-ghost')
      if (dashboardBtn) dashboardBtn.style.display = 'none'
      if (heroDashboardBtn) heroDashboardBtn.style.display = 'inline-flex'
      if (authPill) authPill.textContent = 'Authenticated account detected. Checkout is linked securely.'
    } else {
      loginBtn.textContent = 'Login with Discord'
      loginBtn.href = '/auth/discord/start?next=%2Fdashboard.html'
      loginBtn.classList.add('btn-primary')
      loginBtn.classList.remove('btn-ghost')
      if (dashboardBtn) dashboardBtn.style.display = 'none'
      if (heroDashboardBtn) heroDashboardBtn.style.display = 'none'
      if (authPill) authPill.textContent = 'Discord OAuth required before checkout.'
    }
  }

  function setupReveal() {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view')
        }
      })
    }, { threshold: 0.13, rootMargin: '0px 0px -6% 0px' })

    document.querySelectorAll('.reveal').forEach((el, index) => {
      el.style.transitionDelay = `${Math.min(index * 50, 180)}ms`
      observer.observe(el)
    })
  }

  function setupTopNavMotion() {
    const nav = byId('topnav')
    if (!nav) return
    const onScroll = () => {
      if (window.scrollY > 14) nav.classList.add('scrolled')
      else nav.classList.remove('scrolled')
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
  }

  function setupTilt() {
    const maxX = 5
    const maxY = 7
    document.querySelectorAll('.tilt-card').forEach((el) => {
      el.style.transformStyle = 'preserve-3d'
      el.addEventListener('mousemove', (event) => {
        const rect = el.getBoundingClientRect()
        const x = (event.clientX - rect.left) / rect.width
        const y = (event.clientY - rect.top) / rect.height
        const rx = (0.5 - y) * maxX
        const ry = (x - 0.5) * maxY
        el.style.transform = `perspective(1200px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`
      })
      el.addEventListener('mouseleave', () => {
        el.style.transform = 'perspective(1200px) rotateX(0deg) rotateY(0deg)'
      })
    })
  }

  function setupMagnetic() {
    document.querySelectorAll('.magnetic').forEach((el) => {
      let raf = 0
      const reset = () => {
        el.style.transform = ''
      }
      el.addEventListener('mousemove', (event) => {
        if (raf) cancelAnimationFrame(raf)
        raf = requestAnimationFrame(() => {
          const rect = el.getBoundingClientRect()
          const x = event.clientX - rect.left - rect.width / 2
          const y = event.clientY - rect.top - rect.height / 2
          const dx = (x / rect.width) * 10
          const dy = (y / rect.height) * 10
          el.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`
        })
      })
      el.addEventListener('mouseleave', reset)
    })
  }

  function setupParallax() {
    const elements = Array.from(document.querySelectorAll('.parallax'))
    if (!elements.length) return

    const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    const target = { x: pointer.x, y: pointer.y }

    const animate = () => {
      pointer.x += (target.x - pointer.x) * 0.08
      pointer.y += (target.y - pointer.y) * 0.08
      const cx = pointer.x - window.innerWidth / 2
      const cy = pointer.y - window.innerHeight / 2

      elements.forEach((el) => {
        const depth = Number(el.dataset.depth || 0)
        const moveX = (cx / window.innerWidth) * 36 * depth
        const moveY = (cy / window.innerHeight) * 36 * depth
        el.style.transform = `translate3d(${moveX.toFixed(2)}px, ${moveY.toFixed(2)}px, 0)`
      })

      requestAnimationFrame(animate)
    }

    window.addEventListener('mousemove', (event) => {
      target.x = event.clientX
      target.y = event.clientY
    }, { passive: true })

    window.addEventListener('touchmove', (event) => {
      const touch = event.touches?.[0]
      if (!touch) return
      target.x = touch.clientX
      target.y = touch.clientY
    }, { passive: true })

    animate()
  }

  function setupInteractiveBackground() {
    const canvas = byId('scene-bg')
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    const state = {
      width: 0,
      height: 0,
      mouseX: -1000,
      mouseY: -1000,
      stars: [],
      drift: 0,
      lines: []
    }

    const mobile = window.matchMedia('(max-width: 820px)').matches
    const count = mobile ? 68 : 138

    const random = (min, max) => min + Math.random() * (max - min)

    function resize() {
      state.width = canvas.width = window.innerWidth
      state.height = canvas.height = window.innerHeight
      if (!state.stars.length) {
        for (let i = 0; i < count; i += 1) {
          state.stars.push({
            x: random(0, state.width),
            y: random(0, state.height),
            vx: random(-0.14, 0.14),
            vy: random(-0.14, 0.14),
            size: random(0.6, 2.1),
            alpha: random(0.12, 0.68)
          })
        }
      }
      if (!state.lines.length) {
        const lineCount = mobile ? 10 : 22
        for (let i = 0; i < lineCount; i += 1) {
          state.lines.push({
            x: random(0, state.width),
            y: random(0, state.height),
            length: random(90, 220),
            angle: random(0, Math.PI),
            speed: random(0.001, 0.004)
          })
        }
      }
    }

    function render() {
      const { width, height } = state
      ctx.clearRect(0, 0, width, height)

      state.drift += 0.0023

      const radial = ctx.createRadialGradient(state.mouseX, state.mouseY, 28, state.mouseX, state.mouseY, 420)
      radial.addColorStop(0, 'rgba(187,145,255,0.17)')
      radial.addColorStop(1, 'rgba(187,145,255,0)')
      ctx.fillStyle = radial
      ctx.fillRect(0, 0, width, height)

      state.lines.forEach((line) => {
        line.angle += line.speed
        const x2 = line.x + Math.cos(line.angle) * line.length
        const y2 = line.y + Math.sin(line.angle) * line.length
        ctx.beginPath()
        ctx.moveTo(line.x, line.y)
        ctx.lineTo(x2, y2)
        ctx.strokeStyle = 'rgba(170,130,255,0.08)'
        ctx.lineWidth = 1
        ctx.stroke()
      })

      state.stars.forEach((star) => {
        const dx = star.x - state.mouseX
        const dy = star.y - state.mouseY
        const dist = Math.hypot(dx, dy)
        if (dist < 145) {
          const f = (145 - dist) / 145
          star.vx += (dx / (dist + 0.1)) * f * 0.028
          star.vy += (dy / (dist + 0.1)) * f * 0.028
        }

        star.vx *= 0.985
        star.vy *= 0.985
        star.x += star.vx
        star.y += star.vy

        if (star.x < -20) star.x = width + 20
        if (star.x > width + 20) star.x = -20
        if (star.y < -20) star.y = height + 20
        if (star.y > height + 20) star.y = -20

        ctx.beginPath()
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(198, 154, 255, ${star.alpha})`
        ctx.fill()
      })

      requestAnimationFrame(render)
    }

    window.addEventListener('mousemove', (event) => {
      state.mouseX = event.clientX
      state.mouseY = event.clientY
    }, { passive: true })

    window.addEventListener('touchmove', (event) => {
      const touch = event.touches?.[0]
      if (!touch) return
      state.mouseX = touch.clientX
      state.mouseY = touch.clientY
    }, { passive: true })

    window.addEventListener('resize', resize, { passive: true })
    resize()
    render()
  }

  function setupHeroMicroMotion() {
    const chips = byId('hero-chip-cloud')
    if (!chips) return
    const entries = Array.from(chips.querySelectorAll('i'))
    entries.forEach((chip, index) => {
      chip.style.animation = `lineRise 0.58s cubic-bezier(.2,.8,.2,1) ${0.26 + index * 0.03}s both`
    })
  }

  loadPricing()
  setupPurchaseToast()
  renderModuleUI('crystal')
  setupModuleAutoplay()
  setupReveal()
  setupTopNavMotion()
  setupTilt()
  setupMagnetic()
  setupParallax()
  setupInteractiveBackground()
  setupHeroMicroMotion()
  syncTopbarAuth()
})()
