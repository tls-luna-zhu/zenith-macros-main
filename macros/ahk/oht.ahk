#SingleInstance Force

totemKey := A_Args[1]
swapKey  := A_Args[2]
delay    := Integer(A_Args[3])

Jitter(ms) {
    variance := ms * 0.06
    return ms + Round(Random(-variance, variance))
}

Send("{" totemKey " down}")
Sleep(Jitter(15))
Send("{" totemKey " up}")
Sleep(Jitter(delay))
Send("{" swapKey " down}")
Sleep(Jitter(15))
Send("{" swapKey " up}")
