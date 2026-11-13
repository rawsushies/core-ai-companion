# Simulations v1 (2026-11-13)

Tier **T1/T2**: the real COre code (policy engine, agent loop, mission engine, journal,
FileOps, the phone server over HTTP), driven by scripted or randomized "models". No real
model and no real phone are involved, so these results prove the safety mechanics, not
autonomy. Every simulation is seeded (`SIM_SEED`, `SIM_N`) and runs in `npm test`.

| Simulation | Size | Result | Bug found and fixed |
|---|---|---|---|
| `test/sim.policy-fuzz.test.js`: random actions × grants × taint through the real policy | 25,000 decisions over 5 seeds | 0 invariant failures after the fix (51 before) | **Injection bypass:** an address or host taken from an untrusted document passed when the agent typed it inside a sentence, changed its case, or put it inside a command. Recipients and hosts are now extracted from typed text and command lines, and each one is taint-checked on its own. |
| `test/sim.stop-race.test.js`: stops fired at random moments against the agent loop and the mission engine | 2 × 60 runs per seed, 3 seeds | Always settles within 200 ms; agent always freed; no action **starts** after a stop | none (a step already running when the stop arrives still finishes) |
| `test/sim.rogue-phone.test.js`: replays (also across a PC restart), wrong keys, unpaired devices, broken, oversized and random bodies, stale counters and clocks | 300 hostile messages | 0 reach a handler, no 5xx, the real phone keeps working | **Replay after restart:** phone counters were saved at most once a minute, so after a COre restart a recorded message could be accepted again. Counters are now saved and flushed after every acting message. **Oversized upload:** the server answered 413 but kept the socket open; it now closes it. |
| `test/sim.noisy-model.test.js`: missions driven by an unreliable model (false "done" claims, failures, errors, questions, step bursts) | 400 missions | 317 of 317 false "done" claims caught by the file checks; no subgoal tried more than twice; budgets held | none |
| `test/recovery.test.js`: SIGKILL at random moments (existing) plus a torn-manifest case | 5 kills + 1 | passes | **Undo after a crash:** the undo manifest was rewritten in place, so a crash mid-write could leave it torn and make `/mission undo` impossible. It is now written atomically, and undo removes cut-off `.core-tmp` files. |

Also found (not changed before the v13.0.0 test): on a small screen (here 1280×800) a fifth
specialist cannot open ("No free spot on the screen for Archivist") and the message is
answered by COre instead. CI uses 1600×900 and passes 43/43 e2e.
