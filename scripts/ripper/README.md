# ripper

Rip an audio CD to a folder of tagged FLAC from the command line.

```bash
ripper
```

It reads the disc in the drive, works out what album it is, and puts the plan on
screen. Look it over, fix anything the catalogue got wrong, press **`b`** to rip.
`q` walks away. Nothing is written until you press `b`.

The other direction from [burncd](../burncd), and deliberately so: the folder
ripper leaves behind is the folder burncd takes. `ripper` then
`burncd <folder>` copies a disc, and `player <folder>` plays what came off it
with the sleeve already beside it.

## Setup

```bash
brew install ffmpeg cdrtools jq
ln -s ~/Sites/cd-collection/scripts/ripper/ripper /usr/local/bin/ripper
ripper --check
```

You also need a USB optical drive — no Mac has had one built in for years.

ripper is three files, not one: the panel — geometry, palette, meters, key
reading — lives in [`../lib/panel.sh`](../lib/panel.sh), and everything about
the disc itself — its table of contents, its CD-Text, what MusicBrainz and the
Cover Art Archive say about it — lives in [`../lib/disc.sh`](../lib/disc.sh),
shared with [player](../player). The symlink above is resolved back to the real
path, so it finds them; copying `ripper` somewhere on its own doesn't.

## Usage

| Command | What it does |
| --- | --- |
| `ripper --check` | Verify this machine can rip. Run first on a new setup. |
| `ripper` | Open the plan, edit it, `b` to rip |
| `ripper -n` | Dry run — print the plan, write nothing |
| `ripper -o DIR` | Put the album under `DIR` instead of here |
| `ripper --tracks 1,4-7` | Only those tracks |
| `ripper --no-mb` | Don't ask MusicBrainz what this disc is |

`-n` is worth using the first time on any disc — it's also the only way to get
the plan as plain text, since a normal run opens the editor instead.

There is no argument for *which* disc: ripper reads the one in the drive. `-o`
is for where the files go.

### Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `RIPPER_DIR` | `.` | Where albums go. Set it to `~/Music` and rips land where `player`'s picker looks. |
| `RIPPER_DEV` | auto | cdrecord device. `burncd`'s `BURNCD_DEV` is read too — one drive, one setting. |
| `RIPPER_ENGINE` | `auto` | `paranoia`, `cdda2wav`, `mount`, or `auto`. See below. |
| `RIPPER_MB` | `1` | `0` keeps every MusicBrainz lookup off the network. |
| `RIPPER_ART` | `1` | `0` never fetches a cover. |
| `RIPPER_LEVEL` | `8` | FLAC compression level, 0–12. Higher is smaller and slower; the audio is identical either way. |
| `RIPPER_WORK` | `~/.cache/ripper/work` | Where tracks are read to before they're encoded. |
| `RIPPER_KEEP` | unset | Keep the scratch directory and the drive logs; print where. |
| `RIPPER_EJECT` | `1` | `0` leaves the disc in the drive when it's done. |

## How it reads the disc

Three ways, in order of how hard they try. `--check` names the one this machine
will actually use.

| Engine | What it is |
| --- | --- |
| `cdparanoia` | The reference implementation: re-reads, overlaps, jitter correction. Not in Homebrew — MacPorts or a source build. |
| `cdda2wav -paranoia` | The same libparanoia, inside cdrtools, which you already installed for `burncd`. This is what most machines get. |
| the mounted disc | The `.aiff` tracks macOS puts on your desktop. **No error correction at all.** |

The last one isn't only a fallback. The raw path wants the drive and the mount
wants the filesystem, and macOS won't always give both at once — so when the raw
open is the one that fails, the same audio is sitting right there. If reading
track 1 fails with a device error and the disc is mounted, ripper switches for
the whole album and says so. It won't switch halfway: two engines on one album
means two different offsets, which is worse than either.

Whichever engine reads it, the check that settles whether a track came off whole
is the same one — the length, against what the table of contents said. That
catches a truncated read, a drive that gave up, and a ripper that exited quietly
having written nothing.

## Where the track names came from

A CD doesn't know what it is. There are two better answers than "Track 01" and
ripper tries both, in the order of how much they can be trusted. Whichever
answered is on the faceplate, because a track list is only as good as its source.

**CD-Text** is written on the disc itself by whoever pressed it, so when it's
there it's the answer. Most discs don't carry it.

**MusicBrainz** is asked with a disc ID computed from the table of contents — the
first track, the last track, the lead-out and all 99 offsets, hashed. That
identifies a *pressing*, not an album, which is how it tells the 1984 CD from the
2011 remaster with the bonus tracks, and gets the right track list for whichever
one is actually in the drive. It also says which disc of a set this is.

**Neither** leaves you with `Track 01` through `Track 12`, a folder named after
the volume, and a rip that is otherwise perfectly good.

This is what the plan screen is for. MusicBrainz picks *a* release, and on a
compilation it sometimes picks the wrong pressing — finding that out here costs
one keystroke, where finding it out afterwards costs a folder full of files named
after somebody else's record.

## What it handles

**One flat folder, tags carrying the order.** `<Album Artist> - <Album>/`, and
`01 Title.flac` inside it. No year in the folder name — it's in the tags, and a
year in the name is what makes the same album from two pressings land in two
folders. This is exactly the shape [burncd](../burncd) reads: it globs one level
deep and takes its running order from the `track` tag, never from filenames.

**Multi-disc sets, without a merge step.** Rip disc 1, rip disc 2, and if
MusicBrainz says they're the same release the second rip lands in the first one's
folder, tagged `disc=2/2` and named `2-01 …`. That's the flat directory with disc
tags burncd wants, arrived at without you doing anything. A folder per disc would
have made you merge them by hand.

**Names that survive a filesystem.** A slash in `AC/DC` is a path and a colon in
`Symphony: No. 5` is a slash too — the POSIX layer takes it and Finder draws it
as one. Both become `-`. Control characters go. Trailing dots and spaces are
trimmed, because they're legal here and not on the exFAT stick this folder ends
up on, where they come off silently and collide. A leading dot is prefixed away:
a hidden file that burncd can still see is worse than a visible one. Titles are
cut by characters, not bytes, so a name never ends in half of a `ō`.

The tags keep the real text. Only filenames are sanitised.

**The sleeve.** Fetched from the Cover Art Archive the moment the disc is
identified, which is thirty seconds before there's a file to put it in — so by
the time track one is encoded the picture is already in hand. It's written as
`cover.jpg` beside the tracks, where `player` looks for it first, and embedded in
each file. burncd globs only audio extensions, so it can't be mistaken for a
track. A big scan is scaled once for embedding rather than twelve times, and if
it turns up late the tracks are remuxed to add it — a container change, not a
re-encode.

**Interrupted is not lost.** Every track is encoded to `.ripper-NN.flac.part`
beside its destination and moved onto it, so the folder holds either a whole
track or no track. `.part` doesn't match burncd's `*.flac` glob either, so a
crashed run's leavings can never be burned. Run ripper again and it checks each
file's length against the table of contents, marks what's already sound with `✓`,
and does the rest. `R` re-rips anyway.

**No conversion.** What comes off the disc is 16-bit 44.1kHz stereo, and FLAC is
a container change — no resampling, no dither, no leveling. burncd dithers
because its sources might be 24-bit; here that would put noise on a copy that is
otherwise exact.

**Mixed-mode discs.** The data track at the end of an enhanced CD is dropped from
the plan and mentioned. A disc with no audio on it at all is refused, and so is a
blank — that's what burncd is for.

## The rip screen

```
  ▌ RIPPER ▐ ━━━━━━━━━━━━━━━ RIPPING · TRACK 04 OF 12 · 37%

    ALBUM    Nonagon Infinity
    ARTIST   King Gizzard & the Lizard Wizard
    TITLES   MusicBrainz

    TRACK    04 OF 12  Gamma Knife
    READ     18 OF 32 MB  cdda2wav -paranoia  /
    ERRORS   none

  ▐▓▓▓▓▓▓▒▒▒▒▒▓▓▓▓▓▓█░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▌

  ✓ 01  Robot Stop
  ✓ 02  Big Fig Wasp
  ✓ 03  Gamma Knife
```

The meter is the disc's own tracks end to end, in the bands
[player](../player) draws them in — the record looks the same in the tool that
reads it as in the tool that plays it. There's no run-out on it, because unlike a
disc being planned there's no empty tail: the rip is over when the last track is
read.

It's driven by the size of the file on disk, not by the engine's own progress
output — that differs by version and by mode, and a meter built on it goes wrong
quietly on a machine nobody tested. The spinner beside it isn't decoration:
while cdparanoia verifies an overlap the byte count sits still for several
seconds, and a panel with nothing moving on it looks like one that has died.

The plan screen is burncd's editor with two keys taken out. There's no reorder
and no split, because a CD's running order is a physical fact — offering to
change it before ripping is offering to write files whose numbers disagree with
the disc they came off.

| Key | |
| --- | --- |
| `↑` `↓` | Move between tracks |
| `⏎` | Rename the selected track |
| `a` | Set its artist |
| `x` | Skip it |
| `u` | Undo |
| `R` | Re-rip tracks that are already here |
| `b` | Rip |
| `q` | Quit — nothing is written |

## Troubleshooting

**`--check` says the rip engine is "mounted disc — no error correction".**
Neither cdparanoia nor cdda2wav is installed. `brew install cdrtools` gets you
cdda2wav, which has libparanoia in it. Ripping off the mount works, but a scratch
comes through as whatever the drive happened to return, with nothing to tell you
it happened.

**`--check` says cdparanoia is missing and I want it.** It isn't in Homebrew.
MacPorts has it, or build it from source. You probably don't need to:
`cdda2wav -paranoia` is the same library.

**"nothing answered" for the drive.** `cdrecord -scanbus` will list what the
drive calls itself; put that in `RIPPER_DEV`. If burncd already works, its
`BURNCD_DEV` is read too.

**A track failed and the rest are fine.** They're on disk and ripper says which
ones weren't, with the command to redo them:
`ripper --tracks 4,9`. A dirty disc is worth cleaning before that.

**Titles are all "Track 01".** The disc has no CD-Text and MusicBrainz has never
seen this pressing. Rename them on the plan screen before pressing `b` — that's
what the editor is for — or rip it as-is and fix the tags later.

**MusicBrainz named the wrong album.** It matched a different pressing. Fix the
fields on the plan screen, or `--no-mb` and name it yourself.

**No `cover.jpg`.** Nobody has uploaded a front for that release, or the lookup
was off. `--no-mb` turns the cover search off too — the archive is keyed on a
MusicBrainz release, so there's no way to find one without asking.

## Notes

Keep the FLAC. It's the archive copy: lossless, tagged, and the thing every other
format can be made from later. `aiff2flac` exists for the zips that arrive as
AIFF; nothing needs to turn a rip into anything else unless a particular player
demands it.

Rip speed is the drive's business, not ripper's. A paranoid read of a scratched
disc is slow because it's reading the same sectors repeatedly, which is the
entire point — a fast rip of a damaged disc is a fast rip of the damage.
