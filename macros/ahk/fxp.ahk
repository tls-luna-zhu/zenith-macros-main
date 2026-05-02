#SingleInstance Force

fxpKey := A_Args[1]
delay  := Integer(A_Args[2])

Jitter(ms) {
    variance := ms * 0.06
    return ms + Round(Random(-variance, variance))
}

; Right-click spam while the key is physically held down.
; GetKeyState(..., "P") reads raw hardware state — works even though
; Electron's globalShortcut intercepts the logical keypress.
while GetKeyState(fxpKey, "P") {
    if RegExMatch(WinGetTitle("A"), "i)Minecraft") {
        Click("right")
    }
    Sleep(Jitter(delay))
}
