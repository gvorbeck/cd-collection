# burncd

Burn a folder of music to an audio CD from the command line.

```bash
burncd ~/Music/Nonagon\ Infinity
```

It reads the folder, works out the track order, and puts the plan on screen.
Look it over, fix anything the tags got wrong, press **`b`** to burn — gapless,
with CD-Text. `q` walks away. Nothing is converted, written, or asked of the
drive until you press `b`.

## Setup

```bash
brew install ffmpeg cdrtools
ln -s ~/Sites/cd-collection/scripts/burncd/burncd /usr/local/bin/burncd
burncd --check
```

You also need a USB optical drive — no Mac has had a built-in burner in years.

burncd is two files, not one: the panel — geometry, palette, meters, key
reading — lives in [`../lib/panel.sh`](../lib/panel.sh), shared with
[player](../player). The symlink above is resolved back to the real path, so it
finds it; copying `burncd` somewhere on its own doesn't.

## Usage

| Command | What it does |
| --- | --- |
| `burncd --check` | Verify this machine can burn. Run first on a new setup. |
| `burncd DIR` | Open the plan, edit it, `b` to burn |
| `burncd -n DIR` | Dry run — print the plan, burn nothing |
| `burncd --demo DIR` | Convert for real, build image + cue, simulate the burn |
| `burncd --dummy DIR` | Rehearse on the drive with the laser off |
| `burncd --verify DIR` | Burn, then read the disc back and check it |
| `burncd --level DIR` | Bring a quiet album up to normal CD loudness |
| `burncd --split-long DIR` | Allow cutting a track that's longer than a disc |
| `burncd --no-cdtext DIR` | Burn without CD-Text (fallback if the drive balks) |
| `burncd --from-disc 3 DIR` | Resume a multi-disc job at disc 3 |
| `burncd --no-media-check DIR` | Don't look at the disc before converting |

`-n` is worth using the first time on any album — it's also the only way to get
the plan as plain text, since a normal run opens the editor instead.

### Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `BURNCD_SPEED` | `8` | Lower is safer on cheap media. |
| `BURNCD_DEV` | auto | cdrecord device. See troubleshooting. `player` reads it too. |
| `BURNCD_SECONDS` | `4797` | Disc capacity — 79:57, the true size of an "80 minute" blank. |
| `BURNCD_MINUTES` | — | Same in whole minutes. 90-minute blanks: `BURNCD_MINUTES=89`. |
| `BURNCD_LEVEL` | `off` | `album`, `track` or `off` — leveling without the flag. |
| `BURNCD_LUFS` | `-11` | Loudness target. |
| `BURNCD_PEAK` | `-1` | True-peak ceiling in dBTP. |
| `BURNCD_NO_MEDIA_CHECK` | unset | Skip the pre-burn look at the disc. |
| `BURNCD_KEEP_WORK` | unset | Keep the image, cue sheet and drive logs; print where. |

## The three rehearsals

None replaces another. Run them in this order on a new setup:

| | Touches audio | Touches drive | Uses a disc |
| --- | --- | --- | --- |
| `--check` | no | yes — capabilities and media | no |
| `--demo` | yes — real image and cue | no | no |
| `--dummy` | yes | yes — full burn, laser off | no, the blank survives |

`--check` proves the hardware and tooling are there. `--demo` proves the output
is right. `--dummy` proves the drive accepts that cue sheet and CD-Text.
`--dummy` leaves the disc in the drive so the real burn is the next command.

**Before each disc**, at the INSERT prompt and before any audio is converted,
burncd checks the tray: empty, not blank, or too short for the plan (a 74-minute
disc under a 79-minute plan) and it says so and asks again. Capacity comes from
the disc's ATIP — the only thing that can tell a 74-minute blank from an
80-minute one. If the ATIP can't be read, it says so once and goes ahead;
`--no-media-check` skips the lot.

### `--verify`

Reads the disc back afterwards and checks the table of contents, that every
sector reads without error, and that CD-Text survived. It deliberately does
**not** byte-compare against the image: every drive reads audio back at a small
fixed sample offset from where it wrote it, so an exact compare reports a
mismatch on a perfectly good disc — the same false alarm this flag exists to
settle. Needs `cdda2wav` for the full read; without it you still get the TOC
check. Roughly doubles the time per disc, which is why it's opt-in. A failed
disc means a non-zero exit.

## What it handles

**Any format** — anything ffmpeg reads, mixed formats fine. Everything converts
to 16-bit/44.1kHz stereo with **triangular dither** on the way down (ffmpeg
truncates by default; this is set explicitly).

**Track order from tags, not filenames.** Reads the embedded track number, so
`aaa-random.mp3` still lands in album order. Multi-disc sources sort by disc
first. Files with no track tag fall back to a natural filename sort, and the
plan tells you it did that — check the order before confirming.

**CD-Text** — album, artist, and per-track titles and artists written to the
lead-in. CD-Text lives in a small area there, and a drive handed more than fits
refuses the whole burn, so metadata is measured against the real 18-byte-pack
budget and shed a step at a time until it fits: per-track artists, then titles
cut to 60 and 30 characters, then titles entirely, then CD-Text for that disc.
Every step says so.

The alphabet on a disc is ISO-8859-1, not Unicode. Accented Latin converts
correctly; curly quotes, dashes and `…` are mapped to ASCII stand-ins first
(otherwise iconv turns `Don’t` into `Don´t`); anything with no equivalent —
Japanese, Chinese, Cyrillic — is dropped, and burncd counts what it
approximated and says so before the burn. The plan still shows the real titles.

**No gaps.** Each disc is one continuous sector-aligned image written
disc-at-once, with track boundaries as index marks. Default, not a flag.

**Splitting across discs.** Anything that won't fit is split across as many
discs as it needs, *balanced* — a 128-minute set becomes 60 + 68, not 79 + 49 —
with album order preserved. A CD also can't hold more than **99 tracks**
regardless of runtime; the plan says which limit caused a split.

**Tracks longer than a disc.** By default burncd refuses and tells you.
`--split-long` cuts the track into equal parts — a 95-minute file becomes two of
47:30 rather than 79:57 plus a stub — labelled `Title (part 1/2)`. The cut is
sample-exact and contiguous.

**Disk space.** Checks the temp filesystem holds the image (~10 MB per minute of
audio) before converting, rather than dying at 90%. Set `TMPDIR` if your boot
disk is tight.

## The plan screen

Tags are often wrong, and the wrong ones get burned into the lead-in
permanently. So the plan isn't a printout — it's the editor.

```
   BURNCD  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 11 TRACKS · 40:35 · 1 DISC

    ALBUM   John Denver's Greatest Hits
    ARTIST  John Denver
    YEAR    1973

  ━━ DISC 1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ▶ 01  Take Me Home, Country Roads (Orig…  John Denver            3:14
    02  Follow Me ("Greatest Hits" Versio…  John Denver            2:58
    ...
    11  Rocky Mountain High                 John Denver            4:44

  DISC 1                                                  40:35 / 79:57
  ▐▓▓▊▓▓▎▓▓▓▓▌▓▓▎▓▓▊▓▋▓▓▓▓▓▓▓▏▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▌
   0               20               40               60             80

   ↑↓  SELECT    ⇧↑↓  MOVE    ⏎  RENAME    A  ARTIST    X  DROP
   S  SPLIT    U  UNDO    R  RESET    B  BURN    Q  QUIT
```

| Key | What it does |
| --- | --- |
| `↑` `↓` / `k` `j` | Move the selection — through the three header fields, then the tracks. |
| `⇧↑` `⇧↓` / `K` `J` | Move the selected track in the running order. |
| `⏎` | Rename whatever is selected. |
| `a` | Edit the selected track's artist, for compilations. |
| `x` / `d` | Drop the track from the burn. The file is untouched. |
| `s` | Start a new disc here. Press again to clear. |
| `u` | Undo the last edit — rename, move, drop, break or reset. Holds 100. |
| `r` | Reset to the original tags and order. |
| `b` / `space` | Accept the plan and burn. |
| `q` | Quit without burning. |

Nothing here touches your files — edits apply to this burn's CD-Text and cue
sheet only, and are gone when the command exits.

The disc layout recomputes after every change, so on a multi-disc set the
separators and the meter move as you reorder. `s` puts a break where the
balancer wouldn't have, marked `· SPLIT` so it's never confused with one the
arithmetic chose; the rest rebalances around it.

Pressing `b` turns the page rather than exiting: the INSERT prompt is also the
confirmation step, showing the album and running order as you edited them. `e`
goes back to the editor with your changes intact — offered only on disc 1 of a
job that started at disc 1, since after that the plan is a fact about a physical
object on the desk. Converting, writing and the final report all draw on the
same screen, and `q` at the end closes it, leaving nothing in your scrollback.

Set the year even though no CD player shows it — CD-Text has no year field, but
it's written to the cue sheet as `REM DATE`, which some rippers read back later.

A window under 19 rows or 71 columns skips the panel and prints linearly, the
same way a pipe does. Run `burncd --demo` on any folder to see the whole thing
without a disc in the drive.

## Loudness: `--level`

Some albums are mastered quiet and play noticeably softer than everything else
in the changer. `--level` measures the album and raises it.

**It only ever applies gain — a single volume change.** No compression, no
limiting. It cannot make a record sound squashed; it has no mechanism to.

The gain is whichever is smaller: what's needed to hit the target (`-11` LUFS,
about where a commercial CD sits), or the headroom before the loudest true peak
reaches the ceiling (`-1` dBTP). So a quiet record gets the full boost and an
already-loud one often gets nothing. The plan says which limit applied. The
ceiling is `-1` rather than `0` because true peak isn't the highest sample —
reconstruction between samples can overshoot, and a file measuring 0 dBFS can
still clip a DAC.

```bash
burncd --level ~/Music/QuietAlbum       # one gain for the record
burncd --level=track ~/Music/Mixtape    # every track to the same loudness
```

`--level` is **album mode**: one gain across the disc, so quiet interludes stay
quiet relative to loud tracks — that relationship is someone's decision and not
burncd's to overrule. It never turns anything down. `--level=track` levels each
track independently and does attenuate; right for a mixtape of unrelated
masters, wrong for an album.

Measuring reads every file end to end, so the first run is slow and says so.
Results cache under `~/.cache/burncd`, keyed by path, size and mtime.

## Troubleshooting

**`cannot find lib/panel.sh`** — burncd was copied out of the repo rather than
symlinked into it. Put it back and symlink it, or take `scripts/lib` along.

**`cdrecord not found`** — `brew install cdrtools`.

**cdrecord can't find the drive.** `--check` fails with `no drive answered`,
often while `drutil` reports the drive fine. burncd tries `IODVDServices`,
`IOCompactDiscServices` and `IOBDServices`, units 0 and 1, so this shouldn't
normally need setting. If none answered:

```bash
cdrecord -scanbus
```

Use the bus address it prints — `1,0,0` — as `BURNCD_DEV=1,0,0`, and put it in
your shell profile. A `/dev/` path does **not** work: cdrecord wants an IOKit
class name or a bus address, and `dev=/dev/disk4` fails the same way a wrong
class name does. A device set by hand is never second-guessed.

**The burn failed mentioning CD-Text or the cue sheet.** Some drives and some
cdrecord builds don't handle it; `--check` says which. Fall back with
`--no-cdtext` — everything else is unchanged. To see what was handed to the
drive, `BURNCD_KEEP_WORK=1 burncd --demo DIR` keeps the image, cue sheet and
drive logs and prints the path.

**It keeps asking for a disc that's already in the drive.** Some drives report
the tray as empty for a second after anything else has spoken to them. burncd
reads twice; a drive that insists can't be argued with. Use
`--no-media-check` — cdrecord still refuses anything that genuinely won't fit,
just five minutes later.

**"This blank holds 74:00 and disc 1 is 79:12."** The disc's ATIP says it's a
74-minute blank. Use an 80-minute one, or `BURNCD_MINUTES=73`.

**A disc failed partway through a multi-disc job.** Don't restart from disc 1 —
`burncd --from-disc 3 DIR`. The split is deterministic, so disc 3 holds the same
tracks it would have.

**Track order looks wrong.** Missing track number tags; the dry run says
`ordered by filename` when that happens.

**"longer than a disc"** — use `--split-long`, or split the file yourself if you
want to choose where the break lands.

**Music.app said the burn failed but the disc plays fine.** That's Music.app's
post-burn verification read, not the burn. Cheap bus-powered USB drives are
often worse at reading than writing. `--verify` settles it either way. If it
does fail for real, drop to `BURNCD_SPEED=4`. Bus-powered drives also brown out
near the end of a burn — if failures cluster there, use a powered hub.

## Notes

Burn speed defaults to 8x rather than maximum, which gives lower error rates on
cheap media. Verbatim AZO is the reliable blank these days — Taiyo Yuden no
longer manufactures, so anything sold under that name is a different factory.

Keep the purchased lossless files as the archive. CD-R dye degrades in a way
pressed discs don't, so the burned disc is the playback copy, not the master.
