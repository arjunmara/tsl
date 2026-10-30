#!/usr/bin/env python3
"""Team reveal reel: reveal/*.png cards cut to the phonk track's beat. Render the cards first (see reveal.html).

  ./reveal.py            -> TSL_Team_Reveal.mp4
"""
import glob, pathlib, subprocess

here = pathlib.Path(__file__).resolve().parent
BEAT, FPS = 0.4813, 30          # track2.wav: 124.7 BPM; kick grid = 0.465 + n * BEAT
MUSIC_START = 0.465 + 20 * BEAT  # beat 20, so the drop (beat 28, 13.95s) lands 8 beats in, on team 1
cards = sorted(glob.glob(str(here / 'reveal' / '*.png')))  # 00-hook, 90-grid, 99-outro, team-NN sort into place below
cards = [c for c in cards if '00-hook' in c] + sorted(c for c in cards if '/team-' in c) + \
        [c for c in cards if '90-grid' in c] + [c for c in cards if '99-outro' in c]
beats = [8] + [4] * (len(cards) - 3) + [8, 8]  # hook, one bar per team, grid, outro

# Cut times (seconds, frame-exact) and the transition centred on each cut.
cuts =[round(sum(beats[:i]) * BEAT * FPS) / FPS for i in range(len(beats) + 1)]
team_cuts = len(cards) - 4
trans = [('fadewhite', .2)] + [(('smoothleft', 'smoothright')[i % 2], .2) for i in range(team_cuts)] + [('zoomin', .3), ('fade', .4)]
half = [0] + [d / 2 for _, d in trans] + [0]  # overlap borrowed from each side of every cut

inputs, chains = [], []
for i, card in enumerate(cards):
    dur = cuts[i + 1] - cuts[i] + half[i] + half[i + 1] + 0.1  # spare tail; xfade stops the chain on a missing frame
    n = round(dur * FPS)
    inputs += ['-loop', '1', '-framerate', str(FPS), '-t', f'{n / FPS:.4f}', '-i', card]
    # slow push-in; upscale first so zoompan doesn't jitter
    chains.append(f'[{i}:v]scale=2160:3840,zoompan=z=\'1+0.06*on/{n}\':x=\'iw/2-iw/zoom/2\':y=\'ih/2-ih/zoom/2\':d=1:s=1080x1920:fps={FPS},setsar=1,format=yuv420p[c{i}]')
prev = 'c0'
for i, (name, d) in enumerate(trans):
    chains.append(f'[{prev}][c{i + 1}]xfade=transition={name}:duration={d}:offset={cuts[i + 1] - d / 2:.4f}[x{i}]')
    prev = f'x{i}'
total = cuts[-1]
music = len(cards)
chains.append(f'[{music}:a]atrim=start={MUSIC_START:.3f}:duration={total:.3f},asetpts=PTS-STARTPTS,'
              f'afade=t=in:d=0.15,afade=t=out:st={total - 1.6:.3f}:d=1.6,loudnorm=I=-14:TP=-1.5[a]')

out = here / 'TSL_Team_Reveal.mp4'
subprocess.run(['ffmpeg', '-v', 'error', '-y', *inputs, '-i', str(here / 'track2.wav'),
                '-filter_complex', ';'.join(chains), '-map', f'[{prev}]', '-map', '[a]',
                '-c:v', 'libx264', '-preset', 'medium', '-b:v', '12M', '-pix_fmt', 'yuv420p', '-r', str(FPS),
                '-c:a', 'aac', '-b:a', '192k', '-t', f'{total:.3f}', '-movflags', '+faststart', str(out)], check=True)
print(out, f'{total:.2f}s', 'cuts:', [round(c, 3) for c in cuts])
