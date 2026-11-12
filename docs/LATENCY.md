# Response times

Measured 2026-11-12 10:00 UTC by `node scripts/benchmark-latency.js` on Intel(R) Xeon(R) Processor @ 2.10GHz (4 threads), 5 runs each. Real components: COre's Whisper and Kokoro workers, its provider code against the live APIs. Targets: docs/dev/PLAN-12.1.md.

- You stop talking → COre reacts: **200 ms** (12.0: 600 ms; target ≤ 300 ms)
- You stop talking → first word: **1549 ms** with an opener, 2204 ms without (12.0: 2704 ms; target ≤ 1000 ms) = recognition done at 680 + brain 869 + voice 0 / 655

| Step | p50 | p95 |
|---|---|---|
| Voice: first sentence (Kokoro q4, warm) | 1673 ms | 1854 ms |
| Voice: first clause, ~5 words (warm) | 655 ms | 770 ms |
| Voice: pre-rendered opener ("Right.") | 0 ms | 0 ms |
| Speech recognition, 3.3 s question (Whisper base, warm) | 580 ms | 632 ms |
| Brain first words: Groq (openai/gpt-oss-120b) | 869 ms | 1160 ms |
| End-of-turn wait (silence rule: 6 × 100 ms) | 600 ms | 600 ms |

Cold starts (first use after launch): voice 1841 ms, recognition 3344 ms.
