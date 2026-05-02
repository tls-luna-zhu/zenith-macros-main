#SingleInstance Force
SendMode "Input"

inventoryKey := A_Args[1]  ; the key that opens inventory (same as the macro keybind)
totemKey     := A_Args[2]  ; hotbar slot holding the totem
swapKey      := A_Args[3]  ; offhand swap key (default F)
delay        := Integer(A_Args[4])

; ── Switch to totem hotbar slot ──────────────────────────────────────────
Send("{" totemKey "}")
Sleep(delay)

; ── Swap totem into offhand ──────────────────────────────────────────────
Send("{" swapKey "}")
Sleep(delay)

; ── Re-send the inventory key so Minecraft actually opens the inventory ──
; (Electron's globalShortcut consumed the original keypress)
Send("{" inventoryKey "}")
