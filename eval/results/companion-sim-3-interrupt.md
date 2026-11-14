# Companion simulation: interrupt (2026-11-14, groq first)

Tier **T2**: the real app on Linux (Xvfb) with a real model (Groq, falling back to Gemini/OpenRouter on free tiers), driven through ordinary companion use. Checks are automatic; every reply is also listed for reading.

**5 of 5 turns without a detected problem.** App errors: 1 main-process, 0 chat window.

| # | You said | Time to first reply | Problems |
|---|---|---|---|
| 1 | write me a 600-word story about a dragon who loves tea | 2.5 s | — |
| 2 | actually, stop that. just tell me a one-line joke instead | 1.1 s | — |
| 3 | what was the last thing I asked you for? | 0.6 s | — |
| 4 | explain quantum computing in detail | 1.2 s | — |
| 5 | never mind. what is 9 plus 10? | 1.0 s | — |

## Replies

**1. write me a 600-word story about a dragon who loves tea**

```

```

**2. actually, stop that. just tell me a one-line joke instead**

```
Okay. I told my computer a joke, but it didn't byte.
```

**3. what was the last thing I asked you for?**

```
Sure. You asked me for a one‑line joke.
```

**4. explain quantum computing in detail**

```
Quantum Computing – A (somewhat) Detailed Overview

---

1. The Basics

| Classical Bit | Quantum Bit (Qubit) | |---------------|----------------------| | Holds 0 or 1 | Can be |0⟩, |1⟩, or any superposition α|0⟩ + β|1⟩ (|α|² + |β|² = 1) | | Deterministic state | Probabilistic until measured | | Simple Boolean logic | Operations are unitary (reversible) transformations |

A qubit’s ability to be in multiple states simultaneously is the source of the much‑hyped “parallelism”.

---

2. Core Quantum Phenomena

| Phenomenon | What It Means | Why It Matters | |------------|---------------|----------------| | Superposition | A qubit can occupy a combination of basis states. | Enables exponential state space (2ⁿ for n qubits). | | Entanglement | Qubits become correlated such that the state of one instantly determines
```

**5. never mind. what is 9 plus 10?**

```
Right. Nine plus ten is nineteen.
```

## Main-process errors

```
[1022:1114/132454.513494:ERROR:net/socket/ssl_client_socket_impl.cc:949] handshake failed; returned -1, SSL error code 1, net_error -202
```
