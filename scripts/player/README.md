# player

Play an album from the command line — a zip you just downloaded, a folder, or
the CD in the drive. No unpacking, no importing, nothing added to a library.

```bash
player ~/Downloads/Nonagon\ Infinity.zip
```

It opens the zip into a scratch directory, reads the tags, and puts the album on
screen. Space pauses, arrows seek, `q` quits — and the scratch directory goes
with it, leaving only the zip you started with.

burncd's twin, literally: same panel, same amber, same meters, out of the same
[`../lib/panel.sh`](../lib/panel.sh).

## Setup

```bash
brew install mpv ffmpeg          # required
brew install cdrtools jq         # optional, for CDs only
ln -s ~/Sites/cd-collection/scripts/player/player /usr/local/bin/player
player --check
```

`mpv` is the engine. `ffprobe` reads tags and ffmpeg measures the spectrum for
the analyser. `cdrtools` gets CD-Text off a disc; `jq` reads MusicBrainz's answer
when a disc has none.

The symlink is resolved back to the real path, so player finds the panel it
shares with burncd; copying `player` somewhere on its own doesn't.

`--check` prints a pass/warn/fail line per dependency and exits non-zero on a
hard failure. Warnings are usually fine — "no disc, or no drive" just means the
drive is empty. Worth reading on a new terminal: the panel is 69 columns of
box-drawing characters and needs a UTF-8 locale and a window of at least 25×71.

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

`-n` is the way to get the track list as plain text; a normal run draws the panel.

### Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `PLAYER_DIRS` | `~/Music:~/Downloads` | Colon-separated dirs the picker scans. |
| `PLAYER_DEV` | `BURNCD_DEV`, else auto | cdrecord device for CD-Text. One drive, one setting. |
| `PLAYER_WORK` | `~/.cache/player/work` | Where zips are unpacked. |
| `PLAYER_MB` | unset | `0` to never ask MusicBrainz about a disc. |
| `PLAYER_ART` | unset | `0` to never fetch or draw the cover, `blocks` to force half blocks. |
| `PLAYER_COLLECTION` | the repo's CSV | Catalogue the panel annotates the album from. |
| `PLAYER_KEEP` | unset | Keep the scratch directory and print where it is. |

## What it handles

**The zip stays a zip.** Unpacked to `~/.cache/player/work`, played from there,
destroyed on exit — on `q`, on Ctrl-C, and on being killed. Not `$TMPDIR`: macOS
is entitled to reclaim that while a long record is still playing out of it, and
does. If the cache can't be written, `$TMPDIR` is taken anyway — a missing home
is a reason to accept the worse directory, not to refuse to play. The whole zip
is unpacked, not just the audio, so the cover art comes along; that's the meter
on the loading screen. `PLAYER_KEEP=1` opts out, which is only useful for
debugging.

**Any format** — anything mpv plays and ffprobe reads, mixed formats fine.

**Track order from tags, not filenames.** Multi-disc folders sort by disc first;
files with no track tag fall back to a natural filename sort among themselves.

**Nested folders.** A zip unpacking to `Album/CD1/…` and `Album/scans/…` is read
whole — audio is found wherever it is and the rest ignored.

**Gapless.** mpv is kept alive between tracks rather than restarted.

## Where the titles came from

Four sources, tried in order of trust. The panel always says which one you got,
on the faceplate after the track count — a track list is only as good as its
source, which is why it's on screen rather than in a log.

| Says | Source |
| --- | --- |
| `tags` | Embedded metadata. The normal case. |
| `CD-Text` | Written into the disc's lead-in at the factory. |
| `MusicBrainz` | Looked up by disc ID over the network. |
| `track numbers` | Nothing could say. Track 01, track 02… |

macOS mounts an audio CD as `.aiff` files named `1 Audio Track.aiff` — a track
list with no titles and no tags anywhere. So for discs: **CD-Text** is read with
`cdda2wav` (falling back to `cdrecord -toc`); if that's empty, **MusicBrainz** is
asked, using a disc ID computed to its spec — a SHA-1 over the first and last
track numbers, the lead-out offset and all 99 track offsets, so it identifies the
*pressing* and can tell two masterings apart; failing both, **track numbers**.

There's no ripping step — the volume macOS mounts is playable as it stands.

## Playing

```
   PLAYER  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ PLAYING · 9 TRACKS · tags

    ALBUM    Nonagon Infinity
    ARTIST   King Gizzard & The Lizard Wizard
    SOURCE   nonagon.zip

      01  Robot Stop                        King Gizzard & Th…   5:00
    ♪ 02  Big Fig Wasp                      King Gizzard & Th…   4:04
      03  Gamma Knife                       King Gizzard & Th…   6:15
  ▶   04  People-Vultures                   King Gizzard & Th…   5:07
    ▾ 4 MORE

  TRACK 02 OF 09                                            1:12 / 4:04
  ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▊░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▌

  ALBUM                                                     6:12 / 42:14
  ▐▓▓▓▓▓▓▓▓▓▓▌▓▓▓▓▓▓▎░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▌
  ▐  ··· ··· ··· ▒▒▒ ▒▒▒ ▒▒▒ ▒▒▒ ··· ··· ··· ··· ··· ▒▒▒ ▒▒▒ ▒▒▒ ▒▒▒  ▌
  ▐  ▒▒▒ ▒▒▒ ▒▒▒ ▁▁▁ ▒▒▒ ▒▒▒ ▃▃▃ ▅▅▅ ▄▄▄ ▂▂▂ ▂▂▂ ▃▃▃ ▒▒▒ ▒▒▒ ▒▒▒ ▒▒▒  ▌
  ▐  ▁▁▁ ▂▂▂ ▃▃▃ ███ ▇▇▇ ▆▆▆ ███ ███ ███ ███ ███ ███ ███ ▅▅▅ ▃▃▃ ▃▃▃  ▌
  ▐  ███ ███ ███ ███ ███ ███ ███ ███ ███ ███ ███ ███ ███ ███ ███ ███  ▌

   ␣  PLAY    ←→  SEEK    ↑↓  SELECT    ⏎  JUMP    N  NEXT    P  PREV
   S  SHUFFLE    R  REPEAT    Q  QUIT
```

**`♪`** is the track the music is coming out of (**`‖`** when paused). **`▶`**
and the highlighted row are the cursor. Usually they agree; when you browse
ahead they don't, and **`⏎`** brings the music to where you're looking.

Two meters: **track** is how much of this song is left, **album** is the whole
record divided into its tracks in proportion — the same meter burncd draws when
laying an album across a disc.

Under them is the **spectrum analyser**: sixteen bands from 40 Hz to 16 kHz,
five rows, ten frames a second, spaced by octaves rather than hertz. The levels
are real — when a track loads, ffmpeg measures it in the background at about
forty times real time (one decode, split sixteen ways, RMS per band every tenth
of a second) and the player reads the resulting table a row at a time. The next
track is measured while the current one plays; nothing is analysed twice. Until
a table is ready — the first few seconds of track one — the columns run a
stand-in pattern, which is also what you get permanently without ffmpeg.

Each band is scaled to its own range, anchored at the quarter and ninety-percent
marks of what that band actually did over the track rather than at its extremes.
A modern master spends its life near its own ceiling with a long thin tail into
the gaps between songs; scale the tail and every band ends up pinned at the top,
twitching. Falling columns leave a trail that sinks and dims behind them — the
peak-hold of a hardware analyser, making a fast transient visible for longer than
the tenth of a second it lasted.

To the right of the panel, when the window is wide enough, is the **cover**. If
the zip or the folder came with a picture in it, that's the one — it's the
artwork this copy shipped with, where the archive can only offer a scan of
whichever release the album *name* matched. `cover`, `folder` and `front` are
preferred, but any image will do, which is what it takes to find the
`Artist - Album.jpg` a Bandcamp download leaves you; the back, the booklet and
the face of the disc are skipped by name, and anything under 200 pixels is
skipped as a thumbnail.

Failing that it comes out of the tags — an APIC frame in an MP3, a PICTURE block
in a FLAC, a `covr` atom in an M4A — copied out at whatever size it was stored,
from the first of the opening three tracks that carries one. A music video in
the folder won't have its first frame mistaken for a sleeve.

Failing *that* it's fetched from the Cover Art Archive in the background and
cached under `~/.cache/player/art`, so an album played twice costs one download.
The panel is a fixed 71 columns, so it needs **85 columns** for the smallest
sleeve it will draw and **115** for a full-size one, plus the rows to hang it in
— the sleeve stops where the analyser starts, so a short window gets a smaller
one. Under 85 it simply isn't there. Nothing waits for it: no cover, no network,
no window — same panel either way.

In **iTerm2** it's a real image, at the resolution the screen has, and never
scaled up past whatever the source actually had. Every other terminal gets it
drawn out of half blocks (`▀`, two pixels a cell, truecolour or the 256-colour
cube), which even at full size is a 42×42 picture and looks it — recognisable as
a sleeve, not as *which* sleeve. `PLAYER_ART=blocks` forces the fallback
anywhere; `PLAYER_ART=0` turns the whole thing off.

## Keys

| Key | What it does |
| --- | --- |
| `␣` | Pause / resume |
| `←` `→` / `h` `l` | Seek 5 seconds |
| `⇧←` `⇧→` | Seek 30 seconds |
| `↑` `↓` / `k` `j` | Move the cursor |
| `PgUp` `PgDn` | Move the cursor a screenful |
| `⏎` | Play the track the cursor is on |
| `n` `p` | Next / previous track |
| `s` | Shuffle on / off |
| `r` | Repeat: off → album → track |
| `q` | Quit |

`p` behaves like every deck ever made: within the first few seconds it goes to
the previous track, after that to the start of this one.

Run `player` with no arguments for the source picker — every zip and every
folder with audio under `PLAYER_DIRS`, plus the disc. `r` rescans.

## Troubleshooting

**`mpv not found`** — `brew install mpv`. It's the engine; there's no fallback.
**`ffprobe not found`** — `brew install ffmpeg`.

**A track in a zip is missing, and `--check` warns on the `zips` line.** Zips are
opened with `bsdtar`, which is `/usr/bin/tar` on any Mac. Where there isn't one,
it falls back to `unzip` — and Apple's `unzip` mangles a filename that arrived
decomposed (an `o` plus a combining circumflex, which is how a Mac writes
`Hôtel`) into bytes the filesystem rejects, so that entry doesn't unpack. The
album still opens, one track short. Getting a real `tar` back on `PATH` fixes it.

**`cannot find lib/panel.sh`** — player was copied out of the repo rather than
symlinked into it. Put it back and symlink it, or take `scripts/lib` along.

**No sound, but the meters are moving.** There's no volume control here on
purpose — it plays at whatever the system is set to. Check system volume and
output device. mpv follows the system default; if you changed it while the
player was open, quit and reopen.

**The columns move but don't match the music.** ffmpeg hasn't finished measuring
and the stand-in pattern is running; it should catch up within a few seconds. If
it never does, ffmpeg isn't installed — `--check` says so on the `analyser` line.

**`mpv did not open its control socket`.** The socket lives in the scratch
directory, so this is almost always a scratch directory that isn't writable,
which `--check` reports on its own line. Can also be a wedged old mpv:
`pkill -f input-ipc-server`.

**The disc doesn't appear in the picker.** macOS has to mount it first — wait a
few seconds and press `r`. If it never mounts, `drutil status` says whether the
drive sees it at all. A data disc is correctly ignored; this plays CDDA, not a
folder of mp3s on a CD-R (point `player` at the mounted volume for that).

**A CD plays but every track is "Track 01".** No CD-Text and MusicBrainz didn't
recognise it. Check the network, then that `curl` and `jq` are installed. Some
discs genuinely aren't in the database.

**CD-Text is there but player doesn't see it.** cdrtools has to be able to open
the drive, and `--check` only confirms it's installed. Run `cdrecord -scanbus`
and use the bus address it prints — `1,0,0` — as `PLAYER_DEV=1,0,0`. A `/dev/`
path does not work. If burncd's `BURNCD_DEV` is already set, player reads that:
one drive, one setting.

**The panel is full of `?`.** The terminal isn't in a UTF-8 locale; `--check`
says which it found. `echo 'export LC_ALL=en_US.UTF-8' >> ~/.zshrc`.

**"needs a terminal at least 25 rows by 71 columns."** Make the window bigger.
There's no small-screen layout; the meters are the point.

**A scratch directory got left behind.** It shouldn't — cleanup runs on every
exit path, and the next run sweeps any `~/.cache/player/work/player.*` whose
process is gone. Only one `PLAYER_KEEP` asked for is yours to delete.

## Notes

**Why mpv.** It's the only thing on a Mac that will seek accurately, play
gapless, report its position to a fraction of a second, and take orders over a
socket — all four at once. `afplay` can't seek; `ffplay` can't be driven without
a terminal of its own.

**Why unpack at all.** mpv can play out of an archive with `archive://`, and it
works. Unpacking gives reliable seeking in every format, lets tags be read with
the same ffprobe loop burncd uses, and makes the loading progress real rather
than a guess. The cost is disk space for one album, and the promise it goes away.

**Why the spectrum is measured in advance.** A live analyser needs a tap on the
audio and an FFT, both at frame rate. bash has neither, and shelling out ten
times a second would cost more than the panel does. Measuring once ahead of time
turns it into an array lookup.

**bash 3.2.** macOS still ships bash 3.2 from 2007: no `coproc`, no sub-second
`read -t`, no `printf -v` into an array element, and `${#s}` counts bytes unless
the locale is set — which is why the script sets it before drawing a column.
