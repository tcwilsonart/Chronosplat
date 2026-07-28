# Chronosplat

A self-hostable, browser-based player for **4D Gaussian Splatting animations** —
splat sequences that move — with full free-camera navigation and a timeline.

Static files only. No server, no plugin, no account. Publish it to GitHub Pages
and share a link.

**[Documentation →](../../wiki/Chronosplat)**

---

## What it is

Gaussian splatting captures are usually static. Tools for viewing a *moving*
splat sequence in a browser, at full quality, that you can host yourself are —
as far as we could find — not otherwise available. This is that.

The animation plays as a flipbook of independently compressed frames, streamed
and swapped in the browser, with spherical harmonics preserved so surfaces keep
their view-dependent response as you orbit.

## What's in it

**Player** — a static Three.js + [Spark](https://sparkjs.dev) app.

- Orbit / pan / zoom that persists across frame changes
- Timeline: play, pause, scrub, loop, adjustable fps
- Streams frames with a bounded memory window, so long sequences never load
  all at once
- Multiple sequences in one deployment, switchable from a dropdown
- Per-sequence camera, orientation and background, saved into the sequence
- Deep links that reopen the exact frame and viewpoint

**Converter** — a source-agnostic batch tool, `tools/convert.py`.

- Takes a PLY sequence from any 3DGS exporter, emits per-frame
  [SOG](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/)
  plus a manifest
- Detects frame count, fps, splat count, SH degree and layout from the files —
  nothing about the input is configured
- Validates the whole sequence before encoding anything, so a mis-specified
  input fails loudly instead of producing a subtly corrupt result
- Frame decimation, SH reduction and opacity filtering for trading size
  against fidelity

## Requirements

| | |
|---|---|
| Node | 22 or newer |
| Python | 3.10 or newer, with `numpy` |
| Browser | any with WebGL2 |
| GPU | optional, but much faster for encoding |

## Quickstart

```
npm install
npm run dev
```

Then convert a sequence — drop PLY frames in `raw_data/<name>/` and run:

```
tools\seq.cmd <name>
```

(`tools/seq.sh` on macOS and Linux.) Reload the player and it appears in the
dropdown.

## Layout

```
data/          converted sequences, published with the site
raw_data/      source PLY frames, not published
src/           player
tools/         converter and helpers
wiki/          documentation source
```

## Documentation

| Page | |
|---|---|
| **[Player Usage](../../wiki/Player-Usage)** | controls, sequence settings, performance |
| **[Converting PLY to SOG](../../wiki/Converting-PLY-to-SOG)** | the conversion pipeline and its options |
| **[Publishing](../../wiki/Publishing)** | GitHub Pages and other hosting |

## Built on

[Spark](https://sparkjs.dev) · [Three.js](https://threejs.org) ·
[splat-transform](https://developer.playcanvas.com/user-manual/splat-transform/) ·
[Vite](https://vite.dev)

## About the Example Data

All the PLY files were exported from a Houdini 22 custom exporter written in Python.

### bogdanFly

Original splat by Dany Bittel · [Cluster Fly](https://superspl.at/scene/285082b2)

Animation by Bogdan Lazar · [Animate Gaussian Splats with Houdini - Free Tutorial + Scene Files](https://www.youtube.com/watch?v=MqtMQl8DtjQ)

### capyFall

Test animation I made using the H22 included splat. Walk animation to ragdoll to vellum sim inflate.

### excavator

This is a scan I did for testing then animated the points in H22 · [Excavator Drone Scan](https://superspl.at/scene/1882034e)

## License

[GNU General Public License v3.0 or later](LICENSE).

Copyright (C) 2026 Chronosplat contributors.

Chronosplat is free software: you can redistribute it and modify it under the
terms of the GPL. It comes with **no warranty**. Anything you distribute that is
built from this code must be released under the same licence, with source.

Third-party dependencies — Spark, Three.js, splat-transform, Vite — are MIT, and
Playwright is Apache-2.0. Both are GPLv3-compatible.
