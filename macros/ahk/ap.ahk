#SingleInstance Force
SendMode "Input"

anchorKey    := A_Args[1]
glowstoneKey := A_Args[2]
explodeKey   := A_Args[3]
pearlKey     := A_Args[4]
delay        := Integer(A_Args[5])

detonateKey := (explodeKey != "None") ? explodeKey : anchorKey

; ── Full Single Anchor sequence ─────────────────────────────────────────
Send("{" anchorKey "}")
Sleep(delay)
Click("right")
Sleep(delay)

Send("{" glowstoneKey "}")
Sleep(delay)
Click("right")
Sleep(delay)
Click("right")
Sleep(delay)

Send("{" detonateKey "}")
Sleep(delay)
Click("right")
Sleep(delay)

; ── Immediately pearl for low ground ────────────────────────────────────
Send("{" pearlKey "}")
Sleep(delay)
Click("right")
