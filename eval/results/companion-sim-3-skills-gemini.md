# Companion simulation: skills (2026-11-14, gemini first)

Tier **T2**: the real app on Linux (Xvfb) with a real model (Groq, falling back to Gemini/OpenRouter on free tiers), driven through ordinary companion use. Checks are automatic; every reply is also listed for reading.

**10 of 10 turns without a detected problem.** App errors: 2 main-process, 0 chat window.

| # | You said | Time to first reply | Problems |
|---|---|---|---|
| 1 | what's the weather in Kuala Lumpur today? | 0.4 s | — |
| 2 | save a note: buy milk, eggs and bread | 3.1 s | — |
| 3 | what notes do I have about milk? | 0.7 s | — |
| 4 | search the web for the best budget laptop this year | 0.7 s | — |
| 5 | open the calculator | 0.3 s | — |
| 6 | pause the music | 0.4 s | — |
| 7 | how long until 5pm? | 1.2 s | — |
| 8 | what day of the week is 25 December 2026? | 1.2 s | — |
| 9 | set a timer for 90 seconds called pasta | 0.3 s | — |
| 10 | how long is left on my timers? | 0.3 s | — |

## Replies

**1. what's the weather in Kuala Lumpur today?**

```
I couldn't get the weather: net::ERR_CERT_AUTHORITY_INVALID
```

**2. save a note: buy milk, eggs and bread**

```
Sure. I have committed your culinary ambitions to memory. It is truly a thrilling list. Try not to let the excitement of basic groceries overwhelm you.
Noted: buy milk, eggs and bread
```

**3. what notes do I have about milk?**

```
Google Gemini failed: Google Gemini is rate limited right now (free tier limit). Switching to Groq.
note query: milk

Here are your notes that mention milk:

buy milk, eggs and bread
```

**4. search the web for the best budget laptop this year**

```
Sure, give me a moment.

[skill] search: best budget laptop 2024Right. Here’s a quick rundown of the top‑rated budget laptops of 2024, based on recent reviews and price‑performance charts:

Acer Aspire 5 A515‑57: 15.6″ Full HD, Intel Core i5‑1235U, 8 GB RAM, 512 GB SSD, around $549.
Lenovo IdeaPad 3 14ITL6: 14″ Full HD, Intel Core i5‑1235U, 8 GB RAM, 256 GB SSD, about $479.
HP Pavilion 14‑dv2074nr: 14″ Full HD, AMD Ryzen 5 7530U, 8 GB RAM, 512 GB SSD, roughly $529.
Dell Inspiron 15 5510: 15.6″ Full HD, Intel Core i5‑1240P, 8 GB RAM, 256 GB SSD, near $579.
ASUS VivoBook 15 X1504VA: 15.6″ Full HD, Intel Core i5‑1335U, 8 GB RAM, 512 GB SSD, about $549.

All of these hover around the $500‑$600 mark, offering solid performance for everyday tasks, decent battery life, and respectable build quality. If you need a specific recommendation—say, the best value for a student or the lightest option—just let me know.
```

**5. open the calculator**

```
Groq failed: Groq is rate limited right now (free tier limit). Switching to OpenRouter.
All your brains are rate limited right now (free-tier limits). Try again in a minute, or add a paid key in ⚙ → Brain. Timers and the time still work.
```

**6. pause the music**

```
Paused.
```

**7. how long until 5pm?**

```
You have exactly fifty-four minutes of freedom remaining before five o'clock arrives. I assume that is when your next scheduled bout of productivity or existential dread begins.
```

**8. what day of the week is 25 December 2026?**

```
December 25, 2026, falls on a Friday. It should be a lovely day to find out if you were actually on the nice list this year. I wouldn't hold my breath.
```

**9. set a timer for 90 seconds called pasta**

```
Timer set: pasta, 90 seconds.
```

**10. how long is left on my timers?**

```
pasta: 1 minutes left.
```

## Main-process errors

```
[2751:1114/160552.832047:ERROR:net/socket/ssl_client_socket_impl.cc:949] handshake failed; returned -1, SSL error code 1, net_error -202
[2751:1114/160555.357123:ERROR:net/socket/ssl_client_socket_impl.cc:949] handshake failed; returned -1, SSL error code 1, net_error -202
```
