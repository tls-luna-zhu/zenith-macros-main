#SingleInstance Force
SendMode "Input"

anchorKey    := A_Args[1]
glowstoneKey := A_Args[2]
explodeKey   := A_Args[3]
delay        := Integer(A_Args[4])

; If no dedicated explode key, switch back to the anchor slot —
; right-clicking with any non-glowstone item detonates a charged anchor.
detonateKey := (explodeKey != "None") ? explodeKey : anchorKey

; ── Switch to anchor and place ──────────────────────────────────────────
Send("{" anchorKey "}")
Sleep(delay)
Click("right")
Sleep(delay)

; ── Switch to glowstone and charge x2 ───────────────────────────────────
Send("{" glowstoneKey "}")
Sleep(delay)
Click("right")
Sleep(delay)
Click("right")
Sleep(delay)

; ── Switch AWAY from glowstone, then detonate ───────────────────────────
; IMPORTANT: must leave glowstone slot before this click or it adds a 3rd charge
Send("{" detonateKey "}")
Sleep(delay)
Click("right")
