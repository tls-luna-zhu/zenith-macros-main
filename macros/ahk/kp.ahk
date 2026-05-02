#SingleInstance Force
SendMode "Input"

pearlKey  := A_Args[1]
returnKey := A_Args[2]
delay     := Integer(A_Args[3])

; ── Switch to pearl slot ─────────────────────────────────────────────────
Send("{" pearlKey "}")
Sleep(delay)

; ── Throw the pearl ──────────────────────────────────────────────────────
Click("right")
Sleep(delay)

; ── Return to previous slot ──────────────────────────────────────────────
Send("{" returnKey "}")
