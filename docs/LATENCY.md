# Response times

Measured 2026-11-12 09:57 UTC by `node scripts/benchmark-latency.js` on Intel(R) Xeon(R) Processor @ 2.10GHz (4 threads), 5 runs each. Real components: COre's Whisper and Kokoro workers, its provider code against the live APIs. Targets: docs/dev/PLAN-12.1.md.

- You stop talking → COre reacts: **600 ms** (target ≤ 300 ms)
- You stop talking → first word (fastest brain, sequential today): **3330 ms** (target ≤ 1000 ms) = wait 600 + recognition 687 + brain 598 + voice 1445

| Step | p50 | p95 |
|---|---|---|
| Voice: first sentence (Kokoro q4, warm) | 1445 ms | 1710 ms |
| Voice: first clause, ~5 words (warm) | 607 ms | 686 ms |
| Speech recognition, 3.3 s question (Whisper base, warm) | 687 ms | 729 ms |
| Brain first words: Groq (openai/gpt-oss-120b) | 598 ms | 887 ms |
| Brain first words: Gemini (gemini-3-flash-preview) | 3037 ms | 3037 ms |
| End-of-turn wait (silence rule: 6 × 100 ms) | 600 ms | 600 ms |

Cold starts (first use after launch): voice 1670 ms, recognition 3299 ms.
