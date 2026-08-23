# aiff2flac

Turn the AIFF zips sitting in `~/Downloads` into FLAC zips. Same audio, same
tags, same cover art, same folder layout inside — about half the bytes, and the
AIFF zip goes to the Trash.

```bash
aiff2flac
```

Bandcamp's AIFF option and most lossless rips arrive as one zip per album, and a
20-minute side is 200 MB that FLAC stores in 110. Nothing here re-encodes the
audio: AIFF and FLAC are both lossless, so this is a repack, not a conversion
loss.

## Setup

```bash
brew install ffmpeg
ln -s ~/Sites/cd-collection/scripts/aiff2flac/aiff2flac /usr/local/bin/aiff2flac
```

`zip`, `unzip` and `bsdtar` ship with macOS. Unlike burncd and player, this one
is a single file with no `lib/` to find — copy it anywhere.

## Usage

| Command | What it does |
| --- | --- |
| `aiff2flac` | Scan `~/Downloads`, show what qualifies, ask before starting |
| `aiff2flac DIR` | Scan somewhere else (top level only, not recursive) |
| `aiff2flac -n` | Dry run — list the zips and their sizes, touch nothing |
| `aiff2flac -y` | Skip the confirmation |
| `aiff2flac --keep` | Write the FLAC zip, leave the AIFF zip where it is |
| `aiff2flac --rm` | Delete the AIFF zip outright instead of trashing it |
| `aiff2flac -j 4` | Tracks encoded at once (default: every core) |
| `aiff2flac -l 5` | FLAC compression level 0–12 (default 8) |

A zip qualifies if it contains at least one `.aiff` or `.aif`, at any depth.
Everything else in it — art, logs, cue sheets, PDFs, the folder structure — is
carried across byte for byte. Zips without AIFF are passed over in silence.

The new zip takes the old one's name, with `AIFF` swapped for `FLAC` where the
name says it: `Album [AIFF].zip` becomes `Album [FLAC].zip`, and `Album.zip`
stays `Album.zip`.

## What it guarantees

The order is: unpack, encode, repack, **test the new zip by reading it back**,
and only then trash the original and move the replacement into place. Anything
that goes wrong — an unreadable zip, one track ffmpeg won't decode, a failed
verify — stops that zip where it stands and leaves the original exactly as it
was. Those are listed at the end and the exit status is non-zero.

One bad track fails the whole zip on purpose. A zip quietly missing track 7 is
worse than a zip you have to deal with by hand.

## Space

Scratch space goes next to the zip being worked on, so the finished file lands
on the same volume and the last step is a rename rather than a multi-gigabyte
copy. Each zip needs about twice its own size free while it runs; anything that
doesn't fit is skipped with the numbers printed, not attempted.

The Trash is on the same volume, so trashing an original doesn't give the space
back. On a full disk, either empty the Trash between runs or use `--rm`.

## Notes

Tags and embedded artwork are copied over as-is. If a cover is embedded in a
form the FLAC container won't take, that one file falls back to audio and tags
only rather than failing — a separate `cover.jpg` in the zip is untouched either
way.

Bit depth and sample rate are preserved exactly, 24/96 included. Nothing is
resampled or dithered; that's [burncd](../burncd/README.md)'s job, at burn time.
