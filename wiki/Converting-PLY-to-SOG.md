The converter takes a sequence of 3DGS `.ply` frames and produces per-frame
`.sog` files plus a manifest the player can read.

Frame count, source fps, splat count, SH degree and attribute layout are all
detected from the files. None of them is configured.

## Layout

```
raw_data/<name>/     source PLY frames (not published)
data/<name>/         converted output (published)
data/index.json      generated list of sequences
```

The folder name under `data/` becomes the sequence id used by `?seq=`.

## Converting

Drop frames into `raw_data/<name>/`, then:

```
tools\seq.cmd <name>
```

Use `tools/seq.sh` on macOS and Linux. Run it with no arguments to list what is
available in `raw_data/`.

Any extra flags pass straight through:

```
tools\seq.cmd capyFall --dry-run
tools\seq.cmd capyFall --frame-step 2
tools\seq.cmd capyFall --sh-degree 0 --min-alpha 0.1
```

Reload the player and the sequence is in the dropdown.

### Preview first

```
tools\seq.cmd capyFall --dry-run
```

Reads only file headers, so it is near-instant even on many gigabytes. Reports
the detected splat count, SH degree, layout, frame range and an estimated output
size, and converts nothing.

Worth doing on any new sequence — it catches a mis-specified input before you
spend minutes encoding.

### Without the wrapper

`seq.cmd` is a shortcut for:

```
py tools/convert.py --input ./raw_data/<name> --output ./data/<name> --source-fps 24 --gpu 0 --force --project "<name>"
```

Call `convert.py` directly for anything the wrapper does not cover.
`py tools/convert.py --help` lists everything.

> Commands here use `py`, the Windows Python launcher. On macOS and Linux use
> `python3`. Plain `python` is unreliable on Windows — it often resolves to a
> Microsoft Store stub that does nothing.

On Windows you can also drag a folder of `.ply` files onto
`tools/convert-drop.cmd`.

## Options

### Input and range

| Flag | |
|---|---|
| `--input <dir\|glob>` | source frames |
| `--output <dir>` | output folder |
| `--start <n>` `--end <n>` | limit to a range of source frames |
| `--source-fps <n>` | authored rate of the input (default 24) |

### Size and fidelity

| Flag | Effect |
|---|---|
| `--frame-step <n>` | keep every nth frame — reduces size *and* decoding work |
| `--target-fps <n>` | derive the step from a target rate instead |
| `--sh-degree <0-3\|auto>` | spherical harmonic bands to keep; `auto` keeps the source |
| `--min-alpha <0-1>` | drop splats below an opacity threshold |
| `--filter-floaters` | drop splats contributing to no solid surface |
| `--quality <low\|medium\|high>` | SH palette fitting effort |

### Playback

| Flag | |
|---|---|
| `--playback-fps <n>` | rate written to the manifest |
| `--flip-x <on\|off>` | orientation (default `on`) |
| `--background <colour>` | viewer background, e.g. `"#101418"` |
| `--project <name>` | label shown in the dropdown |

### Execution

| Flag | |
|---|---|
| `--gpu [n]` / `--cpu` | encoding backend |
| `--workers <n>` | parallel frame conversions |
| `--dry-run` | plan only |
| `--force` | overwrite without asking |

## Frame rate and decimation

`--frame-step` and playback rate are independent.

**Duration-preserving (default).** With `--frame-step 2` and no explicit
`--playback-fps`, the playback rate is halved automatically. The animation keeps
its original length and updates half as often.

**Speed-changing.** Setting `--playback-fps` equal to the source rate while
decimating makes playback run proportionally faster. Allowed, and the converter
says so, so it is deliberate rather than a surprise.

`--frame-step` is usually the most effective single adjustment: it reduces both
file size and the amount of decoding the player has to do.

## What `--quality` does

SOG stores each channel at a fixed bit width, so encode settings cannot trade
size against fidelity the way a JPEG quality slider does.

`--quality` controls how much effort goes into fitting the **spherical harmonic
palette** — `low`, `medium`, `high`. It affects encoding time and SH accuracy,
**not file size**. On a sequence with no spherical harmonics it has no effect at
all.

To reduce size, use `--frame-step`, `--sh-degree`, `--min-alpha`, or
`--start/--end`.

## Reducing size

In rough order of effectiveness:

| Approach | |
|---|---|
| `--frame-step 2` | roughly halves total size; also improves playback |
| `--start` / `--end` | trim frames where nothing happens |
| `--sh-degree 0` | discards view-dependent shading; noticeably smaller |
| `--min-alpha 0.1` | drops near-transparent splats |
| `--filter-floaters` | removes stray haze around a capture |

### Dropping transparent splats

```
tools\seq.cmd capyFall --min-alpha 0.1
```

Removes splats whose opacity falls below the threshold. On a soft capture this
can be a large fraction of the total for little visible change.

Pass the alpha you actually mean — the conversion into the format's internal
representation is handled for you. Start around `0.05`–`0.1` and check for
popping, since the splat count can differ between frames afterwards. The
manifest records the real post-filter count.

### Finding frames that do nothing

```
py tools/motion_report.py --input ./raw_data/<name> --step 4
```

Reports per-frame movement and flags runs of identical frames, which cost full
storage for no visible change. Trim them with `--start` and `--end`.

This reads every frame, so use `--step` to sample on long sequences.

## Validation

Before encoding anything, the converter checks that every frame shares one
schema, property list and splat count:

```
ERROR: PREFLIGHT FAILED — splat count differs across frames.
  .../frame.0001.ply
      471,456 splats
  .../frame.0002.ply
      481,726 splats
  These are not frames of one sequence. An --input glob spanning two
  sequence versions produces a corrupt result; narrow it and re-run.
```

Sequence folders often sit beside earlier versions of themselves, and an
over-broad input pattern would otherwise produce a sequence that jumps between
two different models mid-playback. Non-contiguous frame numbers produce a
warning rather than an error, since gaps usually mean an incomplete export.

## Nonstandard exporters

Most exporters write the standard layout and need nothing special. Some deviate
— storing spherical harmonics across separate attributes, for instance. Those
are handled by a normalization pass, auto-detected or requested with
`--normalize`.

Adapters live in `tools/normalize.py`; add one by subclassing `Adapter`.

## Managing sequences

Renaming or deleting a folder under `data/` requires rebuilding the index:

```
py tools/index_sequences.py --data ./data
```

The converter does this automatically after every run.

### Comparing two settings

Convert the same source into two folders and both appear in the dropdown, so
you can compare at full size before choosing:

```
py tools/convert.py --input ./raw_data/x --output ./data/x_full --source-fps 24 --gpu 0
py tools/convert.py --input ./raw_data/x --output ./data/x_half --source-fps 24 --gpu 0 --frame-step 2
```

Delete the one you do not want, then rebuild the index.

### Re-converting

Re-running into an existing folder asks before overwriting. If the new
conversion is shorter than the old one, leftover frames are removed and
reported — they would otherwise be invisible to the player but still take up
space.

## Size budget

After every run the converter prints the size of every sequence in `data/` and
the library total, so you can see the effect of a setting immediately.

Hosting limits apply to the whole library, not to one sequence — see
[Publishing](Publishing#limits).

## Manifest fields

Each sequence has a `manifest.json`. These are safe to edit by hand — no
re-encoding needed, just reload:

| Field | | Set from the player |
|---|---|---|
| `display.flipX` | orientation | Flip → Save Scene |
| `display.background` | background colour | swatch → Save Scene |
| `camera` | default view | Save Scene |
| `project` | dropdown label | — |
| `temporal.playbackFps` | default rate | — |

`camera` and `bounds` sit above the frame list so you are not scrolling past
hundreds of entries to reach them.

Do not hand-edit `frames`, `frameCount` or `encode` — they describe what is
actually on disk.

## Troubleshooting

| Symptom | |
|---|---|
| `PREFLIGHT FAILED — splat count differs` | The input spans more than one sequence version. Narrow it. |
| `two or more inputs parse to the same frame number` | Same cause, caught earlier. |
| `frame numbers are non-contiguous` | Usually an incomplete export. Not fatal. |
| `--sh-degree N exceeds the source` | Harmless; it clamps to what exists. |
| `layout: NONSTANDARD` | Needs `--normalize`. Auto-detected where possible. |
| Renders upside down | Press **Flip**, then **Save Scene**. |
| Output larger than expected | `--quality` will not help. Use `--frame-step` or `--sh-degree`. |
| Library over the hosting limit | Decimate further, trim static frames, or drop a sequence. |
