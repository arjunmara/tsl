#!/usr/bin/env python3
""""League starts Saturday" teaser: training clips + cards cut to the beat of "Hall Of Legends".

  ./teaser.py            -> TSL_Kickoff_Saturday.mp4
Cards/overlays come from card.html and overlay.html (rendered into teaser/).
"""
import pathlib, subprocess

here = pathlib.Path(__file__).resolve().parent
clips = here.parent / 'clips'
BEAT, FPS = 0.4, 30              # track3.wav "Hall Of Legends": exactly 150 BPM, beats on n * 0.4s
MUSIC_START = 92.0 - 16 * BEAT   # its comeback drop (92.0s) lands 16 beats in, on the first action clip;
                                 # the next drop (111.2s) then lands on the Saturday card
CUT = ('fade', 1 / FPS)          # one-frame "transition" = a hard cut

# (source: clip name or teaser/<png>, start s, beats, overlay png or None, transition into the NEXT segment)
SEGS = [
    ('IMG_2073', 0.5, 8, 'ov-wait', ('fade', .4)),       # wide arena, over the quiet build-up
    ('IMG_2072', 44.0, 8, 'ov-league', ('fadewhite', .2)),
    ('IMG_2065', 23.4, 4, None, CUT),                     # drop: close orange-bib duel
    ('IMG_2072', 21.0, 2, None, CUT),
    ('IMG_2050', 7.0, 2, None, CUT),
    ('IMG_2060', 0.05, 4, None, CUT),
    ('IMG_2065', 3.4, 2, None, CUT),
    ('IMG_2058', 15.2, 2, None, ('smoothleft', .2)),
    ('IMG_2072', 36.3, 4, 'ov-teams', CUT),
    ('IMG_2057', 13.2, 2, None, CUT),
    ('IMG_2050', 3.4, 2, None, CUT),
    ('IMG_2058', 0.2, 4, None, CUT),
    ('IMG_2072', 14.5, 2, None, CUT),
    ('IMG_2058', 65.0, 2, None, ('smoothright', .2)),
    ('IMG_2073', 18.3, 4, 'ov-trophy', CUT),
    ('IMG_2056', 66.8, 2, None, CUT),
    ('IMG_2065', 5.2, 2, None, CUT),
    ('IMG_2072', 12.3, 4, None, CUT),
    ('IMG_2050', 65.2, 2, None, CUT),
    ('IMG_2073', 40.3, 2, None, ('zoomin', .3)),
    ('card-saturday', 0, 8, None, ('fade', .4)),          # Kick-off Saturday · Kartik 14
    ('card-outro', 0, 8, None, None),
]

cuts = [round(sum(s[2] for s in SEGS[:i]) * BEAT * FPS) / FPS for i in range(len(SEGS) + 1)]
half = [0] + [s[4][1] / 2 for s in SEGS[:-1]] + [0]
inputs, chains = [], []
for i, (src, start, _, ov, _) in enumerate(SEGS):
    # +0.1s spare tail: xfade drops whatever runs past the cut, but stops the whole chain if a frame is missing
    dur = cuts[i + 1] - cuts[i] + half[i] + half[i + 1] + 0.1
    if src.startswith('card-'):
        k = round(dur * FPS)
        inputs += ['-loop', '1', '-framerate', str(FPS), '-t', f'{dur:.4f}', '-i', str(here / 'teaser' / f'{src}.png')]
        v = (f"scale=2160:3840,zoompan=z='1+0.06*on/{k}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1080x1920:fps={FPS}")
    else:
        inputs += ['-ss', f'{max(0, start - half[i]):.3f}', '-t', f'{dur:.4f}', '-i', str(clips / f'{src}.MOV')]
        v = f'fps={FPS},scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920'
    idx = sum(1 for a in inputs if a == '-i') - 1
    chains.append(f'[{idx}:v]{v},setsar=1,format=yuv420p,trim=duration={dur:.4f},setpts=PTS-STARTPTS[s{i}]')
    if ov:
        inputs += ['-loop', '1', '-framerate', str(FPS), '-t', f'{dur:.4f}', '-i', str(here / 'teaser' / f'{ov}.png')]
        o = sum(1 for a in inputs if a == '-i') - 1
        chains.append(f'[{o}:v]format=rgba,fade=t=in:st={half[i]:.3f}:d=0.25:alpha=1[o{i}]')
        chains.append(f'[s{i}][o{i}]overlay=0:0:shortest=1,format=yuv420p[v{i}]')
    else:
        chains.append(f'[s{i}]null[v{i}]')
prev = 'v0'
for i, seg in enumerate(SEGS[:-1]):
    name, d = seg[4]
    chains.append(f'[{prev}][v{i + 1}]xfade=transition={name}:duration={d:.4f}:offset={cuts[i + 1] - d / 2:.4f}[x{i}]')
    prev = f'x{i}'
total = cuts[-1]
music = sum(1 for a in inputs if a == '-i')
chains.append(f'[{music}:a]atrim=start={MUSIC_START:.3f}:duration={total:.3f},asetpts=PTS-STARTPTS,'
              f'afade=t=in:d=0.15,afade=t=out:st={total - 1.6:.3f}:d=1.6,loudnorm=I=-14:TP=-1.5[a]')

out = here / 'TSL_Kickoff_Saturday.mp4'
subprocess.run(['ffmpeg', '-v', 'error', '-y', *inputs, '-i', str(here / 'track3.wav'),
                '-filter_complex', ';'.join(chains), '-map', f'[{prev}]', '-map', '[a]',
                '-c:v', 'libx264', '-preset', 'medium', '-b:v', '12M', '-pix_fmt', 'yuv420p', '-r', str(FPS),
                '-c:a', 'aac', '-b:a', '192k', '-t', f'{total:.3f}', '-movflags', '+faststart', str(out)], check=True)
print(out, f'{total:.2f}s', 'cuts:', [round(c, 3) for c in cuts])
