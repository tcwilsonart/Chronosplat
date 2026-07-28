A browser-based player for 4D Gaussian Splatting animations — splat sequences
that move — plus the converter that prepares them.

## Pages

- **[Player Usage](Player-Usage)** — controls, sequence settings, playback modes,
  performance
- **[Converting PLY to SOG](Converting-PLY-to-SOG)** — turning a PLY sequence
  into playable frames
- **[Publishing](Publishing)** — putting it online

## The short version

1. Put a sequence of `.ply` frames in `raw_data/<name>/`
2. Run `tools\seq.cmd <name>`
3. Run `npm run dev` and open the player
4. Compose a view, press **Save Scene**
5. Commit `data/` and push — GitHub Pages does the rest

## How it works

Each animation frame is encoded independently into a
[SOG](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/)
file — a compact, SH-preserving splat format. The player streams those frames
and swaps them on a timeline, keeping only a bounded window in memory so a long
sequence never has to load all at once.

Multiple sequences can live in one deployment. Each carries its own camera,
orientation, background and playback rate, and they appear in a dropdown.

## Requirements

| | |
|---|---|
| Node | 22 or newer |
| Python | 3.10 or newer, with `numpy` |
| Browser | any with WebGL2 |
| GPU | optional, but much faster for encoding |

## Project layout

```
data/          converted sequences (published)
  index.json   generated list of sequences
  <name>/      manifest.json + frame_0001.sog ...
raw_data/      source PLY frames (not published)
src/           player
tools/         converter and helpers
```
