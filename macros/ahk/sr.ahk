#SingleInstance Force

delay := Integer(A_Args[1])

Jitter(ms) {
    variance := ms * 0.06
    return ms + Round(Random(-variance, variance))
}

Click("left")
Sleep(Jitter(delay))
Send("{w down}")
Sleep(Jitter(15))
Send("{w up}")
Sleep(Jitter(15))
Send("{w down}")
Sleep(Jitter(15))
Send("{w up}")
