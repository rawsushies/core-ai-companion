# Response times

Measured 2026-11-12 10:24 UTC by `node scripts/benchmark-latency.js` on Intel(R) Xeon(R) Processor @ 2.10GHz (4 threads), 6 runs each. Real components: COre's Whisper and Kokoro workers, its provider code against the live APIs. Targets: docs/dev/PLAN-12.1.md.

- You stop talking → COre reacts: **200 ms** (12.0: 600 ms; target ≤ 300 ms)
- COre's own share before the brain answers: **350 ms** (12.0: 1204 ms). The rest is the provider's time to first word, which varies with load and free-tier limits (Groq measured 598–716 ms p50 in earlier runs today, 1073 ms in this rate-limited one).
- You stop talking → first word: **1423 ms** with an opener, 2002 ms without (12.0: 2869 ms; target ≤ 1000 ms) = turn ended on a finished sentence, recognition done at 350 + brain 1073 + voice 0 / 579

| Step | p50 | p95 |
|---|---|---|
| Voice: first sentence (Kokoro q4, warm) | 1479 ms | 1687 ms |
| Voice: first clause, ~5 words (warm) | 579 ms | 651 ms |
| Voice: pre-rendered opener ("Right.") | 0 ms | 0 ms |
| Speech recognition, 3.3 s question (Whisper base, warm) | 617 ms | 719 ms |
| Speech recognition, same question (Moonshine base, warm; English) | 223 ms | 258 ms |
| Brain first words: Groq (openai/gpt-oss-120b) | 1073 ms | 1231 ms |
| End-of-turn wait (silence rule: 6 × 100 ms) | 600 ms | 600 ms |

Cold starts (first use after launch): voice 1655 ms, recognition 3677 ms.
