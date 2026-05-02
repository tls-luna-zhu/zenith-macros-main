#SingleInstance Force

axeKey   := A_Args[1]
swordKey := A_Args[2]
delay    := Integer(A_Args[3])

Jitter(ms) {
    variance := ms * 0.06
    return ms + Round(Random(-variance, variance))
}

Send("{" axeKey " down}")
Sleep(Jitter(15))
Send("{" axeKey " up}")
Sleep(Jitter(delay))
Click("left")
Sleep(Jitter(delay))
Send("{" swordKey " down}")
Sleep(Jitter(15))
Send("{" swordKey " up}")
