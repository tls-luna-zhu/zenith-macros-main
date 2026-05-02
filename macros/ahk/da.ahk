#SingleInstance Force
SendMode "Input"

anchorKey    := A_Args[1]
glowstoneKey := A_Args[2]
explodeKey   := A_Args[3]
delay        := Integer(A_Args[4])

detonateKey := (explodeKey != "None") ? explodeKey : anchorKey

; ── Run one complete anchor cycle ───────────────────────────────────────
RunAnchor() {
    global anchorKey, glowstoneKey, detonateKey, delay
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
}

; ── First anchor then second immediately after ──────────────────────────
RunAnchor()
RunAnchor()
