# disc.sh — what album is in the drive, and what does its sleeve look like.
#
# The half of a disc that is not audio: the table of contents, the disc ID
# computed from it, the two catalogues worth asking about a pressing, and the
# cover art that answer leads to. player reads this to put titles on a panel;
# ripper reads it to put them in filenames and tags. Both are asking the same
# drive the same question, and asking it twice in two files is how the two
# answers start to differ.
#
# Sourced after panel.sh, never on its own: qgrep and detect_dev come from
# there, and DEV must already be defined by the caller. Nothing here opens a
# screen, sets a trap, prints, or runs at source time — the calling script owns
# all of that, the same bargain panel.sh makes.
#
# Everything is reported through the DISC_ globals below rather than on stdout,
# because a track list is an array and bash 3.2 has no way to hand one back.
# They are indexed by TRACK NUMBER, not by position: a caller holding files in
# the order it happened to scan them owns that mapping and must do it at the
# call site. This file has no idea what row anything is on, which is the whole
# reason it can be shared.
#
# Set DISC_USE_MB=0 to keep every MusicBrainz lookup off the network.

# What the disc says it is. All of it is best-effort: a disc nobody submitted
# and a machine with no network leave these empty, and that is a normal outcome
# rather than a failure.
DISC_ALBUM=''; DISC_ALBUM_ARTIST=''; DISC_YEAR=''
# Which catalogue answered — "CD-Text", "MusicBrainz", or whatever the caller
# put here as its own default. A track list is only as good as its source.
DISC_SOURCE=''
DISC_DISCID=''; DISC_MB_TOC=''; DISC_MB_RELEASE=''
# Where this disc sits in a set. 1 of 1 until MusicBrainz says otherwise, so a
# caller can read them without testing whether the lookup ever ran.
DISC_NO=1; DISC_TOTAL=1
DISC_FIRST=0; DISC_LAST=0; DISC_LEADOUT=0
DISC_TITLE=(); DISC_ARTIST=()
# The table of contents. LBA is the address the drive reports, FRAMES the length
# in 1/75s sectors, CONTROL the four flag bits: 4 marks a data track and 1 marks
# pre-emphasis.
DISC_LBA=(); DISC_FRAMES=(); DISC_CONTROL=()
# The mounted CDDA volume, when macOS has given us one.
DISC_VOLUME=''
# Where the sleeve is, or is about to be. Set before the fetch forks, so it
# names a file that may not exist yet — testing for the file is the only
# completion signal there is.
DISC_COVER_FILE=''
DISC_USE_MB=1

# Clear everything a previous disc left behind. A caller that reads two discs in
# one run must call this between them, or the second one inherits the first
# one's titles wherever its own lookup came up short.
disc_reset() {
  DISC_ALBUM=''; DISC_ALBUM_ARTIST=''; DISC_YEAR=''; DISC_SOURCE=''
  DISC_DISCID=''; DISC_MB_TOC=''; DISC_MB_RELEASE=''
  DISC_NO=1; DISC_TOTAL=1
  DISC_FIRST=0; DISC_LAST=0; DISC_LEADOUT=0
  DISC_TITLE=(); DISC_ARTIST=()
  DISC_LBA=(); DISC_FRAMES=(); DISC_CONTROL=()
  DISC_VOLUME=''; DISC_COVER_FILE=''
  return 0
}

# ------------------------------------------------------------------- media --

# Whether the drive has anything in it at all. drutil answers for the drive
# rather than for the filesystem, so it is the one thing that can tell an empty
# bay from a disc that has not finished mounting.
optical_media() {
  local t
  command -v drutil >/dev/null || return 1
  t=$( (drutil status 2>/dev/null || true) | awk -F: '/Type:/ { print $2; exit }' )
  t=$( printf '%s' "$t" | tr -d ' ' )
  case "$t" in ''|[Nn]o*) return 1 ;; esac
  return 0
}

# An audio CD, as macOS presents one: mounted as a volume of .aiff tracks by the
# CDDA filesystem, which is what makes a disc playable with no ripping step at
# all. drutil is asked first because it knows about a disc that has not finished
# mounting, and it is what tells a blank CD-R apart from an album.
find_cd() {
  local line dev rest mp opts v n
  DISC_VOLUME=''

  # The answer that comes from the kernel rather than from what a directory
  # happens to hold: macOS mounts an audio CD with the CDDA filesystem, and
  # nothing else on the machine uses it.
  #
  # Split off the device on the first " on " and the options on the last " (":
  # a device node has no spaces in it, so the front is exact, and taking the
  # last bracket leaves a volume called "Live (Remastered)" with its own name.
  while IFS= read -r line; do
    case "$line" in *' on '*) ;; *) continue ;; esac
    dev=${line%% on *}; rest=${line#* on }
    mp=${rest% (*}; opts=${rest##* (}
    case "$opts" in cddafs,*|cddafs\)*) ;; *) continue ;; esac
    [ -d "$mp" ] || continue
    DISC_VOLUME="$mp"; return 0
  done < <(mount 2>/dev/null || true)

  # Some discs mount as a plain volume of named tracks instead, so a volume of
  # nothing but .aiff files is still worth offering — but only once the drive
  # has said it has a disc in it. A directory listing cannot tell an album from
  # an external drive of field recordings; the drive can, and without asking it
  # that drive gets announced as "in the drive" and then has CD-Text and
  # MusicBrainz answers about some entirely other disc applied to its files.
  optical_media || return 1

  for v in /Volumes/*; do
    [ -d "$v" ] || continue
    n=$( (ls "$v" 2>/dev/null || true) | grep -ic '\.aiff\?$' || true )
    [ "${n:-0}" -gt 0 ] || continue
    if (ls "$v" 2>/dev/null || true) | qgrep -i 'Audio Track'; then
      DISC_VOLUME="$v"; return 0
    fi
    [ "${n:-0}" -ge 2 ] && { DISC_VOLUME="$v"; return 0; }
  done
  return 1
}

# --------------------------------------------------------------------- TOC --

# The table of contents, and the MusicBrainz disc ID computed from it.
#
# The disc ID is SHA-1 over the first track, the last track, the lead-out offset
# and all 99 track offsets, each as uppercase hex, then base64 with a URL-safe
# alphabet. It is a fingerprint of the pressing, which is why it can tell two
# masterings of the same album apart.
#
# The offsets come from the drive's table of contents in frames, plus the 150
# frame pre-gap that every CD address is measured from.
#
# The per-track numbers are kept rather than thrown away once the hash is built.
# They cost a second loop over a list already in hand, and without them a caller
# ripping the disc has no way to know how long a track should be — on the raw
# path there are no files to ask, and the length is the only honest test of
# whether a track came off whole.
disc_toc() {  # disc_toc -> $DISC_DISCID, $DISC_MB_TOC, $DISC_LBA/FRAMES/CONTROL
  local out line n off ctl hex='' i nxt
  local -a OFFS
  DISC_DISCID=''; DISC_MB_TOC=''
  DISC_FIRST=0; DISC_LAST=0; DISC_LEADOUT=0
  DISC_LBA=(); DISC_FRAMES=(); DISC_CONTROL=()
  command -v cdrecord >/dev/null || return 1
  command -v shasum   >/dev/null || return 1
  detect_dev || true

  out=$( (cdrecord dev="$DEV" -toc 2>&1) || true )
  OFFS=()
  # "track:   1 lba:         0 (       0) 00:02:00 adr: 1 control: 0 mode: -1"
  while IFS= read -r line; do
    n=$(printf '%s' "$line" | sed -n 's/^track:[ ]*\([0-9]*\).*/\1/p')
    off=$(printf '%s' "$line" | sed -n 's/.*lba:[ ]*\(-*[0-9]*\).*/\1/p')
    case "$n$off" in ''|*[!0-9-]*) continue ;; esac
    case "$n" in ''|*[!0-9]*) continue ;; esac
    case "$off" in ''|*[!0-9-]*) continue ;; esac
    n=$(( 10#$n ))
    OFFS[$n]=$(( off + 150 ))
    DISC_LBA[$n]=$off
    # Absent on a drive or a cdrtools that does not print it, which is not worth
    # failing over: an audio track is the assumption everywhere else here, and 0
    # is exactly that.
    ctl=$(printf '%s' "$line" | sed -n 's/.*control:[ ]*\([0-9]*\).*/\1/p')
    case "$ctl" in ''|*[!0-9]*) ctl=0 ;; esac
    DISC_CONTROL[$n]=$ctl
    [ "$DISC_FIRST" -eq 0 ] && DISC_FIRST=$n
    [ "$n" -gt "$DISC_LAST" ] && DISC_LAST=$n
  done < <(printf '%s\n' "$out" | grep '^track:' || true)

  # The lead-out is track 0xAA in the TOC, printed by cdrtools as "lout".
  DISC_LEADOUT=$(printf '%s\n' "$out" \
    | sed -n 's/^track:[ ]*lout[ ]*lba:[ ]*\([0-9]*\).*/\1/p' | head -1)
  case "$DISC_LEADOUT" in ''|*[!0-9]*) DISC_LEADOUT=0; return 1 ;; esac

  [ "$DISC_FIRST" -gt 0 ] && [ "$DISC_LAST" -ge "$DISC_FIRST" ] || return 1

  # Where each track ends is where the next one starts, and the last one ends at
  # the lead-out. Done here rather than by the caller because it is the one
  # thing about a TOC that is not simply read off it.
  i=$DISC_FIRST
  while [ "$i" -le "$DISC_LAST" ]; do
    if [ "$i" -eq "$DISC_LAST" ]; then nxt=$DISC_LEADOUT
    else nxt=${DISC_LBA[$(( i + 1 ))]:-$DISC_LEADOUT}
    fi
    DISC_FRAMES[$i]=$(( nxt - ${DISC_LBA[$i]:-0} ))
    [ "${DISC_FRAMES[$i]}" -lt 0 ] && DISC_FRAMES[$i]=0
    i=$(( i + 1 ))
  done

  printf -v hex '%02X%02X%08X' "$DISC_FIRST" "$DISC_LAST" "$(( DISC_LEADOUT + 150 ))"
  DISC_MB_TOC="$DISC_FIRST $DISC_LAST $(( DISC_LEADOUT + 150 ))"
  i=1
  while [ "$i" -le 99 ]; do
    printf -v hex '%s%08X' "$hex" "${OFFS[$i]:-0}"
    [ "$i" -ge "$DISC_FIRST" ] && [ "$i" -le "$DISC_LAST" ] \
      && DISC_MB_TOC="$DISC_MB_TOC ${OFFS[$i]:-0}"
    i=$(( i + 1 ))
  done

  # base64 of the raw SHA-1, then MusicBrainz's own alphabet: + / = become . _ -
  DISC_DISCID=$(printf '%s' "$hex" | shasum -b 2>/dev/null \
    | cut -d' ' -f1 | xxd -r -p 2>/dev/null | base64 2>/dev/null \
    | tr '+/=' '._-' | tr -d '\n')
  [ -n "$DISC_DISCID" ] || return 1
  return 0
}

# Whether track n is audio. Bit 2 of the control field marks a data track, which
# on a mixed-mode disc sits at the end holding a CD-ROM filesystem: rippable in
# the sense that the bytes come off, and never music.
disc_is_audio() {  # disc_is_audio <trackno>
  [ $(( ${DISC_CONTROL[$1]:-0} & 4 )) -eq 0 ]
}

# Whether track n was recorded with pre-emphasis — a treble boost the player was
# meant to undo, on a handful of early-eighties discs. Reported, never corrected:
# undoing it is a filter, and a filter on a copy that is otherwise bit-perfect is
# a decision that belongs to whoever plays the result.
disc_has_preemph() {  # disc_has_preemph <trackno>
  [ $(( ${DISC_CONTROL[$1]:-0} & 1 )) -ne 0 ]
}

# ------------------------------------------------------------------ CD-Text --

# CD-Text off the disc. cdrtools prints it in a couple of shapes depending on
# version, so both are matched and neither is required.
#
# Every value on the disc arrives inside single quotes, and the quote that ends
# one is the one before " from '" or the one at the end of the line — not simply
# the next one along. Matching to the next one along cuts "Don't Stop Me Now"
# down to "Don", which is a title the disc does not have and no way to tell that
# from a disc that really is called that.
disc_cd_text() {
  local out line name n got=0 titles=0
  command -v cdrecord >/dev/null || command -v cdda2wav >/dev/null || return 1
  detect_dev || true

  out=''
  if command -v cdda2wav >/dev/null; then
    out=$( (cdda2wav dev="$DEV" -J -v titles 2>&1) || true )
  fi
  if ! printf '%s' "$out" | qgrep -i 'title'; then
    command -v cdrecord >/dev/null && out=$( (cdrecord dev="$DEV" -toc -v 2>&1) || true )
  fi
  [ -n "$out" ] || return 1

  # "Album title: 'Nonagon Infinity' from 'King Gizzard'"
  line=$(printf '%s\n' "$out" \
    | sed -n -e "s/^Album title:[ ]*'\(.*\)'[ ]*from[ ]*'.*'[ ]*\$/\1/p" \
             -e "s/^Album title:[ ]*'\(.*\)'[ ]*\$/\1/p" | head -1)
  [ -n "$line" ] && { DISC_ALBUM="$line"; got=1; }
  line=$(printf '%s\n' "$out" \
    | sed -n "s/^Album title:.*'[ ]*from[ ]*'\(.*\)'[ ]*\$/\1/p" | head -1)
  [ -n "$line" ] && { DISC_ALBUM_ARTIST="$line"; got=1; }

  # "Track  1 title: 'Robot Stop' from 'King Gizzard'"
  while IFS= read -r line; do
    n=$(printf '%s' "$line" | sed -n "s/^Track[ ]*\([0-9]*\).*/\1/p")
    case "$n" in ''|*[!0-9]*) continue ;; esac
    n=$(( 10#$n ))
    # Read into a local first: a shape this does not match would otherwise blank
    # whatever tidy default the caller has already put there, and a track with no
    # title at all is worse than one with a dull one.
    name=$(printf '%s' "$line" \
      | sed -n -e "s/^Track[ ]*[0-9]*[ ]*title:[ ]*'\(.*\)'[ ]*from[ ]*'.*'[ ]*\$/\1/p" \
               -e "s/^Track[ ]*[0-9]*[ ]*title:[ ]*'\(.*\)'[ ]*\$/\1/p")
    [ -n "$name" ] || continue
    DISC_TITLE[$n]="${name//[$'\t\n\r']/ }"
    name=$(printf '%s' "$line" \
      | sed -n "s/^Track[ ]*[0-9]*[ ]*title:.*'[ ]*from[ ]*'\(.*\)'[ ]*\$/\1/p")
    [ -n "$name" ] && DISC_ARTIST[$n]="${name//[$'\t\n\r']/ }"
    got=1; titles=$(( titles + 1 ))
  done < <(printf '%s\n' "$out" | grep -i '^Track[ ]*[0-9]*[ ]*title:' || true)

  # Not $got: an album title on its own is not a track list, and returning 0 for
  # one would both stamp CD-TEXT on the faceplate over a column of bare track
  # numbers and rob the disc of the MusicBrainz lookup that could have named
  # them. Whatever album and artist were found stay put either way — the lookup
  # overwrites what it knows better and leaves the rest alone.
  [ "$titles" -gt 0 ] || return 1
  DISC_SOURCE="CD-Text"
  return 0
}

# ------------------------------------------------------------- MusicBrainz --

# Ask MusicBrainz what disc this is. Deliberately forgiving: no network, a disc
# nobody has submitted, a rate limit or a malformed answer all mean the same
# thing here — the track numbers stay, and the caller says so.
disc_mb_lookup() {
  local json titles alb art n=0 t
  [ "$DISC_USE_MB" = 1 ] || return 1
  command -v curl >/dev/null || return 1
  disc_toc || return 1

  json=$(curl -sS -m 12 -A 'player/1.0 ( https://github.com/gvorbeck )' \
    "https://musicbrainz.org/ws/2/discid/${DISC_DISCID}?fmt=json&inc=recordings+artist-credits" \
    2>/dev/null || true)
  [ -n "$json" ] || return 1
  printf '%s' "$json" | qgrep '"releases"' || return 1

  if command -v jq >/dev/null; then
    alb=$(printf '%s' "$json" | jq -r '.releases[0].title // empty' 2>/dev/null || true)
    art=$(printf '%s' "$json" | jq -r '.releases[0]."artist-credit"[0].name // empty' 2>/dev/null || true)
    t=$(printf '%s' "$json"   | jq -r '.releases[0].date // empty' 2>/dev/null || true)
    # Kept for the sleeve. The Cover Art Archive is keyed on a release, and a
    # disc ID resolves to one exactly — which is the strongest identification
    # anything here ever gets, and worth writing down while we hold it.
    DISC_MB_RELEASE=$(printf '%s' "$json" | jq -r '.releases[0].id // empty' 2>/dev/null || true)
    # Which disc of the set this one is, matched on the disc ID that was used to
    # ask. This is what lets a caller tag disc two as disc two, and it is the
    # only place that number is ever going to come from — nothing on the disc
    # itself knows it is part of a set.
    DISC_NO=$(printf '%s' "$json" | jq -r --arg id "$DISC_DISCID" \
      '[.releases[0].media[]? | select([.discs[]?.id] | index($id))][0].position // empty' \
      2>/dev/null || true)
    case "$DISC_NO" in ''|*[!0-9]*) DISC_NO=1 ;; esac
    DISC_TOTAL=$(printf '%s' "$json" | jq -r '.releases[0].media | length' 2>/dev/null || true)
    case "$DISC_TOTAL" in ''|0|*[!0-9]*) DISC_TOTAL=1 ;; esac
    # The medium this disc actually is, matched on the disc ID that was used to
    # ask the question — not every medium that has one. A release is one entry
    # per disc in the box, so taking them all concatenates disc two's track list
    # onto disc one's, and the loop below then hands disc one's titles to
    # whichever disc is in the drive. Bracketed and indexed rather than piped
    # through select, because a medium carries several disc IDs for the same
    # pressing and select would emit it once per ID.
    titles=$(printf '%s' "$json" | jq -r --arg id "$DISC_DISCID" \
      '[.releases[0].media[]? | select([.discs[]?.id] | index($id))][0] | .tracks[]?.title' \
      2>/dev/null || true)
    # A release with one medium and no disc IDs listed against it is still that
    # medium, so a single-disc answer is worth taking on its own.
    [ -n "$titles" ] || titles=$(printf '%s' "$json" | jq -r \
      'select((.releases[0].media | length) == 1) | .releases[0].media[0].tracks[]?.title' \
      2>/dev/null || true)
  else
    return 1
  fi

  [ -n "$alb" ] && DISC_ALBUM="$alb"
  [ -n "$art" ] && DISC_ALBUM_ARTIST="$art"
  [ -n "$t" ]   && DISC_YEAR="${t%%-*}"

  # The list comes back in track order, so the nth title belongs to track n.
  # Which is not the nth row of anything the caller is holding — that mapping is
  # the caller's, and is why nothing here indexes by position.
  n=0
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    n=$(( n + 1 ))
    DISC_TITLE[$n]="${t//[$'\t\n\r']/ }"
    [ -n "$DISC_ALBUM_ARTIST" ] && DISC_ARTIST[$n]="$DISC_ALBUM_ARTIST"
  done < <(printf '%s\n' "$titles")

  [ "$n" -gt 0 ] || return 1
  DISC_SOURCE="MusicBrainz"
  return 0
}

# Candidate releases for a record that did not come out of the drive.
#
# A zip or a folder has tags and nothing else, so there is no disc ID to be exact
# with and the archive has to be asked by name. What comes back is a list rather
# than an answer, because an album is in MusicBrainz once per pressing — the
# original, the remaster, the European issue — and cover art is filed against a
# pressing rather than against the album. The first hit is quite often the one
# nobody ever scanned, so the fetch below walks the list until something has a
# front on it.
#
# The terms are matched as quoted phrases, which is strict on purpose: asked for
# an artist and an album that do not belong together, the catalogue answers with
# nothing rather than with its best guess. That is the property this depends on —
# a wrong cover drawn confidently beside the panel would be worse than none, and
# this is what makes that outcome unlikely enough not to need guarding against.
#
# --data-urlencode rather than pasting into the URL: titles carry ampersands,
# spaces and question marks, every one of which means something else in a query
# string. Quotes are stripped out of the terms first — they are the Lucene syntax
# that holds the phrase together, so a title containing one of its own would close
# the phrase early and leave the rest of the title parsed as query operators.
#
# Asked twice, because an empty answer is at least as often the server as the
# catalogue. MusicBrainz rate-limits to about a request a second and says so with
# a 503 whose body is an error rather than a release list, and its search index
# times out often enough to have done it twice while this was being written. Both
# arrive here as no results, and both are usually gone a second later. A pairing
# that genuinely is not in the catalogue answers twice over, which costs one
# spare request on a record that was never going to have a cover anyway.
mb_query() {  # mb_query <artist> <album>
  local q a=${1//\"/} b=${2//\"/} out try
  [ -n "$b" ] || return 1
  if [ -n "$a" ]; then q="artist:\"$a\" AND release:\"$b\""; else q="release:\"$b\""; fi
  for try in 1 2; do
    out=$(curl -sS -m 15 -G -A 'player/1.0 ( https://github.com/gvorbeck )' \
        --data-urlencode "query=$q" --data 'fmt=json' --data 'limit=5' \
        'https://musicbrainz.org/ws/2/release' 2>/dev/null \
      | jq -r '.releases[]?.id // empty' 2>/dev/null)
    [ -n "$out" ] && { printf '%s\n' "$out"; return 0; }
    sleep 1
  done
  return 1
}

mb_release_search() {  # mb_release_search [artist] [album]
  local a=${1:-$DISC_ALBUM_ARTIST} alb=${2:-$DISC_ALBUM} b
  [ "$DISC_USE_MB" = 1 ] || return 1
  [ -n "$alb" ] || return 1
  mb_query "$a" "$alb" && return 0
  # An untagged folder or zip has no title, only the name whoever made it gave
  # the file — "Comfort Eagle (1998) [FLAC]", "OK_Computer_(Remastered)". The
  # catalogue is matching a phrase against a real title, and none of that is in
  # the title, so the whole query misses on one bracket.
  b=$(printf '%s' "$alb" \
      | sed -E 's/[[({][^])}]*[])}]//g; s/_+/ /g; s/  +/ /g; s/^ +//; s/ +$//')
  [ -n "$b" ] && [ "$b" != "$alb" ] && { mb_query "$a" "$b" && return 0; }
  # The other half of the same convention: the folder is "Artist - Album", which
  # is both fields inside the one that is meant to be the title. Only worth trying
  # when there is no artist tag standing to contradict it.
  case "$b" in
    *' - '*) [ -z "$a" ] && { mb_query "${b%% - *}" "${b#* - }" && return 0; } ;;
  esac
  return 1
}

# ------------------------------------------------------------- cover art --

# Whether what came back is actually a picture.
#
# The Cover Art Archive answers with a redirect to the Internet Archive, and those
# nodes are not always well. A sick one has been seen serving an nginx error page
# under a 200 — and, worse, serving it labelled image/jpeg. Neither the status
# line nor the content type can be believed, so the only test worth making is
# whether a decoder can read the bytes, and that is the test.
art_ok() {  # art_ok <file> [min-side]
  local wh
  [ -s "$1" ] || return 1
  wh=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height \
       -of csv=p=0 "$1" 2>/dev/null || true)
  # ffprobe prints "500,500" for a picture and "0,0" for something it opened but
  # could not measure, which is why this cannot just look for a digit.
  case "$wh" in ''|0,0|*,0|0,*|*[!0-9,]*) return 1 ;; esac
  # The archive only ever sends one size, so the floor is for the pictures found
  # lying next to the record, where a logo or a thumbnail is as likely as a scan.
  [ -n "${2:-}" ] || return 0
  [ "${wh%%,*}" -ge "$2" ] && [ "${wh##*,}" -ge "$2" ]
}

# What this record is called on disk, so an album fetched once is not fetched
# again. The release ID when a disc gave us one, because that names a pressing
# exactly; otherwise the artist and the title folded down to letters and digits,
# so that the same album tagged two slightly different ways lands on one file.
art_key() {
  local s
  if [ -n "$DISC_MB_RELEASE" ]; then s="mbid-$DISC_MB_RELEASE"
  else s="${DISC_ALBUM_ARTIST}-${DISC_ALBUM}"; fi
  s=$(printf '%s' "$s" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')
  s=${s#-}; s=${s%-}; s=${s:0:80}; s=${s%-}
  [ -n "$s" ] || return 1
  printf '%s' "$s"
  return 0
}

# A record the archive has no cover for, remembered — but not for ever. Without
# this, an album with no scan costs two lookups on the network every single time
# it is played. Forgotten after a fortnight, so a cover uploaded in the meantime
# still turns up.
art_none_fresh() {  # art_none_fresh <cover-path>
  local f="$1.none"
  [ -f "$f" ] || return 1
  [ -n "$(find "$f" -mtime +14 2>/dev/null)" ] && { rm -f "$f"; return 1; }
  return 0
}

# Fetch a front cover and leave it where the panel can find it.
#
# Every part of this is allowed to fail and none of it is allowed to be noticed.
# It runs in the background from the moment the record starts, so the album is
# already playing while this is still deciding whether there is a cover at all —
# and when there is not, nothing about the panel changes.
#
# Downloaded beside the cache entry and moved onto it, so a file in the cache is
# always a whole one: the panel tests for the file and nothing else, and half a
# JPEG would be read as the cover and drawn as rubbish. The part file is named
# after the album rather than after this process, so a fetch that is killed
# mid-download leaves one file that the next attempt at the same record
# overwrites, instead of a new one every time.
art_fetch() {  # art_fetch <cover-path>
  local dst=$1 id ids tmp try n=0 rc=1
  # Scoped, and restored before this returns. Every command below is allowed to
  # fail, but leaving -e off past the end of the function would hand that licence
  # to the whole caller — which is survivable only for as long as this is run
  # nowhere but a subshell, and that is not a promise a library can make.
  set +e
  tmp="$dst.part"
  if [ -n "$DISC_MB_RELEASE" ]; then ids=$DISC_MB_RELEASE; else ids=$(mb_release_search); fi
  for id in $ids; do
    n=$(( n + 1 ))
    [ "$n" -gt 5 ] && break
    # Twice per candidate. A first failure is more often a sick archive node than
    # a missing cover, and the redirect lands on a different node next time.
    for try in 1 2; do
      rm -f "$tmp"
      curl -sSL -m 25 -o "$tmp" -A 'player/1.0 ( https://github.com/gvorbeck )' \
        "https://coverartarchive.org/release/$id/front-500" 2>/dev/null
      if art_ok "$tmp" && mv -f "$tmp" "$dst" 2>/dev/null; then rc=0; break 2; fi
    done
  done
  if [ "$rc" -ne 0 ]; then
    rm -f "$tmp"
    : > "$dst.none" 2>/dev/null
  fi
  set -e
  return "$rc"
}

ART_GLOB=( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp'
           -o -iname '*.gif' -o -iname '*.bmp'  -o -iname '*.tif' -o -iname '*.tiff' )

# The sleeve the record came with, if it came with one.
#
# Worth looking for before the network is asked anything, and worth preferring to
# what comes back: this is the artwork that shipped with this copy, where the
# archive can only offer a scan of whichever release the album name matched — and
# the name is the weakest thing there is to match on.
#
# What it is called is the whole difficulty. Rips settle on cover or folder or
# front; Bandcamp names its picture "Artist - Album.jpg", which is no convention
# at all. So the known names are ranked first and everything else is still
# allowed after them, shallowest path first. The scans that are definitely not
# the front — the back, the booklet, the face of the disc — are thrown out
# rather than ranked last, because drawing one of those confidently beside the
# panel is worse than the network answer they would have displaced.
art_local() {  # art_local <directory>
  local f d=${1:-}
  [ -n "$d" ] && [ -d "$d" ] || return 1
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    # 200 is well under the 500 the archive sends and well over anything that is
    # really a thumbnail or a label logo.
    if art_ok "$f" 200; then printf '%s' "$f"; return 0; fi
  done < <(
    find "$d" -maxdepth 3 -type f \( "${ART_GLOB[@]}" \) 2>/dev/null |
      awk -F/ '
        {
          base = tolower($NF)
          sub(/\.[^.]*$/, "", base)
          # Separators folded to spaces so the words can be matched as words:
          # "front-cover" is a front cover, and "discovery" is not a disc.
          gsub(/[_ -]+/, " ", base)
          if (base ~ /(^| )(back|inlay|booklet|tray|obi|spine|label|matrix|inside|thumb|thumbnail)( |$)/) next
          if (base ~ /(^| )(disc|cd|dvd)[0-9]*( |$)/) next
          if (base ~ /^(cover|front|folder|album|albumart|artwork|sleeve)$/) rank = 1
          else if (base ~ /(^| )(cover|front)( |$)/) rank = 2
          else if (base ~ /(cover|front)/) rank = 3
          else rank = 4
          print rank "\t" NF "\t" $0
        }' |
      LC_ALL=C sort -t"$(printf '\t')" -k1,1n -k2,2n -k3,3 |
      cut -f3-
  )
  return 1
}

# Work out where this record's sleeve belongs and, if it is not there already,
# go and get it in the background.
#
# The caller gets one string back in DISC_COVER_FILE and nothing else: no pid, no
# job to wait on, no way to be told it finished. That is deliberate and it is
# what makes the fetch safe to orphan — it writes only into the cache directory,
# and the part-file rename means the path either holds a whole picture or holds
# nothing. Testing for the file is the completion signal, and a caller is free to
# test once at the end or every second while it draws.
disc_cover_start() {  # disc_cover_start <cache-dir>
  local cache=${1:-} key
  DISC_COVER_FILE=''
  [ -n "$cache" ] || return 0
  command -v ffprobe >/dev/null || return 0
  command -v curl >/dev/null && command -v jq >/dev/null || return 0
  [ -n "$DISC_ALBUM" ] || return 0
  # Nothing to search with. A disc that came with a release ID can go straight to
  # the archive, but without one the only way to find a cover is to ask
  # MusicBrainz by name — and if lookups are off, that is not a record with no
  # cover, it is a question that was never asked. Stopping here rather than
  # letting the fetch fail is what keeps it from writing the "no cover exists"
  # marker below, which would then suppress the sleeve on the next run that has
  # the network turned back on.
  [ -n "$DISC_MB_RELEASE" ] || [ "$DISC_USE_MB" = 1 ] || return 0
  mkdir -p "$cache" 2>/dev/null || return 0
  key=$(art_key) || return 0
  DISC_COVER_FILE="$cache/$key.jpg"
  # Already on disk from a previous session, or already known not to exist.
  # Either way there is nothing to ask the network.
  [ -s "$DISC_COVER_FILE" ] && return 0
  art_none_fresh "$DISC_COVER_FILE" && return 0
  ( art_fetch "$DISC_COVER_FILE" >/dev/null 2>&1 ) &
  return 0
}
