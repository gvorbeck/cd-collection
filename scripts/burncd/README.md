# burncd

Burn a folder of music to an audio CD from the command line. No playlists, no
dragging files into Music.app, no thinking about disc formats.

```bash
burncd ~/Music/Nonagon\ Infinity
```

That's the whole thing. It reads the folder, works out the track order, and puts
the plan on screen. Look it over, fix anything the tags got wrong, and press
**`b`** to burn — gapless, with CD-Text. `q` walks away without burning.

---

## Setup on a new machine

Two dependencies:

```bash
brew install ffmpeg cdrtools
```

Then put the script on your PATH:

```bash
ln -s ~/Sites/cd-collection/scripts/burncd/burncd /usr/local/bin/burncd
```

Adjust that path if the repo lives somewhere else. Then confirm the machine is
actually ready:

```bash
burncd --check
```

You also need a USB optical drive — no Mac has had a built-in burner in years.

---

## Run this first: `--check`

`--check` is the thing to run on the burn machine before you spend a disc. It
looks at the parts that vary from machine to machine and prints a pass/warn/fail
line for each:

```
  burncd health check

  ✓  ffmpeg               ffmpeg version 8.1.2
  ✓  ffprobe              present
  ✓  dither support       triangular dither available
  ✓  loudness             ebur128 present — --level can measure
  ✓  cdrecord             Cdrecord 3.02a09
  ✓  cue + CD-Text        cdrecord supports cuefile= and -text
  ✓  cdda2wav             present — --verify can read discs back
  ✓  drive                cdrecord can open dev=IOCompactDiscServices
  ✓  drive CD-Text        Does write CD-Text
  ✓  drive --dummy        Does support test writing
  ✓  media                blank CD-R ready
  ✓  scratch space        54.1 GB free in /var/folders/...
  ✓  terminal             UTF-8 locale, progress bar will render

  Ready to burn.
```

It exits non-zero if anything is a hard failure, so it works in a script too.
Warnings are usually fine — "no disc inserted" just means you haven't put one in
yet.

### The three rehearsals, in order

They do different things and none of them replaces another:

| | Touches the audio | Touches the drive | Uses a disc |
| --- | --- | --- | --- |
| `--check` | no | yes — opens it, reads its capabilities and the media | no |
| `--demo` | yes — converts, builds the real image and cue | no | no |
| `--dummy` | yes | yes — a complete burn with the write laser off | no, the blank survives |

So: `--check` proves the hardware and tooling are there. `--demo` proves the
*output* is right — it converts the audio and builds the real image and cue sheet,
then runs the burn screen against them so you can see the whole thing land without
a disc in the drive. `--dummy` proves the drive actually accepts that cue sheet
and CD-Text, by doing the entire burn for real minus the laser.

```bash
burncd --check
burncd --demo  ~/Music/Album
burncd --dummy ~/Music/Album
burncd         ~/Music/Album
```

`--dummy` leaves the disc in the drive rather than ejecting it, so the real burn
is the next command with no shuffling. Not every drive supports test writing;
`--check` says whether yours advertises it.

### `--verify`

After the burn, reads the disc back and reports whether it is sound:

```
  ✓ Disc 1 of 1 written
  Verifying disc 1...
    ✓ table of contents — 12 tracks
    ✓ full read — every sector came back
    ✓ CD-Text — album title reads back
  ✓ Disc 1 verified
```

It deliberately does **not** compare the disc byte-for-byte against the image.
Every drive reads audio back at a small fixed sample offset from where it wrote
it, so an exact compare reports a mismatch on a perfectly good disc — which is
the same false alarm this flag exists to settle. It checks the things that
actually go wrong instead: the table of contents, whether every sector can be
read back without error, and whether the CD-Text survived.

The full read needs `cdda2wav` (it comes with cdrtools). Without it you still get
the TOC check, and `--check` says so. Verification roughly doubles the time per
disc, which is why it is opt-in. If any disc fails, burncd exits non-zero and
names it in the summary.

---

## Usage

| Command | What it does |
| --- | --- |
| `burncd --check` | Verify this machine can burn. Run first on a new setup. |
| `burncd DIR` | Open the plan, edit it if needed, `b` to burn — the whole job on one screen |
| `burncd -n DIR` | Dry run — print the plan, burn nothing |
| `burncd --demo DIR` | Convert for real, build the image and cue, simulate the burn |
| `burncd --dummy DIR` | Rehearse the burn on the drive with the laser off |
| `burncd --verify DIR` | Burn, then read the disc back and check it |
| `burncd --level DIR` | Bring a quiet album up to normal CD loudness |
| `burncd --split-long DIR` | Allow cutting a track that's longer than a disc |
| `burncd --no-cdtext DIR` | Burn without CD-Text (fallback if the drive balks) |
| `burncd --from-disc 3 DIR` | Resume a multi-disc job at disc 3 |
| `burncd --help` | Usage |

`-n` is worth using the first time on any album. It costs nothing and shows you
exactly what would land on which disc. It's also the way to get the plan as plain
text: a normal run opens the editor instead, and so does everything else that has
a terminal to draw on.

### Environment overrides

| Variable | Default | Notes |
| --- | --- | --- |
| `BURNCD_SPEED` | `8` | Burn speed. Lower is safer on cheap media. |
| `BURNCD_DEV` | `IOCompactDiscServices` | cdrecord device. A DVD-capable drive needs `IODVDServices` instead — see troubleshooting. |
| `BURNCD_SECONDS` | `4797` | Disc capacity. 4797 = 79:57, see below. |
| `BURNCD_MINUTES` | — | Same thing in whole minutes, if you prefer. |
| `BURNCD_LEVEL` | `off` | `album`, `track` or `off` — leveling without the flag. |
| `BURNCD_LUFS` | `-11` | Loudness target. See leveling below. |
| `BURNCD_PEAK` | `-1` | True-peak ceiling in dBTP. |

### Why 79:57 and not 80:00

A blank sold as "80 minute / 700 MB" holds **79:57** — 359,849 sectors at 75 per
second. The 80 on the packaging is rounding. Track lengths are rounded *up* when
read, so aiming at the true figure is safe rather than optimistic.

If you use 90-minute blanks, `BURNCD_MINUTES=89`. Overburning past the rated
capacity is not attempted.

```bash
BURNCD_SPEED=4 burncd ~/Music/Album
```

---

## What it handles for you

**Any format.** aiff, flac, mp3, ogg, opus, m4a, wav, ape — anything ffmpeg
reads. Mixed formats in one folder is fine. Everything is converted to
16-bit/44.1kHz stereo, which is what a CD actually stores. Hi-res sources get
**triangular dither** on the way down to 16-bit — ffmpeg does not dither by
default, it truncates, so this is set explicitly.

**Track order from metadata, not filenames.** It reads the embedded track
number tag, so files named `aaa-random.mp3` and `zzz-whatever.flac` still come
out in album order. Multi-disc source folders sort by disc number first. If some
files have no track tag, those fall back to a natural filename sort and the plan
tells you it did that — check the order before confirming.

**CD-Text.** Album title, album artist, and per-track titles and artists are
written into the disc's lead-in, so a car stereo or CD player that supports
CD-Text shows names instead of "Track 01". This comes from the same tags used for
ordering, so if the files are tagged you get it for free. CD-Text lives in a small
area of the lead-in; if an album's metadata is too big for it, per-track artists
are dropped automatically and you're told. `--no-cdtext` turns it off entirely.

**No gaps between tracks.** Each disc is assembled as one continuous
sector-aligned image and written disc-at-once, with track boundaries as index
marks rather than separate writes. Albums that segue between tracks stay
seamless. This is the default, not a flag.

**Splitting across discs.** Anything that won't fit on one disc is split across
as many as it needs — two, five, however many. The split is *balanced*, so a
128-minute set becomes 60 + 68 rather than 79 + 49, and album order is always
preserved. It ejects each disc, asks for the next, and continues.

A CD also cannot hold more than **99 tracks** regardless of runtime, so a
105-track folder splits even if it's only nine minutes long. The plan tells you
which limit caused the split.

**Tracks longer than a whole disc.** A 90-minute live set or DJ mix is one file
that cannot fit on any CD. By default burncd refuses and tells you. Pass
`--split-long` and it cuts the track into equal parts across discs — a 95-minute
file becomes two 47:30 parts rather than 79:57 plus a 15-minute stub. The parts
are labelled `Title (part 1/2)` in the plan and in CD-Text. The cut is sample-
exact and contiguous: nothing is lost or duplicated, but the music does stop at
the disc change, because that is what a disc change is.

**Not running out of room.** Before converting each disc it checks that the temp
filesystem can hold the image — roughly 10 MB per minute of audio, about 800 MB
for a full disc — and stops with a clear message rather than dying at 90%. Set
`TMPDIR` to a roomier volume if your boot disk is tight.

---

## The plan screen

Tags are often wrong, and the wrong ones are burned into the lead-in permanently.
So the plan you see before every burn is not a printout — it is the editor. You
notice the bad title on the same screen you fix it on, with no flag to decide on
in advance:

```
   BURNCD  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 11 TRACKS · 40:35 · 1 DISC

    ALBUM   John Denver's Greatest Hits
    ARTIST  John Denver
    YEAR    1973

  ━━ DISC 1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ▶ 01  Take Me Home, Country Roads (Orig…  John Denver            3:14
    02  Follow Me ("Greatest Hits" Versio…  John Denver            2:58
    03  Starwood In Aspen ("Greatest Hits…  John Denver            3:16
    04  For Baby (For Bobbie)               John Denver            3:00
    05  Rhymes and Reasons ("Greatest Hit…  John Denver            3:18
    06  Leaving, On a Jet Plane ("Greates…  John Denver            4:09
    07  The Eagle and the Hawk ("Greatest…  John Denver            2:17
    08  Sunshine on My Shoulders ("Greate…  John Denver            5:15
    09  Goodbye Again                       John Denver            3:42
    10  Poems, Prayers and Promises ("Gre…  John Denver            4:42
    11  Rocky Mountain High                 John Denver            4:44

  DISC 1                                                  40:35 / 79:57
  ▐▓▓▊▓▓▎▓▓▓▓▌▓▓▎▓▓▊▓▋▓▓▓▓▓▓▓▏▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▌
   0               20               40               60             80

   ↑↓  SELECT    ⇧↑↓  MOVE    ⏎  RENAME    A  ARTIST    X  DROP
   U  UNDO    R  RESET    B  BURN    Q  QUIT
```

That is the screen with its colour stripped out. On the terminal the `BURNCD`
badge is engraved black-on-amber, the rules and labels are the darker amber of
paint on a metal panel, the keycaps along the bottom are backlit, and the track
titles are left the brightest thing on the screen. Titles too long for the column
end in `…` so a truncated one is obvious. The meter is dithered throughout and
coloured in the same amber family — amber, brown, gold, burnt orange, alternating
light and dark so one track ends and the next begins visibly.

Redraws are whole frames laid over the top of the last one, never a clear
followed by a repaint, so holding an arrow key down does not strobe. Building a
frame costs no subprocesses at all, which is what keeps that redraw under a
frame's worth of time on a folder of any size.

The number of tracks shown is whatever the window has room for, counted rather
than guessed — the disc rules on a multi-disc split take rows too, and a frame
one line taller than the window scrolls the panel's own header away where no
later redraw can reach it. Below 19 rows there is no room for a panel at all, so
a very short window falls through to the static plan the same way a pipe does.

**`b` is what starts the burn** — or `space`, whichever your hand finds first.
Nothing is written, converted, or asked of the drive until then, so there is no
cost to opening the screen, looking, and leaving with `q`.

| Key | What it does |
| --- | --- |
| `↑` `↓` or `k` `j` | Move the selection. It runs through the three header fields and then the tracks. |
| `⇧↑` `⇧↓` or `K` `J` | Move the selected track up or down in the running order. |
| `⏎` | Rename whatever is selected — album, artist, year, or a track title. |
| `a` | Edit the artist of the selected track, for compilations with a different name per track. |
| `x` or `d` | Drop the selected track from the burn. The file is untouched. |
| `u` | Undo the last drop, back into the position it came from. |
| `r` | Reset everything to the original tags and order. |
| `b` or `space` | Accept the plan and burn. |
| `q` | Quit without burning. |
| `PgUp` `PgDn` | Page through a long track list. |

Nothing here touches your files. Edits apply to this burn only — to the CD-Text
in the lead-in and to the cue sheet — and they are gone when the command exits.

The editor needs a terminal and something to decide, so `-n` and any piped or
redirected run skip it and print the static plan instead. Pressing `b` does not
close the editor so much as turn the page: the screen stays where it is and the
burn happens on it, starting with a confirm screen that `e` brings you straight
back here from. See [one screen, start to
finish](#one-screen-start-to-finish).

The disc layout is recomputed after every change, so on a multi-disc set the
`━━ DISC N` separators and the meter move as you reorder or drop tracks; you can
see a disc boundary land somewhere better in real time. The meter always shows
the disc the cursor is on, with a minute scale under it, so "where does this
disc end?" and "how full is it?" are the same glance.

The screen draws on the terminal's alternate buffer, and that buffer is opened
before the first line of output rather than after — even "reading the folder"
happens inside it. So nothing above it moves, and when it closes there is nothing
of the run left behind at all.

Year is worth setting even though no CD player will ever show it — CD-Text has no
year field. It is written to the cue sheet as `REM DATE`, which some ripping
software reads back when the disc is later imported.

---

## Loudness: `--level`

Some albums are mastered quiet and play noticeably softer than everything else in
the changer. `--level` measures the album and raises it:

```
  Nonagon Infinity — King Gizzard (2016)
  6 tracks, 1:23, ordered by embedded track numbers
  CD-Text: on — disc and track names written to the lead-in
  Level: +33.4 dB to reach -11 LUFS
```

**It only ever applies gain — a single volume change.** No compression, no
limiting, no normalization per track by default. It cannot make a record sound
squashed, because it has no mechanism to; the dynamics that come out are exactly
the ones that went in, moved up as a whole.

The gain is whichever is smaller of two numbers:

- how much is needed to hit the loudness target (`-11` LUFS, about where a
  typical commercial CD sits), and
- how much headroom there is before the loudest true peak reaches the ceiling
  (`-1` dBTP).

So a quiet record gets the full boost, and a record that is already loud gets
whatever fits under the ceiling — often nothing:

```
  Level: already at CD loudness, no change
```

When the peak is what stops it rather than the target, the plan says so, because
that is the case where you don't get all the way to the target:

```
  Level: +41.1 dB — all the headroom there is before clipping
```

The ceiling is `-1` dBTP rather than `0` on purpose. **True** peak is not the
highest sample: reconstructing the waveform between samples can overshoot them,
and a signal that measures 0 dBFS in the file can clip a player's DAC anyway. A
dB of margin costs nothing audible and avoids that.

### Album gain vs track gain

`--level` is album mode: **one gain across the whole disc**. Quiet interludes stay
quiet relative to the loud tracks, because that relationship is a decision someone
made and it is not burncd's to overrule. Album mode also never turns anything
*down*.

`--level=track` measures and levels each track independently. That is right for a
mixtape of unrelated masters, where the tracks have no relationship to preserve,
and wrong for an album. It does attenuate — matching a set means bringing the loud
ones down as well as the quiet ones up.

```bash
burncd --level ~/Music/QuietAlbum       # one gain for the record
burncd --level=track ~/Music/Mixtape    # every track to the same loudness
BURNCD_LUFS=-14 burncd --level ~/Music/Album   # quieter target
BURNCD_LEVEL=album burncd ~/Music/Album        # on by default, no flag
```

Measuring reads every file end to end — roughly as long as converting them — so
the first run on an album is slower and says so. Results are cached under
`~/.cache/burncd`, keyed by path, size and mtime, so re-runs and the eventual real
burn are instant. If that directory can't be written, it measures every time and
doesn't complain about it.

Gain is applied in floating point and quantized to 16-bit once, at the end of the
chain, with the same triangular dither as everything else. `--check` reports
whether your ffmpeg has the `ebur128` filter this needs.

---

## What it looks like

### The plan

What a normal run opens with. It is the editor described above — arrow around
it, fix what's wrong, `b` when it's right — and this is the plain-text copy of
the same thing, which is what `-n` prints and what a piped run or a window too
short for a panel falls back to. A normal run keeps the plan on the panel
instead and leaves nothing in your scrollback at all:

```
  Nonagon Infinity — King Gizzard
  12 tracks, 41:38, ordered by embedded track numbers
  CD-Text: on — disc and track names written to the lead-in

    1. Robot Stop                                             3:30
    2. Big Fig Wasp                                           3:10
    ...
   12. Road Train                                             4:12
                                                             41:38
  DISC 1                                                  41:38 / 79:57
  ▐▓▓▓▎▓▓▓▊▓▓▌▓▓▓▏▓▓▓▊▓▓▓▎▓▓▌▓▓▓▓▏▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▌
   0               20               40               60             80
```

The meter under each disc is that disc filling up. Each cell is real time on the
disc and the colour steps between tracks, so you can see at a glance both how full
the disc is and where the tracks divide it — which is the thing you actually want
to look at on a multi-disc split, where every disc gets its own listing and its
own meter.

It is drawn at eighth-cell resolution. A cell can carry two colours — one as
foreground, one as background — and Unicode has the full run of left-aligned
partial blocks, so where a track boundary lands mid-column it is drawn as a
partial block of the outgoing colour over the incoming one rather than snapped to
the nearest character. That is eight times the precision for no extra width,
which is what makes the widths comparable at all: on a half-full disc of eleven
tracks each band is about three cells, and at whole-cell resolution a 3:14 and a
2:58 are simply the same bar.

Widths are apportioned by largest remainder rather than by truncating a running
total, so a longer track is never drawn narrower than a shorter one, and the bands
always add up to exactly the filled length. Measured against a real album the
bands come out within about 1% of true. A track under about ten seconds rounds
away to nothing and does not consume a colour, so the tracks either side of it
keep their contrast.

The grain is uniform within a band on purpose. An earlier version varied the
density from cell to cell and the speckle read as gaps, which destroyed the only
comparison the bar exists to support; a shaded cell is exactly as wide as a solid
one, so the texture costs nothing as long as it does not vary. The unburnt tail is
the same texture at a quarter density in the darkest amber, so it still reads as
part of the meter rather than as the end of it.

The scale underneath is spaced from the disc's capacity — every 20 minutes on a
Red Book disc, closer together on the short ones `BURNCD_MINUTES` can ask for.

### One screen, start to finish

Pressing `b` does not drop you back to the shell. The alternate screen the
editor opened is held for the whole job, and every step after it is drawn over
the last one from the same home position: waiting for a disc, converting it,
writing it, and the disc-by-disc report at the end are four states of one
instrument, not four messages stacked up a scrolling terminal.

Every stage has the same shape — the badge and what is happening now across the
top, the album under it, the stage's own body, then whatever has already happened,
and last of all the keys you can press:

```
   BURNCD  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ INSERT · DISC 1 OF 1

    ALBUM    John Denver's Greatest Hits
    ARTIST   John Denver
    YEAR     1973

    01  Take Me Home, Country Roads (Orig…  John Denver            3:14
    02  Follow Me ("Greatest Hits" Versio…  John Denver            2:58
    03  Starwood In Aspen ("Greatest Hits…  John Denver            3:16
    04  For Baby (For Bobbie)               John Denver            3:00
    05  Rhymes and Reasons ("Greatest Hit…  John Denver            3:18
    06  Leaving, On a Jet Plane ("Greates…  John Denver            4:09
    07  The Eagle and the Hawk ("Greatest…  John Denver            2:17
    08  Sunshine on My Shoulders ("Greate…  John Denver            5:15
    09  Goodbye Again                       John Denver            3:42
    10  Poems, Prayers and Promises ("Gre…  John Denver            4:42
    11  Rocky Mountain High                 John Denver            4:44

  DISC 1                                                  40:35 / 79:57
  ▐▓▓▊▓▓▎▓▓▓▓▌▓▓▎▓▓▊▓▋▓▓▓▓▓▓▓▏▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▌
   0               20               40               60             80

  INSERT a blank CD-R
   ⏎  BURN    E  EDIT    Q  CANCEL
```

**Asking for the disc is also the confirmation step.** The point of no return is
the moment a blank goes in, so that is the screen that shows you what you are
about to commit to: the album, artist and year as you edited them, the running
order as you left it, and the meter for the disc about to be written. `e` goes
back to the editor with everything you changed still changed; `⏎` starts the
burn. Nothing is converted or written until then, so the round trip costs a
keystroke and nothing else.

`e` is offered only on the first disc of a job that started at disc one. Once a
disc has been written the plan is a fact about a physical object sitting on the
desk, and re-cutting the running order underneath it would renumber discs that
are already in a sleeve — so from disc two on, the keys are `⏎ BURN` and
`Q CANCEL`.

When the track list is taller than the window has room for, it is cut to fit and
the last line reads `▾ 7 MORE`. There is no scrolling here — this screen is a
last look, and the place to read a long album line by line is the editor `e`
takes you back to.

Under the meter is the running log — discs finished, verify results, anything the
drive had to say:

```
  ✓ Disc 1 of 2 written

  INSERT a blank CD-R for disc 2 of 2
   ⏎  BURN    Q  CANCEL
```

Those lines used to print wherever the cursor happened to be, over the top of
whatever was being drawn at the time; now they join the frame they belong to and
it is redrawn around them. If the log outgrows the window, the oldest lines
scroll out of the panel rather than pushing its header off the top of the screen.

Converting is the same frame with the capacity meter filling as each track is
encoded, so the wait before the laser looks like the wait during it.

### Burning

```
   BURNCD  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ WRITING · DISC 1 OF 2 ·  54%

    ALBUM    Nonagon Infinity

    TRACK    06 OF 11  Rhymes and Reasons ("Greatest Hits" Version)
    WRITTEN  329 OF 605 MB AT 8.0x
    BUFFER   97%   ELAPSED 0:42   REMAINING 0:36

  ▐▓▓▓▓▓▍▓▓▓▓▎▓▓▓▓▋▓▓▓▓▋▓▓▓▓▓▏▓▓▓▓▓▓▌░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▌
  ▐·······················░░▒▒▓█······································▌
```

Same badge, same grid, same amber as the plan. **The progress bar is the capacity
meter again** — literally the same two functions, one deciding the band widths
and one drawing them, so the plan you approved and the disc coming out of it are
the same picture at two moments and cannot drift apart. The bands are the tracks
in the same alternating ambers, with the same partial blocks on the boundaries;
the part not yet written is the same run-out the meter uses for the empty end of
a disc; and the write head is a partial block too, so on a bar this wide it
creeps forward continuously instead of sitting still and then jumping a cell.

The second line is a lamp sweeping a dark field, in the position the plan gives
its minute scale. It moves on every message from the drive, which is the point: a
burn is twenty minutes of a number that changes every few seconds, and a stalled
write should look different from a slow one across the room.

There used to be a disc filling in from the hub outward here, in cyan and white.
It was a second, unrelated instrument bolted to the side of this one, and it said
nothing the numbers beside it did not.

In a terminal narrower than 71 columns it falls back to a compact four-line
readout, and when output is piped to a file it prints plain one-line-per-track
progress instead of redrawing anything.

### When it's done

The last state of the same panel, not a message printed after it:

```
   BURNCD  ━━━━━━━━━━━━━━━━━━━━━━━━━━ 2 DISCS · 78:10 · 41:12 ELAPSED

    ALBUM    Nonagon Infinity

  DISC 1                                                  46:12 / 79:57
  ▐▓▓▓▎▓▓▓▓▊▓▓▓▌▓▓▓▓▏▓▓▓▊▓▓▓▓▎▓▓▓▌▓▓▓▓▏▓▓▓▓▎░░░░░░░░░░░░░░░░░░░░░░░░░░▌
   0               20               40               60             80

  DISC 2                                                  31:58 / 79:57
  ▐▓▓▓▓▌▓▓▓▏▓▓▓▓▊▓▓▓▎▓▓▓▓▋▓▓▓▌▓▓▓▏░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▌
   0               20               40               60             80

  ✓ Disc 1 of 2 written
  ✓ Disc 2 of 2 written

   Q  QUIT
```

Same bars as the plan, so you can see what actually landed on each disc, with the
whole log of the job under them. `--from-disc` reruns show only the discs they
burned.

**`q` is the end of the job, and it takes the screen with it.** The alternate
buffer closes and your terminal is exactly as you left it — the last thing in the
scrollback is the `burncd` command you typed, with nothing between it and the next
prompt. Nothing from the run is printed before the screen opens or after it
closes, so a burn leaves no wreckage to scroll past. The one exception is a disc
that failed `--verify`: that is worth keeping, so it is written to stderr after
the screen is down, and burncd exits non-zero.

A window shorter than 19 rows or narrower than 71 columns never opens the screen
in the first place and prints the whole job linearly instead, the same way a pipe
does.

Run `burncd --demo` on any folder to see all of this without a disc in the drive.

---

## Troubleshooting

**`cdrecord not found`** — `brew install cdrtools`.

**cdrecord can't find the drive.** `--check` fails with `cannot open
dev=IOCompactDiscServices`, usually while `drutil` still reports the drive fine.
The default device name is the IOKit class for a **CD-only** drive; almost every
USB drive sold now is a DVD combo, and those register as `IODVDServices`:

```bash
export BURNCD_DEV=IODVDServices
```

If that isn't it either, ask cdrecord what it can see:

```bash
cdrecord -scanbus
```

and use the bus address it prints — `1,0,0` in the line
`1,0,0  100) 'MATSHITA' 'DVD-RAM UJ8E2 S ' ...` — as `BURNCD_DEV=1,0,0`.

What does **not** work is a `/dev/` path: cdrecord wants an IOKit class name or a
bus address, and `dev=/dev/disk4` fails the same way the wrong class name does,
which makes it easy to mistake for the same problem.

This is the one thing that usually needs adjusting on a new machine. Once you
know the right value, put it in your shell profile and forget it:

```bash
echo 'export BURNCD_DEV=IODVDServices' >> ~/.zshrc
```

**The burn failed and mentioned CD-Text or the cue sheet.** Some drives and some
cdrecord builds don't handle it. `burncd --check` says which of the two is the
problem. Either way:

```bash
burncd --no-cdtext ~/Music/Album
```

That falls back to burning without names in the lead-in. Everything else —
gapless, ordering, splitting — is unchanged. To find out which it is without
spending discs, run the same album with `--dummy` twice, once each way.

**A disc failed partway through a multi-disc job.** Don't restart from disc 1:

```bash
burncd --from-disc 3 ~/Music/Album
```

The split is deterministic, so disc 3 contains the same tracks it would have the
first time.

**Track order looks wrong.** The files are probably missing track number tags.
The dry run says `ordered by filename` when that happens. Fix the tags in a
tagger, or rename the files so a natural sort gives the right order.

**"longer than a disc"** — one file is longer than 79:57. Use `--split-long` to
cut it across discs, or split the file yourself first if you want to choose where
the break lands.

**Music.app said the burn failed but the disc plays fine.** That's Music.app's
post-burn *verification* read, not the burn. Cheap bus-powered USB drives are
often worse at reading a disc than at writing one, and some report an error while
closing the session even when the audio is intact. burncd reports cdrecord's own
exit status and prints its actual output, which tells you something real instead
of a generic dialog. `--verify` settles it either way: it re-reads the finished
disc and tells you whether the audio and the CD-Text are actually there.

If it does fail for real, drop the speed:

```bash
BURNCD_SPEED=4 burncd ~/Music/Album
```

Bus-powered USB drives are also prone to browning out near the end of a burn.
If failures cluster at the end, use a powered hub or the drive's second USB leg.

---

## Notes

Burn speed defaults to 8x rather than maximum, which generally gives lower error
rates on cheap media. Verbatim AZO is the reliable blank these days — Taiyo Yuden
no longer manufactures, so anything sold under that name is a different factory.

Keep the purchased lossless files as the real archive. CD-R dye degrades in a way
pressed discs don't, so treat the burned disc as the playback copy, not the
master.
