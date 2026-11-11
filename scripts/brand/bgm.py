#!/usr/bin/env python3
"""Synthesises COre's promo music from scratch (no samples): 120 BPM, A minor.

  python3 scripts/brand/bgm.py promo out.wav     # 30 s, cut to the promo video
  python3 scripts/brand/bgm.py bed out.wav 90.3  # a calm bed for the demo video

Promo structure (bars are 2 s): 0-4 s intro (pad, arp, riser), drop at 4 s,
full groove to 24 s, a bar without drums and a riser, final hit at 26 s, tail.
"""
import sys
import wave
import numpy as np

SR = 44100
BPM = 120
BEAT = 60 / BPM
rng = np.random.default_rng(11)

CHORDS = [  # root (bass), chord tones; Am F C G
    (45, [57, 60, 64]), (41, [57, 60, 65]), (48, [55, 60, 64]), (43, [55, 59, 62]),
]


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def lowpass(x, cutoff):
    n = max(3, int(SR / cutoff) | 1)
    k = np.hanning(n)
    return np.convolve(x, k / k.sum(), mode='same')


def saw(f, n, phase=0.0):
    t = np.arange(n) / SR
    return 2 * ((f * t + phase) % 1) - 1


def add(buf, sig, at, gain=1.0):
    i = int(at * SR)
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[: j - i] * gain


def kick():
    n = int(0.32 * SR)
    t = np.arange(n) / SR
    f = 46 + 110 * np.exp(-t * 38)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9) + 0.25 * rng.standard_normal(n) * np.exp(-t * 180)


def clap():
    n = int(0.22 * SR)
    t = np.arange(n) / SR
    x = rng.standard_normal(n)
    x = lowpass(x, 5200) - lowpass(x, 900)
    env = np.exp(-t * 26) + 0.6 * np.exp(-np.abs(t - 0.012) * 400) + 0.5 * np.exp(-np.abs(t - 0.024) * 400)
    return x * env


def hat(open_=False):
    n = int((0.18 if open_ else 0.05) * SR)
    t = np.arange(n) / SR
    x = rng.standard_normal(n)
    return (x - lowpass(x, 7000)) * np.exp(-t * (22 if open_ else 90))


def pluck(m, dur=0.22):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = 0.6 * saw(hz(m), n) + 0.4 * np.sign(np.sin(2 * np.pi * hz(m) * t))
    return lowpass(x, 3800) * np.exp(-t * 16)


def bass_note(m, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = 0.7 * lowpass(saw(hz(m), n), 520) + 0.8 * np.sin(2 * np.pi * hz(m) * t)
    env = np.minimum(1, t * 200) * np.exp(-t * 5)
    return x * env


def pad_chord(notes, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for m in notes:
        for det in (-0.07, 0.0, 0.07):
            x += saw(hz(m + det), n, rng.random())
    x = lowpass(x, 1500) / 9
    env = np.minimum(1, t / 0.5) * np.minimum(1, (dur - t) / 0.3)
    return x * env


def riser(dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    p = t / dur
    noise = rng.standard_normal(n)
    noise = noise - lowpass(noise, 1200)
    sweep = np.sin(2 * np.pi * np.cumsum(180 * 2 ** (p * 3.6)) / SR)
    return (0.5 * noise + 0.35 * sweep) * p ** 2.2


def impact():
    n = int(2.6 * SR)
    t = np.arange(n) / SR
    boom = np.sin(2 * np.pi * np.cumsum(38 + 60 * np.exp(-t * 14)) / SR) * np.exp(-t * 2.2)
    crash = rng.standard_normal(n)
    crash = (crash - lowpass(crash, 2500)) * np.exp(-t * 2.8)
    return boom + 0.35 * crash


def echo(x, delay=BEAT * 0.75, fb=0.38, n=4):
    out = x.copy()
    d = int(delay * SR)
    for i in range(1, n + 1):
        out[i * d:] += x[: len(x) - i * d] * fb ** i
    return out


def master(mix, peak=0.89):
    mix = np.tanh(mix * 1.15)
    return mix / np.max(np.abs(mix)) * peak


def make(dur, drums_from, drums_to, hits, risers, calm=False):
    n = int(dur * SR)
    t = np.arange(n) / SR
    drums = np.zeros(n); bass = np.zeros(n); pad = np.zeros(n); arp = np.zeros(n); fx = np.zeros(n)
    K, C, H, HO = kick(), clap(), hat(), hat(True)
    bars = int(np.ceil(dur / (4 * BEAT)))
    for bar in range(bars):
        t0 = bar * 4 * BEAT
        root, tones = CHORDS[bar % 4]
        add(pad, pad_chord(tones + [tones[0] + 12], 4 * BEAT + 0.3), t0, 0.5 if calm else 0.42)
        groove = drums_from <= t0 < drums_to
        seq = [tones[0] + 12, tones[1] + 12, tones[2] + 12, tones[1] + 12]
        for s in range(16):
            ts = t0 + s * BEAT / 4
            if calm and s % 2:
                continue
            if not calm and not groove and s % 2 and t0 < drums_from:
                continue  # sparse intro
            add(arp, pluck(seq[s % 4] + (12 if (s // 4) % 2 and not calm else 0)), ts, 0.26 if groove else 0.2)
        if not groove:
            continue
        for b in range(4):
            tb = t0 + b * BEAT
            add(drums, K, tb, 0.42 if calm else 1.0)
            add(drums, H, tb + BEAT / 2, 0.12 if calm else 0.3)
            if not calm:
                add(drums, H, tb + BEAT / 4, 0.14)
                add(drums, H, tb + 3 * BEAT / 4, 0.14)
                if b in (1, 3):
                    add(drums, C, tb, 0.55)
                if b == 3:
                    add(drums, HO, tb + BEAT / 2, 0.2)
            for e in range(2):
                add(bass, bass_note(root - 12 if not calm else root, BEAT / 2), tb + e * BEAT / 2 + (BEAT / 4 if not calm else 0), 0.55 if not calm else 0.3)
    for at, d in risers:
        add(fx, riser(d), at - d, 0.55)
    for at in hits:
        add(fx, impact(), at, 0.9)
    arp = echo(arp)
    # sidechain: everything ducks under the kick while the groove plays
    duck = np.ones(n)
    g = (t >= drums_from) & (t < drums_to)
    duck[g] = 1 - (0.25 if calm else 0.62) * np.exp(-((t[g] - drums_from) % BEAT) / 0.11)
    mix = drums + (bass * 0.9 + pad + arp) * duck + fx
    fade = np.minimum(1, t / 0.05) * np.minimum(1, (dur - t) / (3.0 if calm else 1.4))
    mix = master(mix * fade)
    # a little stereo width: the arp and pad lean left/right through a tiny delay
    side = np.zeros(n)
    d = int(0.012 * SR)
    side[d:] = ((arp + pad * 0.6) * duck * fade)[:-d] * 0.18
    return np.stack([np.clip(mix + side, -1, 1), np.clip(mix - side, -1, 1)], axis=1)


def write(path, st):
    pcm = (st * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm.tobytes())


if __name__ == '__main__':
    kind, out = sys.argv[1], sys.argv[2]
    if kind == 'promo':
        st = make(30.0, drums_from=4.0, drums_to=24.0, hits=[4.0, 26.0], risers=[(4.0, 1.6), (26.0, 2.0)])
    else:
        d = float(sys.argv[3])
        st = make(d, drums_from=3.0, drums_to=d - 4.0, hits=[3.0], risers=[(3.0, 1.2)], calm=True)
    write(out, st)
    print(f'{out}: {len(st) / SR:.1f} s')
