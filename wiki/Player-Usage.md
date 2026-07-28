# Player Usage

## Running it locally

```
npm install
npm run dev
```

Opens at `http://localhost:5173`. New conversions appear on reload — no restart
needed.

For building and previewing a production bundle, see
[Publishing](Publishing#local-preview-of-a-build).

## Controls

| Input | Action |
|---|---|
| drag | orbit |
| right-drag / two-finger drag | pan |
| scroll | zoom |
| `Space` | play / pause |
| `←` `→` | step one frame (hold `Shift` for ten) |
| `L` | toggle loop |
| `S` | toggle the stats overlay |

The camera never resets when the frame changes, so you can scrub and play while
holding a viewpoint.

## The timeline

Left to right:

| Control | |
|---|---|
| sequence dropdown | switch sequences (appears only when there is more than one) |
| play / pause | buffers a few frames before starting |
| scrubber | drag to any frame; playing resumes after the drag |
| frame + time | current frame, total frames, elapsed and total time |
| **Loop** | wrap from the last frame to the first |
| **fps** | override the playback rate for this session |
| mode | `every frame` or `realtime` — see [Playback modes](#playback-modes) |
| **Flip** | rotate the sequence 180° about X *(preview)* |
| **Reset** | return the camera to this sequence's saved view |
| colour swatch | background colour *(preview)* |
| **Stats** | toggle the stats overlay |
| **Save Scene** | write the current view into this sequence's manifest |

## Sequence settings

Every sequence carries its own **camera**, **orientation** and **background**.
Switching sequences restores that sequence's own settings.

**Flip** and the colour swatch are previews — they change what you see but
nothing on disk. **Save Scene** is the only control that writes, storing the
camera position, target, field of view, orientation and background together.

This split means you can experiment freely without overwriting a view you were
happy with. It also means **Reset** discards unsaved changes, since it restores
the last saved camera.

### Fixing orientation

Some exports are authored Y-down and some are not. If a sequence appears upside
down, or you are looking at the underside of a ground plane, press **Flip**,
then **Save Scene**.

Orientation can also be set at conversion time with `--flip-x off`, or by
editing `display.flipX` in the sequence's `manifest.json`.

### Saving to disk

**Save Scene** writes to `data/<sequence>/manifest.json` when running under
`npm run dev`.

A published static site cannot write files, so there the same button copies the
settings to your clipboard as JSON to paste into the manifest by hand.

Only presentation fields can be written this way. Fields describing what is
actually encoded — the frame list, frame count, SH degree — are rejected, so a
manifest can never disagree with the files beside it.

## Playback modes

Splat frames are large, and decoding one takes longer than a frame interval at
typical animation rates. The mode dropdown decides what to do about that.

| Mode | Guarantees | Trade-off |
|---|---|---|
| **every frame** *(default)* | every frame is displayed | runs below the authored fps when decoding cannot keep up, so duration is not preserved |
| **realtime** | the authored wall-clock duration | skips frames that are not decoded in time |

The viewport never goes blank in either mode; the last decoded frame stays on
screen until its replacement is ready.

If a sequence was converted with a lower frame rate — say 8 or 12 fps — realtime
mode is usually comfortable. At 24 fps and high splat counts, `every frame` is
generally the better choice.

### Getting smoother playback

From within the player, raise the preload window with `?ahead=60`. On a machine
with plenty of VRAM this can hold a short sequence entirely in memory. Watch the
`resident` figure in the stats overlay to see how much is actually held.

Beyond that, the fix is a lighter sequence — fewer frames or fewer splats per
frame. See [Reducing size](Converting-PLY-to-SOG#reducing-size).

## Stats overlay

Press `S` or the **Stats** button:

```
excavator   frame 12/30   mode everyFrame
playback   target 12 fps   effective 11.8 fps
memory     resident 15/16   ready 15 loading 0 failed 0

source     59 frames @ 24 fps   SH 1
encoded    30 frames @ 12 fps   SH 1
quality    high   471,456 splats/frame   7.2 MiB/frame
total      215.0 MiB
```

| Row | |
|---|---|
| `playback` | requested rate vs what is actually being achieved |
| `memory` | frames held in GPU memory against the configured budget |
| `source` | what came out of the capture |
| `encoded` | what this conversion produced |

The `target` vs `effective` gap tells you whether playback is decode-limited.
If `effective` is well below `target`, the sequence is too heavy to play at that
rate — decimate it further, or use `every frame` mode and accept slower motion.

## URL parameters

Useful for embedding and for sharing a specific view.

| Parameter | |
|---|---|
| `?seq=<id>` | open a specific sequence |
| `?frame=N` | start on a frame |
| `?paused=1` | do not autoplay |
| `?fps=N` | override playback rate |
| `?mode=realtime` | wall-clock playback |
| `?loop=0` | disable looping |
| `?camPos=x,y,z` | starting camera position |
| `?camTarget=x,y,z` | starting look-at target |
| `?fov=deg` | field of view |
| `?bg=%23101418` | background colour (URL-encode the `#`) |
| `?ahead=N` `?behind=N` | preload window size |
| `?stats=1` | show the stats overlay |
| `?flipX=0` | override orientation for this session |
| `?manifest=<url>` | load a single manifest directly |

Example:

```
http://localhost:5173/?seq=excavator&camPos=2.6,1.6,3.6&camTarget=0,0,0&fov=45&paused=1
```

> **Parameters must come before the `#`.** The player writes a deep link
> (`#f=..&p=..&t=..`) into the address bar as you move, so appending `?stats=1`
> to a copied URL puts it inside the hash where it is ignored. Press `S`
> instead, or place the query before the `#`.

## Deep links

As you orbit and scrub, the address bar updates with the current frame and
camera. Copy it and the recipient opens on the same frame, from the same
viewpoint.

## Camera precedence

Highest first:

1. URL parameters
2. URL hash deep link
3. `camera` in the sequence manifest — what **Save Scene** writes
4. automatic framing from the sequence's actual extents
5. built-in defaults

Automatic framing is a fallback. A saved camera is always honoured.

## Embedding

The player is a static page, so an `<iframe>` works:

```html
<iframe
  src="https://<user>.github.io/<repo>/?seq=excavator&camPos=2.6,1.6,3.6&paused=1"
  width="960" height="540" style="border:0" allowfullscreen></iframe>
```

## Troubleshooting

| Symptom | |
|---|---|
| Blank page, "WebGL2 is required" | The browser has no WebGL2 — enable hardware acceleration or use a current browser. |
| "Could not load the sequence manifest" | Nothing converted yet, or the player is not being served from the project root. Run a conversion, then `npm run dev`. |
| Sequence upside down | Press **Flip**, then **Save Scene**. |
| Playback slower than expected | Decode-limited. Check `target` vs `effective` in the stats overlay. |
| Camera resets on reload | Press **Save Scene** — moving the camera alone does not save it. |
| Stutter while scrubbing | Normal on a cold frame; it loads on demand. Raise `?ahead=` to widen the buffer. |
| Dropdown missing | It only appears with more than one sequence. |
