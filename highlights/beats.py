#!/usr/bin/env python3
"""Tempo, beat grid and likely drops of a track, for cutting the reel to music.

  ./beats.py track.wav
"""
import subprocess, sys
import numpy as np

SR, HOP, WIN = 11025, 128, 1024
x = np.frombuffer(subprocess.run(['ffmpeg', '-v', 'error', '-i', sys.argv[1], '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
                                 capture_output=True, check=True).stdout, dtype=np.float32)
fps = SR / HOP

# Spectral-flux onset envelope, then autocorrelation for the tempo (checked at 1x, 2x and 4x the beat).
spec = np.array([np.abs(np.fft.rfft(x[i:i + WIN] * np.hanning(WIN))) for i in range(0, len(x) - WIN, HOP)])
flux = np.maximum(0, np.diff(np.log1p(spec), axis=0)).sum(1)
flux -= flux.mean()
ac = np.correlate(flux, flux, 'full')[len(flux) - 1:]
bpms = np.arange(70, 180, 0.05)
bpm = bpms[np.argmax([sum(ac[int(round(k * 60 * fps / b))] for k in (1, 2, 4)) for b in bpms])]
if bpm < 100: bpm *= 2  # ponytail: assumes a fast track; halve it by hand for a slow one
period = 60 / bpm * fps
phase = max(np.arange(0, period, 0.25), key=lambda o: flux[np.round(np.arange(o, len(flux) - 1, period)).astype(int)].sum())
print(f'bpm {bpm:.2f}  beat {60 / bpm:.4f}s  first beat {phase / fps:.3f}s')

# Loudness per 0.25s. A drop = a dip of 8+ dB followed by a jump back up within a second.
q = int(SR * 0.25)
db = 20 * np.log10(np.sqrt((x[:len(x) // q * q].reshape(-1, q) ** 2).mean(1)) + 1e-9)
print('loudness per 2s:', ' '.join(f'{i * 2}:{v:.0f}' for i, v in enumerate(db[:len(db) // 8 * 8].reshape(-1, 8).mean(1))))
for i in range(4, len(db) - 4):
    if db[i] < db[i - 4:i].mean() - 8 and db[i] == db[i - 2:i + 3].min() and db[i + 1:i + 5].max() > db[i - 4:i].mean():
        # exact hit: first 5ms block after the dip that reaches a quarter of the following peak
        seg = x[int(i * 0.25 * SR):int((i + 4) * 0.25 * SR)]
        h = int(SR * 0.005)
        e = np.sqrt((seg[:len(seg) // h * h].reshape(-1, h) ** 2).mean(1))
        start = int(np.argmin(e))
        print(f'drop at {i * 0.25 + (start + np.argmax(e[start:] > 0.25 * e.max())) * 0.005:.2f}s')
