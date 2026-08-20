# player

Play an album from the command line — a zip you just downloaded, a folder, or
the CD in the drive. No unpacking, no importing, no adding anything to a library.

```bash
player ~/Downloads/Nonagon\ Infinity.zip
```

That's the whole thing. It opens the zip into a scratch directory, reads the
tags, and puts the album on screen. Space pauses, arrows seek, `q` quits — and
when it quits, the scratch directory goes with it and the only thing left on
disk is the zip you started with.

It is burncd's twin: same panel, same amber, same meters. The picture you
approved before burning a disc is the picture you watch while playing it back.

---

## Setup on a new machine

Two dependencies for files, two more for discs:

```bash
brew install mpv ffmpeg
```

```bash
brew install cdrtools jq
```

`mpv` is the engine. ffmpeg does two jobs: `ffprobe` reads the tags, and ffmpeg
itself measures each track's spectrum for the analyser. `cdrtools` gets CD-Text
off a disc and `jq` reads MusicBrainz's answer when the disc has no CD-Text —
both optional, and only for CDs.

Then put the script on your PATH:

```bash
ln -s ~/Sites/cd-collection/scripts/player/player /usr/local/bin/player
```

Adjust that path if the repo lives somewhere else. Then confirm the machine can
actually play something:

```bash
player --check
```

---

## Run this first: `--check`

`--check` looks at the parts that vary from machine to machine and prints a
pass/warn/fail line for each:

```
  player health check

  ✓  mpv                  mpv v0.41.0 Copyright © 2000-2025 mpv/MP
  ✓  mpv archives         libarchive present
  ✓  ffprobe              ffprobe version 9.0.1 Copyright (c) 2007
  ✓  analyser             ffmpeg version 9.0.1 Copyright (c) 2000-
  ✓  unzip                UnZip 6.00 of 20 April 2009, by Info-ZIP
  !  unix sockets         nc present, -U undocumented — probably fine
  !  optical drive        no disc, or no drive
  ✓  CD-Text              cdda2wav present
  ✓  MusicBrainz          curl and jq present — untitled discs can be looked up
  ✓  scratch space        20Gi free in /var/folders/…/T/
  ✓  terminal             UTF-8 (en_US.UTF-8), 90x40
  ✓  window size          room for the panel

  Ready to play.
```

It exits non-zero on a hard failure, so it works in a script. Warnings are
usually fine — "no disc, or no drive" just means there's nothing in the drive,
and the `nc` warning is about a flag Apple ships but doesn't document.

The last two lines are worth reading on a new terminal. The panel is 69 columns
of box-drawing characters and partial blocks, and it needs a UTF-8 locale and a
window at least 25×71 to draw straight.

---

## Usage

| Command | What it does |
| --- | --- |
| `player --check` | Verify this machine can play. Run first on a new setup. |
| `player` | Pick a source from what's to hand — zips, folders, the disc |
| `player FILE.zip` | Play a zip, unpacked to scratch and cleaned up after |
| `player DIR` | Play a folder |
| `player --cd` | Play the disc in the drive |
| `player -n SOURCE` | Dry run — read it, print the album, play nothing |
| `player --no-mb --cd` | Play the disc without asking MusicBrainz about it |
| `player --help` | Usage |

`-n` is the way to get the track list as plain text. A normal run draws the
panel instead:

```
  Nonagon Infinity — King Gizzard & The Lizard Wizard (2016)
  9 tracks, 42:14, from tags

    1. Robot Stop                                             5:00
    2. Big Fig Wasp                                           4:04
    3. Gamma Knife                                            6:15
    ...
```

### Environment overrides

| Variable | Default | Notes |
| --- | --- | --- |
| `PLAYER_DIRS` | `~/Music:~/Downloads` | Colon-separated dirs the picker scans. |
| `PLAYER_DEV` | auto-detected | cdrecord device for CD-Text. See troubleshooting. |
| `PLAYER_MB` | unset | Set to `0` to never ask MusicBrainz about a disc. |
| `PLAYER_KEEP` | unset | Keep the scratch directory and print where it is. |

```bash
PLAYER_DIRS=~/Music:~/Downloads:/Volumes/Archive player
```

---

## What it handles for you

**The zip stays a zip.** A downloaded album is unpacked into a scratch
directory under `$TMPDIR`, played from there, and the directory is destroyed
when the app closes — on `q`, on Ctrl-C, and on being killed. What's left
afterwards is the zip you started with. `PLAYER_KEEP=1` opts out and tells you
where the scratch went, which is only useful for debugging.

The whole zip is unpacked, not just the audio, because a zip of an album is not
big enough to be worth being clever about and the cover art may as well come
along. Unpacking is done entry by entry so the panel can show the progress —
that's the meter on the loading screen.

**Any format.** aiff, flac, mp3, ogg, opus, m4a, wav — anything mpv plays and
ffprobe reads. Mixed formats in one folder are fine.

**Track order from metadata, not filenames.** It reads the embedded track number
tag, so `aaa-random.mp3` and `zzz-whatever.flac` still come out in album order.
Multi-disc folders sort by disc number first. Files with no track tag fall back
to a natural filename sort among themselves.

**Nested folders.** A zip that unpacks to `Album/CD1/…` and `Album/scans/…` is
read whole; the audio is found wherever it is and the rest is ignored.

**Gapless.** mpv is kept alive between tracks rather than restarted, so one
track runs into the next the way the record does.

---

## Metadata: where the titles came from

Four sources, tried in order of trust, and the panel always says which one you
got — on the faceplate, after the track count:

| What it says | Where the titles came from |
| --- | --- |
| `tags` | Embedded metadata in the files. The normal case. |
| `CD-Text` | Written into the disc's lead-in at the factory. |
| `MusicBrainz` | Looked up by disc ID over the network. |
| `track numbers` | Nothing could say. Track 01, track 02, and so on. |

A track list is only as good as its source, which is why it's on the screen
rather than in a log.

### CDs

macOS mounts an audio CD as a volume of `.aiff` files named `1 Audio Track.aiff`
— a track list with no titles in it and no tags anywhere. So:

1. **CD-Text** is read off the disc with `cdda2wav`, falling back to
   `cdrecord -toc`. Most commercial discs from the last twenty years carry it.
   Discs burned by burncd carry it too.
2. **MusicBrainz** is asked if CD-Text came back empty. The disc ID is computed
   the way MusicBrainz specifies — a SHA-1 over the first and last track
   numbers, the lead-out offset and all 99 track offsets — so it identifies the
   *pressing*, not just the album, and can tell two masterings apart.
3. **Track numbers** if neither answered, or if `--no-mb` was passed, or if
   there's no network.

There's no ripping step. The volume macOS mounts is playable as it stands.

---

## What it looks like

### Picking a source

Run `player` with no arguments and it shows what's to hand — every zip and every
folder with audio in it under `PLAYER_DIRS`, plus the disc in the drive:

```
   PLAYER  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 3 SOURCES

    SELECT A SOURCE

  ▶ ▸  Nonagon Infinity                              9 tracks · folder
    ▤  album.zip                                     152K · zip
    ▸  Test Album                                    5 tracks · folder

   ↑↓  SELECT    ⏎  OPEN    R  RESCAN    Q  QUIT
```

`r` rescans, for when you drop a new download in while it's open.

### Opening

A zip gets a loading screen. The meter is the album meter with nothing in it
yet, filling one file at a time, which is the honest picture of the wait:

```
   PLAYER  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ OPENING · 11%

    SOURCE   nonagon.zip

    READING  06 Evil Death Roll.flac

  ▐▓▓▓▓▓▓▓▍░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▌
```

### Playing

```
   PLAYER  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ PLAYING · 9 TRACKS · tags

    ALBUM    Nonagon Infinity
    ARTIST   King Gizzard & The Lizard Wizard
    SOURCE   nonagon.zip

      01  Robot Stop                        King Gizzard & Th…   5:00
    ♪ 02  Big Fig Wasp                      King Gizzard & Th…   4:04
      03  Gamma Knife                       King Gizzard & Th…   6:15
  ▶   04  People-Vultures                   King Gizzard & Th…   5:07
      05  Mr. Beat                          King Gizzard & Th…   4:31
    ▾ 4 MORE

  TRACK 02 OF 09                                            1:12 / 4:04
  ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▊░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▌

  ALBUM                                                     6:12 / 42:14
  ▐▓▓▓▓▓▓▓▓▓▓▌▓▓▓▓▓▓▎░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▌
  ▐  ··· ··· ··· ▒▒▒ ▒▒▒ ▒▒▒ ▒▒▒ ··· ··· ··· ··· ··· ▒▒▒ ▒▒▒ ▒▒▒ ▒▒▒  ▌
  ▐  ▒▒▒ ▒▒▒ ▒▒▒ ▁▁▁ ▒▒▒ ▒▒▒ ▃▃▃ ▅▅▅ ▄▄▄ ▂▂▂ ▂▂▂ ▃▃▃ ▒▒▒ ▒▒▒ ▒▒▒ ▒▒▒  ▌
  ▐  ▁▁▁ ▂▂▂ ▃▃▃ ███ ▇▇▇ ▆▆▆ ███ ███ ███ ███ ███ ███ ███ ▅▅▅ ▃▃▃ ▃▃▃  ▌
  ▐  ███ ███ ███ ███ ███ ███ ███ ███ ███ ███ ███ ███ ███ ███ ███ ███  ▌
  ▐  ███ ███ ███ ███ ███ ███ ███ ███ ███ ███ ███ ███ ███ ███ ███ ███  ▌

   ␣  PLAY    ←→  SEEK    ↑↓  SELECT    ⏎  JUMP    N  NEXT    P  PREV
   S  SHUFFLE    R  REPEAT    Q  QUIT
```

Two marks on the list, and they mean different things. **`♪`** is the track the
music is coming out of — **`‖`** when it's paused. **`▶`** and the highlighted
row are where the cursor is. Usually they agree. When you go browsing ahead they
don't, and the panel has to be able to say so; press **`⏎`** to bring the music
to where you're looking, and the cursor goes back to following along.

Two meters, because they answer different questions. The **track** meter is how
much of this song is left. The **album** meter is the whole record, divided into
its tracks — every band is one track, drawn in proportion, so you can see at a
glance that side two is where the long ones are. It's the same meter burncd
draws when it's laying an album out across a disc.

Underneath the meters is the **spectrum analyser** — sixteen bands from 40 Hz to
16 kHz, five rows tall, moving ten times a second. It is not decoration: the
levels are measured off the actual audio, so what the columns do is what the
record is doing. See [The analyser](#the-analyser) below.

### Paused

```
   PLAYER  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ PAUSED · 9 TRACKS · tags

    ALBUM    Nonagon Infinity
    ARTIST   King Gizzard & The Lizard Wizard
    SOURCE   nonagon.zip

  ▶ ‖ 01  Robot Stop                        King Gizzard & Th…   5:00
      02  Big Fig Wasp                      King Gizzard & Th…   4:04
      03  Gamma Knife                       King Gizzard & Th…   6:15
      04  People-Vultures                   King Gizzard & Th…   5:07
      05  Mr. Beat                          King Gizzard & Th…   4:31
    ▾ 4 MORE

  TRACK 01 OF 09                                            2:14 / 5:00
  ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▊░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▌

  ALBUM                                                     2:14 / 42:14
  ▐▓▓▋░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▌
  ▐  ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ···  ▌
  ▐  ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ···  ▌
  ▐  ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ···  ▌
  ▐  ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ··· ···  ▌
  ▐  ▁▁▁ ▁▁▁ ▁▁▁ ▁▁▁ ▁▁▁ ▁▁▁ ▁▁▁ ▁▁▁ ▁▁▁ ▁▁▁ ▁▁▁ ▁▁▁ ▁▁▁ ▁▁▁ ▁▁▁ ▁▁▁  ▌
```

The columns sit down on their floor and the faceplate says `PAUSED`. Not blank —
blank is what a broken one looks like. This is a deck with the power still on.

### The end of the record

```
   PLAYER  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ FINISHED · 9 TRACKS · tags

  ...

  ▪ END OF ALBUM — PRESS Q TO QUIT, ⏎ TO PLAY A TRACK
```

Both meters read full and it says so, rather than sitting there looking like it
hung. `r` for repeat album beforehand keeps it going instead.

---

## The analyser

Sixteen bands, five rows, ten frames a second. The bands are spaced by octaves
rather than by hertz — 40, 59, 88, 132 Hz and so on up to 16 kHz — because that
is how the ear divides the range, and it gives the bottom end enough bands to
move independently instead of heaving as one lump.

**The levels are real.** When a track is loaded, ffmpeg runs over it in the
background: one decode, split sixteen ways, a bandpass filter per band, and the
RMS level of each band taken every tenth of a second. That comes back as a table
of numbers — one row per frame, sixteen columns — which the player then reads
one row at a time as the music plays. It runs about forty times faster than
real time, so a four-minute track is measured in about six seconds, and the next
track is measured while the current one plays. Nothing is analysed twice, and
the tables go into the same scratch directory as everything else and die with it.

Until the table for a track is ready — the first few seconds of the first track,
essentially — the columns run a stand-in pattern. That is also what you get
permanently if ffmpeg isn't installed, which `--check` will tell you.

**Each band is scaled to its own range**, not to one scale for all sixteen. The
bass of a record runs tens of decibels above its top octave; a single scale
would leave half the panel flat all night.

The scale is anchored at the quarter and ninety-percent marks of what that band
actually did over the track, placed a quarter and six-sevenths of the way up the
column. Deliberately not the extremes: a record mastered in this century spends
its life within a few decibels of its own ceiling, with a long thin tail down
into the gaps between songs. Scale that tail into the column and the tail gets
the column — every band ends up pinned near the top, twitching. Throw the tail
away and scale the part the music actually occupies, and the columns use their
whole height: roughly a fifth of the time at the floor, a sixth at the ceiling,
and the rest of it moving.

**Trails.** When a column falls, the level it reached stays behind and sinks
slowly after it, dimming as it goes — `▓` to `▒` to `░` and out through the
amber. It is the peak-hold of a hardware analyser, and it does the same job:
it makes a fast transient visible for longer than the tenth of a second it
actually lasted.

---

## Keys

| Key | What it does |
| --- | --- |
| `␣` | Pause / resume |
| `←` `→` | Seek 5 seconds. `h` and `l` do the same. |
| `⇧←` `⇧→` | Seek 30 seconds |
| `↑` `↓` | Move the cursor. `k` and `j` do the same. |
| `PgUp` `PgDn` | Move the cursor a screenful |
| `⏎` | Play the track the cursor is on |
| `n` `p` | Next / previous track |
| `s` | Shuffle on / off |
| `r` | Repeat: off → album → track |
| `q` | Quit |

`p` behaves like every deck ever made: within the first few seconds of a track
it goes back to the previous one, and after that it goes back to the start of
this one.

---

## Troubleshooting

**`mpv not found`** — `brew install mpv`. It's the engine; there's no fallback.

**`ffprobe not found`** — `brew install ffmpeg`. ffprobe ships with it.

**No sound, but the meters are moving.** There is no volume control here on
purpose — it plays at whatever the system is set to. So this is macOS: check the
system volume and the output device. mpv follows the system default output; if
you changed it while the player was open, quit and reopen.

**The columns move but they don't match the music.** ffmpeg hasn't finished
measuring the track yet, and the stand-in pattern is running — it should catch
up within a few seconds of the first track starting. If it never does, ffmpeg
isn't installed: `player --check` says so on the `analyser` line.

**`mpv did not open its control socket`.** mpv started but its IPC socket never
appeared. Almost always a `$TMPDIR` that isn't writable, which
`player --check` reports as a scratch failure. It can also happen if an old mpv
is wedged — `pkill -f input-ipc-server` and try again.

**The disc doesn't appear in the picker.** macOS has to mount it first; give it
a few seconds after inserting and press `r` to rescan. If it never mounts,
`drutil status` will say whether the drive sees a disc at all. A disc that is
data, not audio, is correctly ignored — this plays CDDA, not a folder of mp3s
on a CD-R (point `player` at the mounted volume for that).

**A CD plays but every track is called "Track 01".** The disc has no CD-Text and
MusicBrainz didn't recognise it. Check the network, then check that `curl` and
`jq` are installed — `player --check` says so. Some discs genuinely aren't in
the database; obscure pressings and anything home-burned without CD-Text will
land here.

**CD-Text is there but player doesn't see it.** cdrtools has to be able to open
the drive, and `--check` only tells you cdrtools is installed, not that it can
reach the drive. Ask cdrecord what it can see:

```bash
cdrecord -scanbus
```

and use the bus address it prints — `1,0,0` in the line
`1,0,0  100) 'MATSHITA' 'DVD-RAM UJ8E2 S ' ...` — as `PLAYER_DEV=1,0,0`. A
`/dev/` path does not work: cdrecord wants an IOKit class name or a bus address.
This is the same setting as burncd's `BURNCD_DEV` and the same value works for
both.

**The panel is full of `?` or the bars look wrong.** The terminal isn't in a
UTF-8 locale. `player --check` says which locale it found. Fix:

```bash
echo 'export LC_ALL=en_US.UTF-8' >> ~/.zshrc
```

**`the panel needs a terminal at least 25 rows by 71 columns`.** Make the window
bigger. There's no small-screen layout; the meters are the point.

**A scratch directory got left behind.** It shouldn't — that's cleaned up on
every exit path, including Ctrl-C and being killed. If the machine lost power
mid-play, `rm -rf $TMPDIR/player.*` clears them.

---

## Notes

**Why mpv.** It's the only thing on a Mac that will seek accurately, play
gapless, report its position to a fraction of a second, and take orders over a
socket — all four at once. `afplay` can't seek. `ffplay` can't be driven without
a terminal of its own. The panel is only honest because mpv volunteers what it's
doing rather than being polled for it.

**Why unpack at all.** mpv can play straight out of an archive with
`archive://`, and it works. It's not used here: unpacking gives reliable seeking
in every format, lets the tags be read with the same ffprobe loop burncd uses,
and makes the loading progress real rather than a guess. The cost is disk space
for the length of one album, and the promise that it goes away again.

**Why the spectrum is measured in advance.** A live analyser needs a tap on the
audio as it plays, an FFT, and both of them running at frame rate. bash has no
FFT and no way to tap mpv's output, and shelling out ten times a second would
cost more than the panel does. Measuring the whole track once, ahead of time,
turns all of that into an array lookup — and it can be done at forty times real
time in the background, which is cheap enough to hide behind the track before it.
The one thing it cannot do is react to something that isn't in the file, which
for playing a record is nothing at all.

**One event loop.** Keystrokes, the redraw ticker and mpv's JSON all arrive on
one stream, merged into a single blocking read — the same shape burncd uses to
watch a burn. That's what keeps the transport responsive while the meters move,
in a shell that has no async anything.

**bash 3.2.** macOS still ships bash 3.2 from 2007, so that's the target: no
`coproc`, no sub-second `read -t`, no `printf -v` into an array element, and
`${#s}` counts bytes unless the locale is set — which is why the script sets it
before drawing a single column.
