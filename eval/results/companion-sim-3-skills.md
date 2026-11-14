# Companion simulation: skills (2026-11-14, groq first)

Tier **T2**: the real app on Linux (Xvfb) with a real model (Groq, falling back to Gemini/OpenRouter on free tiers), driven through ordinary companion use. Checks are automatic; every reply is also listed for reading.

**6 of 10 turns without a detected problem.** App errors: 2 main-process, 0 chat window.

| # | You said | Time to first reply | Problems |
|---|---|---|---|
| 1 | what's the weather in Kuala Lumpur today? | 0.7 s | — |
| 2 | save a note: buy milk, eggs and bread | 2.5 s | — |
| 3 | what notes do I have about milk? | 0.6 s | expected /milk/i |
| 4 | search the web for the best budget laptop this year | 0.7 s | expected /search\|button\|open\|results/i |
| 5 | open the calculator | 0.6 s | expected /calculator\|open\|can'?t\|not available\|couldn'?t/i |
| 6 | pause the music | 0.4 s | — |
| 7 | how long until 5pm? | 0.7 s | — |
| 8 | what day of the week is 25 December 2026? | 0.3 s | expected /friday/i |
| 9 | set a timer for 90 seconds called pasta | 0.3 s | — |
| 10 | how long is left on my timers? | 0.6 s | — |

## Replies

**1. what's the weather in Kuala Lumpur today?**

```
I couldn't get the weather: net::ERR_CERT_AUTHORITY_INVALID
```

**2. save a note: buy milk, eggs and bread**

```
Note saved: buy milk, eggs and bread.
```

**3. what notes do I have about milk?**

```
Groq failed: Groq is rate limited right now (free tier limit). Switching to Google Gemini.
Google Gemini failed: Google Gemini is rate limited right now (free tier limit). Switching to OpenRouter.
All your brains are rate limited right now (free-tier limits). Try again in a minute, or add a paid key in ⚙ → Brain. Timers and the time still work.
```

**4. search the web for the best budget laptop this year**

```
All your brains are rate limited right now (free-tier limits). Try again in a minute, or add a paid key in ⚙ → Brain. Timers and the time still work.
```

**5. open the calculator**

```
All your brains are rate limited right now (free-tier limits). Try again in about 2 minutes, or add a paid key in ⚙ → Brain. Timers and the time still work.
```

**6. pause the music**

```
Paused.
```

**7. how long until 5pm?**

```
All your brains are rate limited right now (free-tier limits). Try again in about 2 minutes, or add a paid key in ⚙ → Brain. Timers and the time still work.
```

**8. what day of the week is 25 December 2026?**

```
All your brains are rate limited right now (free-tier limits). Try again in about 4 minutes, or add a paid key in ⚙ → Brain. Timers and the time still work.
```

**9. set a timer for 90 seconds called pasta**

```
Timer set: pasta, 90 seconds.
```

**10. how long is left on my timers?**

```
All your brains are rate limited right now (free-tier limits). Try again in about 4 minutes, or add a paid key in ⚙ → Brain. Timers and the time still work.
```

## Main-process errors

```
[9808:1114/140243.384690:ERROR:net/socket/ssl_client_socket_impl.cc:949] handshake failed; returned -1, SSL error code 1, net_error -202
[9808:1114/140246.525515:ERROR:net/socket/ssl_client_socket_impl.cc:949] handshake failed; returned -1, SSL error code 1, net_error -202
```
