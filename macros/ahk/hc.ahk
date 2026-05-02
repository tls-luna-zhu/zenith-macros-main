#SingleInstance Force
SendMode "Input"

crystalKey  := A_Args[1]
obsidianKey := A_Args[2]
delay       := Integer(A_Args[3])

; ── Place obsidian ───────────────────────────────────────────────────────
Send("{" obsidianKey "}")
Sleep(delay)
Click("right")
Sleep(delay)

; ── Place crystal on the obsidian ────────────────────────────────────────
Send("{" crystalKey "}")
Sleep(delay)
Click("right")
Sleep(delay)

; ── Hit the crystal to detonate it ───────────────────────────────────────
Click("left")
