# Companion simulation: outage (2026-11-14, groq first)

Tier **T2**: the real app on Linux (Xvfb) with a real model (Groq, falling back to Gemini/OpenRouter on free tiers), driven through ordinary companion use. Checks are automatic; every reply is also listed for reading.

**5 of 5 turns without a detected problem.** App errors: 1 main-process, 0 chat window.

| # | You said | Time to first reply | Problems |
|---|---|---|---|
| 1 | hi COre, are you there? | 1.9 s | — |
| 2 | hello? anyone? | 0.3 s | — |
| 3 | what time is it? | 0.3 s | — |
| 4 | set a timer for 90 seconds called pasta | 0.3 s | — |
| 5 | hello again | 0.3 s | — |

## Replies

**1. hi COre, are you there?**

```
Groq failed: Groq is rate limited right now (free tier limit). Switching to Google Gemini.
Google Gemini failed: Google Gemini is rate limited right now (free tier limit). Switching to OpenRouter.
All your brains are rate limited right now (free-tier limits). Try again in a minute, or add a paid key in ⚙ → Brain. Timers, reminders and the time still work.
```

**2. hello? anyone?**

```
All your brains are rate limited right now (free-tier limits). Try again in a minute, or add a paid key in ⚙ → Brain. Timers, reminders and the time still work.
```

**3. what time is it?**

```
It's 1:57 PM.
```

**4. set a timer for 90 seconds called pasta**

```
Timer set: pasta, 90 seconds.
```

**5. hello again**

```
All your brains are rate limited right now (free-tier limits). Try again in a minute, or add a paid key in ⚙ → Brain. Timers, reminders and the time still work.
```

## Main-process errors

```
[7999:1114/135739.430186:ERROR:net/socket/ssl_client_socket_impl.cc:949] handshake failed; returned -1, SSL error code 1, net_error -202
```
