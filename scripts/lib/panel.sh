# panel.sh — the faceplate burncd and player are both built on.
#
# Sourced, never run. It holds the layer the two tools genuinely share: the
# locale repair every width calculation rests on, the panel's geometry and
# palette, the alternate-screen handling, the column-accurate width primitives,
# the capacity meter, raw-mode key reading, and the health-check scaffolding.
#
# Nothing in here knows what a disc is for. Anything that does — burning,
# playing, tags, MusicBrainz, mpv, cdrecord — belongs in the tool, not here.
#
# The two tools are one instrument at two moments of the same disc: the picture
# you approve before burning is the picture you watch while playing back. That
# is only true for as long as one file decides what the picture is. An earlier
# arrangement had the meter copied into both, and it drifted inside a month —
# the burn bar quietly stopped drawing partial blocks, which threw away every
# eighth the band arithmetic had just worked out and let a 3:00 track and a 3:18
# track come out the same width.
#
# Contract with the caller, both before sourcing:
#
#   APP             the tool's name, lowercase. Names the badge and every error.
#   set -euo pipefail   assumed, not set here.
#
# Optional, any time after:
#
#   SCREEN_OFF_PRE  escapes to emit before the screen is handed back, for modes
#                   the tool turned on that this file knows nothing about.
#
# Callers own their own INT trap. screen_on installs WINCH and nothing else,
# because what a Ctrl-C has to take with it differs: a half-written disc image
# is not a scratch directory with a player running out of it.

: "${APP:?panel.sh: set APP before sourcing}"

# Every rule, meter cell and track title is UTF-8, and ${#s} counts bytes unless
# the ctype locale says otherwise — one accented title would then shove the whole
# column grid sideways. Only the ctype category is changed, so collation and
# number formatting are left exactly as the user has them.
#
# LC_ALL has to be dismantled first when it is what pins the locale: bash ignores
# LC_CTYPE for as long as LC_ALL is set and non-empty, so exporting one under the
# other looks like a fix and does nothing. Someone with LC_ALL=C in their profile
# for reproducible sorting is exactly the person this block exists for. Handing
# its value to the other five categories keeps every one of them where it was.
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *UTF-8*|*utf-8*|*UTF8*|*utf8*) ;;
  *) if [ -n "${LC_ALL:-}" ]; then
       export LC_COLLATE="$LC_ALL"  LC_NUMERIC="$LC_ALL"  LC_TIME="$LC_ALL" \
              LC_MONETARY="$LC_ALL" LC_MESSAGES="$LC_ALL"
       unset LC_ALL
     fi
     LOCALES=$( (locale -a 2>/dev/null || true) | tr '\n' ' ' )
     case " $LOCALES " in
       *" en_US.UTF-8 "*) export LC_CTYPE=en_US.UTF-8 ;;
       *" C.UTF-8 "*)     export LC_CTYPE=C.UTF-8 ;;
       *)                 export LC_CTYPE=UTF-8 ;;   # BSD libc accepts the bare name
     esac ;;
esac

# Whether any of that worked, asked of the shell rather than of the locale's
# name: this one comparison is the exact property every width calculation rests
# on. One character, two bytes. Everywhere else that wants to know reads UTF8
# instead of re-deriving it from the environment and getting a slightly
# different answer.
UTF8_PROBE='é'
if [ "${#UTF8_PROBE}" -eq 1 ]; then UTF8=1; else UTF8=0; fi

# ---------------------------------------------------------------- geometry --

# The panel is a fixed 71 columns: 2 of margin plus a 69-column grid that the
# faceplate, the track rows and every meter share. Fixed rather than fluid
# because every column here has a job — 34 for a title, 20 for an artist — and
# a grid that reflows is a grid you cannot learn.
PANEL=69
# A meter gets the whole grid minus its two brackets, and its readout moves to a
# line of its own. Width is the only thing that buys resolution: eleven tracks
# across a half-full disc had about two cells each, and at two cells the
# difference between a 3:14 and a 2:58 is not a thing the bar can say.
STRIP_WIDTH=$(( PANEL - 2 ))

# Panel palette. The screen is dressed as the faceplate of a deck that never
# existed: amber silkscreen on black, backlit keycaps, a tape-counter readout.
# Amber is the chrome — rules, labels, the badge — and never the data, so the
# titles stay the brightest thing on the screen.
AMBER='\033[38;5;214m'      # lit amber, for the readout and keycap legends
ETCH='\033[38;5;172m'       # the darker amber of paint on a metal panel
BADGE='\033[48;5;214m\033[38;5;232m'   # engraved plate: black on amber
CAP='\033[48;5;236m\033[38;5;214m'     # a keycap, backlit from behind
OFF='\033[0m'
DIM='\033[2m'
INV='\033[7m'
# Four steps around the panel's own amber rather than four cool hues: cyan and
# violet on an amber faceplate read as a different instrument bolted on. These
# stay in the lamp-and-oxide family — amber, brown, gold, burnt orange — and
# zigzag light/dark/light/dark, so neighbouring bands separate on brightness even
# where the hues are cousins, and the edges survive without colour vision.
SHADES=(214 130 220 166)
RUNOUT=94              # the darkest amber on the ramp: everything not yet used
HEAD=231               # the head, the brightest thing on the screen

# ---------------------------------------------------------------- plumbing --

# Repetition and padding returned in globals instead of on stdout. Every $( ) is
# a fork, forks on macOS cost a millisecond or two, and one frame of a panel
# wanted about 130 of them — a quarter of a second of lag after an arrow key,
# which is exactly long enough to feel. Nothing on a hot path spawns a process
# now; it all writes into REP, PAD, FIT, MMSS.
SPACES='                                                                                '
pad() {  # pad <count> -> $PAD
  PAD=''
  [ "$1" -gt 0 ] || return 0
  while [ "$1" -gt "${#SPACES}" ]; do SPACES="$SPACES$SPACES"; done
  PAD=${SPACES:0:$1}
}
repv() {  # repv <char> <count> -> $REP
  REP=''
  [ "$2" -gt 0 ] || return 0
  pad "$2"
  REP=${PAD// /$1}
}
rep() { repv "$1" "$2"; printf '%s' "$REP"; }

# How big the window actually is. Not plain `tput lines`: tput measures the
# terminal attached to its own stdout, and inside $( ) that is a pipe, so it
# falls back to whatever static size the terminfo entry declares — 24x80 for
# most xterm entries. A panel would then page a 30-track album in a 50-row
# window for no reason. stty asks the kernel for the real window size off
# /dev/tty, which no redirection can move.
#
# The answer lands in globals and is cached, because asking costs an exec and a
# panel asks once per keypress. The SIGWINCH handler screen_on installs clears
# the cache, so a resized window is still noticed at the next redraw.
TERM_LINES='' TERM_COLS=''
term_size() {  # term_size -> $TERM_LINES, $TERM_COLS
  local sz
  [ -n "$TERM_LINES" ] && [ -n "$TERM_COLS" ] && return 0
  sz=$( (stty size </dev/tty) 2>/dev/null || true )
  TERM_LINES=${sz%% *}
  TERM_COLS=${sz##* }
  case "$TERM_LINES" in ''|*[!0-9]*|0) TERM_LINES=$(tput lines 2>/dev/null || true) ;; esac
  case "$TERM_COLS"  in ''|*[!0-9]*|0) TERM_COLS=$(tput cols 2>/dev/null || true) ;; esac
  case "$TERM_LINES" in ''|*[!0-9]*|0) TERM_LINES=24 ;; esac
  case "$TERM_COLS"  in ''|*[!0-9]*|0) TERM_COLS=80 ;; esac
  return 0
}

# Seconds -> M:SS, on stdout or (on a panel's hot path) in $MMSS.
mmss()  { printf '%d:%02d' $(( $1 / 60 )) $(( $1 % 60 )); }
mmssv() { printf -v MMSS '%d:%02d' $(( $1 / 60 )) $(( $1 % 60 )); }

# Quiet match on a pipe. Not `grep -q`: that exits at the first match and closes
# the pipe, and under `set -o pipefail` the SIGPIPE that kills the writer fails
# the whole test — so a capability that is present reads as absent, depending on
# whether the writer happened to finish first. Reading to EOF is the difference
# between a check that works and one that lies.
qgrep() { grep "$@" >/dev/null; }

# ------------------------------------------------------------------ screen --

# Each tool is one instrument for the length of a job, not a program that prints.
#
# Every stage happens on the alternate screen, laid over the last from the home
# position. Nothing scrolls, nothing stacks, and the scrollback underneath is
# untouched until the job is over.
#
# It is all-or-nothing on purpose. A pipe, a dry run, or a window too small to
# hold the panel gets the old behaviour, printed line by line, and every stage
# checks $SCREEN rather than assuming it owns the terminal.
SCREEN=0
SCREEN_STTY=''
SCREEN_OFF_PRE=''

screen_on() {
  [ "$SCREEN" -eq 1 ] && return 0
  [ -t 0 ] && [ -t 1 ] || return 1
  SCREEN_STTY=$(stty -g 2>/dev/null || true)
  # Erase on the way in only. Every frame after this one is laid over its
  # predecessor rather than drawn on a cleared screen — see paint().
  printf '\033[?1049h\033[?25l\033[H\033[2J'
  SCREEN=1
  # Drop the cached window size when the window changes, so the next frame
  # measures again and every other frame does not have to.
  trap 'TERM_LINES=; TERM_COLS=' WINCH
  return 0
}

# Idempotent, and called from die() and from an exit trap as much as from the
# ordinary end of a job: whatever goes wrong, the terminal is handed back with
# its cursor visible, its modes as they were, and the scrollback intact.
#
# SCREEN_OFF_PRE goes first because it undoes modes set on top of the alternate
# screen — mouse reporting, say — and leaving those on after the buffer is gone
# hands back a terminal that swallows drags.
screen_off() {
  [ "$SCREEN" -eq 1 ] || return 0
  SCREEN=0
  [ -n "$SCREEN_STTY" ] && stty "$SCREEN_STTY" 2>/dev/null || true
  printf '%b\033[?25h\033[?1049l' "$SCREEN_OFF_PRE"
  return 0
}

# Lay one frame over the screen from the home position.
#
# No erase first, and one write for the whole frame. Clearing and then drawing is
# two pictures the terminal genuinely paints, so the blank one shows through as a
# flash — and printing a panel line by line lets the screen refresh mid-frame on
# top of that. Instead: end every line with an erase-to-end-of-line so a line that
# got shorter cannot leave the tail of the old one behind, and \033[J at the
# bottom to clear whatever the previous frame had below this one. Nothing is ever
# blank in between, so there is nothing to flicker.
#
# The frame must be at most one line shorter than the window. \033[H is absolute,
# so a frame that scrolls the terminal loses its own top row permanently — the
# next frame homes to a row that now holds something else.
#
# PAINT_COLS is for a caller that draws something beside the panel and needs it to
# survive: set to the number of columns the frame owns, the per-line erase becomes
# an erase of exactly those columns and everything to the right of them is left
# alone. The player puts the cover there, and a cover that has to be re-decoded
# every time it is erased is the one thing on the screen that cannot be redrawn
# inside a single frame — which is the whole reason this knob exists. Zero keeps
# the erase-to-end-of-line above, which is what a panel with nothing beside it
# wants: it needs no bookkeeping about what used to be out there.
PAINT_COLS=0

paint() {  # paint <frame> [overlay]
  local nl=$'\n' eol=$'\033[K\n' pre
  # The overlay is written in the same printf as the frame rather than after it,
  # so a rebuilt panel reaches the terminal as one write and there is no instant
  # where the screen holds the frame without it. It comes through %b because it
  # is escape sequences written as text, where the frame arrives already escaped.
  if [ "$PAINT_COLS" -gt 0 ]; then
    # ECH erases a fixed count of cells from the cursor without moving it, so it
    # can bound what the erase touches where \033[K cannot. It has to go before
    # the line rather than after it: after, the cursor sits at the end of the
    # content, and working out how far along the row that is means knowing the
    # visible width of a string that is mostly colour escapes. Before, the cursor
    # is at column one, the count is a constant, and the content is written over
    # the cells it just cleared.
    printf -v pre '\033[%dX' "$PAINT_COLS"
    printf '\033[H%s%s\033[K\n\033[J%b' "$pre" "${1//$nl/$nl$pre}" "${2:-}"
    return 0
  fi
  printf '\033[H%s\033[K\n\033[J%b' "${1//$nl/$eol}" "${2:-}"
  return 0
}

# The badge is the tool's own name, which is the only thing on the faceplate
# that differs between them.
APP_BADGE=" $(printf '%s' "$APP" | tr '[:lower:]' '[:upper:]') "

# The faceplate every screen wears: engraved badge, a rule across the panel, and
# the state of the machine stamped at the far end the way a deck prints its mode.
# Every stage of every job prints this same line, which is most of why they read
# as one instrument.
faceplate() {  # faceplate <meta>
  local rule=$(( PANEL - ${#APP_BADGE} - 2 - ${#1} ))
  [ "$rule" -lt 2 ] && rule=2
  repv '━' "$rule"
  printf '  %b%s%b %b%s%b %b%s%b\n' \
    "$BADGE" "$APP_BADGE" "$OFF" "$ETCH" "$REP" "$OFF" "$ETCH" "$1" "$OFF"
  return 0
}

die() { screen_off; printf '\n%s: %s\n' "$APP" "$1" >&2; exit 1; }

# The tool's own header comment, reprinted. $0 is the script that sourced this
# one — through a symlink if that is how it was installed, which awk follows.
usage() {
  awk 'NR > 2 && /^#/ { sub(/^# ?/, ""); print; next } NR > 2 { exit }' "$0"
  exit "${1:-0}"
}

# ------------------------------------------------------------------- width --

# How many columns one character takes. Characters are not all one column wide:
# a CJK ideograph, a kana, a Hangul syllable, a fullwidth form or an emoji is
# drawn two columns wide, so ${#s} — which counts characters — is half the truth
# for a Japanese title, and the grid built on it comes out with the artist column
# a dozen places to the right and the whole panel bent out of shape.
#
# Testing by glob range rather than by code point because there is no code point
# to test: bash 3.2 is what ships with macOS, and printf '%d' "'字" there gives
# the first byte of the character as a signed char, not its code point. Range
# patterns over multibyte characters do work, so that is the mechanism.
CW=1
cwidth() {  # cwidth <character> -> $CW
  case "$1" in
    [⺀-〿]|[぀-ヿ]|[一-鿿]|[가-힣]|[！-｠]|[🀀-🿿]) CW=2 ;;
    *) CW=1 ;;
  esac
}

# Columns a whole string takes. The common case is a Latin title with no wide
# character in it anywhere, and for that ${#s} is already the answer — so ask
# that question of the whole string once, and only walk it character by character
# if the answer is yes. Same ranges as cwidth, written as a substring test; they
# have to stay in step.
WCOLS=0
wcols() {  # wcols <string> -> $WCOLS
  local s=$1 i=0 n=0
  case "$s" in
    *[⺀-〿]*|*[぀-ヿ]*|*[一-鿿]*|*[가-힣]*|*[！-｠]*|*[🀀-🿿]*) ;;
    *) WCOLS=${#s}; return 0 ;;
  esac
  while [ "$i" -lt "${#s}" ]; do
    cwidth "${s:$i:1}"
    n=$(( n + CW ))
    i=$(( i + 1 ))
  done
  WCOLS=$n
  return 0
}

# Pad or truncate to an exact column count. Not printf's own width and precision:
# those are counted in bytes even under a UTF-8 locale, so "Björk — Homogénic"
# cut to 34 loses 34 bytes rather than 34 columns and the artist column after it
# slides left. Substring expansion counts characters, which is closer but still
# not columns; wcols is. A cut title ends in … so the truncation is visible.
FIT=''
fitv() {  # fitv <string> <columns> [right] -> $FIT
  local s=$1 i=0 w=0 keep='' lim
  wcols "$s"
  if [ "$WCOLS" -gt "$2" ]; then
    # Cut by columns, taking whole characters: a two-column character that would
    # straddle the last place is left out rather than half-drawn, which leaves a
    # column over for pad to fill.
    lim=$(( $2 - 1 ))
    while [ "$i" -lt "${#s}" ]; do
      cwidth "${s:$i:1}"
      [ $(( w + CW )) -gt "$lim" ] && break
      keep="$keep${s:$i:1}"
      w=$(( w + CW ))
      i=$(( i + 1 ))
    done
    # Braces are not optional: bash 3.2 reads "$keep…" as one name and hands back
    # the tail of the ellipsis's own bytes.
    s="${keep}…"
    WCOLS=$(( w + 1 ))
  fi
  pad $(( $2 - WCOLS ))
  # Right-aligned is the same fit with the slack moved to the front. It is asked
  # for by a track list where the artist column stands against the durations:
  # two ragged edges facing each other read as a gap of no particular width,
  # where two flush ones read as a margin.
  if [ "${3:-}" = right ]; then FIT="$PAD$s"; else FIT="$s$PAD"; fi
}
fit() { fitv "$1" "$2"; printf '%s' "$FIT"; }

# One row of backlit keycaps, given as key/label pairs. Assembled in a string
# rather than one substitution per cap so the legend costs nothing to draw and
# still reads here as keys and labels instead of as escape codes.
keys() {  # keys <key> <label> [<key> <label> ...]
  local line='' sep=''
  while [ "$#" -gt 1 ]; do
    line="$line$sep$CAP $1 $OFF $2"
    sep='   '
    shift 2
  done
  printf '  %b\n' "$line"
}

# What is below the fold, worded the same way wherever a list gets clamped.
more_row() {  # more_row <count>
  printf '    %b▾ %d MORE%b\n' "$ETCH" "$1" "$OFF"
  return 0
}

# ------------------------------------------------------------------ meters --

# The capacity meter: one band per track, sized by its share of the whole, with
# the unused tail left unlit. Bands are tracks in four alternating ambers; the
# head is where the laser was and is now where the playhead is; the run-out is
# everything not yet reached. Makes "disc 2 is only two-thirds full" obvious at a
# glance, which is the moment to reorder the folder rather than after burning it.
#
# Everything about it is in service of one comparison — is this track longer than
# that one — so it is drawn at eighth-cell resolution: each column is eight units,
# and a boundary landing mid-column is drawn as a partial block of the outgoing
# band over the incoming one. That is eight times what the bar could otherwise
# resolve without taking a single extra column, which matters because a half-full
# disc of eleven tracks only has a few cells to give each one.
#
# bands() decides the widths and bandbar() draws them.

# Widths by largest remainder, not by walking a cumulative total. Truncating each
# running total independently made a longer track look narrower than a shorter
# one — a 3:14 rounded down while the 2:58 after it landed on a boundary and got
# more — which is exactly the comparison the meter exists to support. Here every
# track gets floor(its share) and the leftover units go to the largest fractions,
# so the total is still exact and a longer track can never be drawn narrower than
# a shorter one.
BEND=(); BCOL=()
bands() {  # bands <total-units> <duration>...  -> $BEND, $BCOL
  local units=$1 n=0 cum=0 used=0 left=0 best bi i pos=0 nb=0
  local -a D HC REM
  BEND=(); BCOL=(); D=(); HC=(); REM=()
  shift

  for i in "$@"; do
    D[$n]=$i
    cum=$(( cum + i ))
    n=$(( n + 1 ))
  done
  [ "$n" -gt 0 ] && [ "$cum" -gt 0 ] && [ "$units" -gt 0 ] || return 0

  i=0
  while [ "$i" -lt "$n" ]; do
    HC[$i]=$(( D[i] * units / cum ))
    REM[$i]=$(( D[i] * units % cum ))
    used=$(( used + HC[i] ))
    i=$(( i + 1 ))
  done
  left=$(( units - used ))
  while [ "$left" -gt 0 ]; do
    best=-1; bi=-1
    i=0
    while [ "$i" -lt "$n" ]; do
      [ "${REM[$i]}" -gt "$best" ] && { best=${REM[$i]}; bi=$i; }
      i=$(( i + 1 ))
    done
    [ "$bi" -lt 0 ] && break
    HC[$bi]=$(( HC[bi] + 1 ))
    REM[$bi]=-1          # spent, and -1 keeps it out of later rounds
    left=$(( left - 1 ))
  done

  # Where each band ends, in units, and what colour it is. A track too short to
  # earn a single unit ends up with no band at all and does not consume a colour,
  # so the two tracks either side of it still contrast.
  i=0
  while [ "$i" -lt "$n" ]; do
    if [ "${HC[$i]}" -gt 0 ]; then
      pos=$(( pos + HC[i] ))
      BEND[$nb]=$pos
      BCOL[$nb]=${SHADES[$(( nb % 4 ))]}
      nb=$(( nb + 1 ))
    fi
    i=$(( i + 1 ))
  done
  return 0
}

# One meter cell's colour, appended to $out only when it differs from what is
# already in effect — a fresh pair of escapes per cell would treble the size of
# the frame for nothing. Reads and writes the caller's locals, on purpose, which
# is what lets a tool build its own bars out of the same cells.
strip_sgr() {  # strip_sgr <fg> <bg-or-empty>
  [ "$1" = "$curfg" ] || { out="$out\033[38;5;$1m"; curfg=$1; }
  if [ -n "$2" ]; then
    [ "$2" = "$curbg" ] || { out="$out\033[48;5;$2m"; curbg=$2; }
  elif [ -n "$curbg" ]; then
    out="$out\033[49m"; curbg=''
  fi
}

# One row of meter, in $BANDBAR. A column wholly inside a band is a shaded block,
# a column a boundary runs through is a partial block of the outgoing colour laid
# over the incoming one as background, and anything past the last band is run-out.
#
# The head argument is where the laser or the playhead has got to, in the same
# units. A meter with nothing moving on it passes the full width, so nothing is
# ever behind the head there; a live one passes the real position and gets the
# same bar with an unwritten tail and a bright edge creeping along it. In a
# column the head is actually inside, the head wins over any band boundary
# sharing that column — it is the one thing on the bar that is moving, and it is
# gone again in a second.
#
# Not returned on stdout: a $( ) here is a fork, and this is redrawn on every
# message from the drive and several times a second while something is playing.
BANDBAR=''
bandbar() {  # bandbar <head-units> -- reads $BEND/$BCOL -> $BANDBAR
  local head=$1 j=0 b=0 nb=${#BEND[@]} cs ce t nxt
  local out='' curfg='' curbg=''
  # Unicode has a full set of left-aligned partial blocks, and a cell can show
  # two colours — foreground for the left part, background for the right — so a
  # boundary can be drawn where it actually falls rather than snapped to the
  # nearest whole character. At one unit per column a 3:14 and a 2:58 are the
  # same two cells; at eight it is about nine seconds to the unit.
  local PARTS=('' '▏' '▎' '▍' '▌' '▋' '▊' '▉')

  while [ "$j" -lt "$STRIP_WIDTH" ]; do
    cs=$(( j * 8 )); ce=$(( cs + 8 ))
    while [ "$b" -lt "$nb" ] && [ "${BEND[$b]}" -le "$cs" ]; do b=$(( b + 1 )); done
    if [ "$head" -gt "$cs" ] && [ "$head" -lt "$ce" ]; then
      strip_sgr "$HEAD" ''; out="${out}${PARTS[$(( head - cs ))]}"
    elif [ "$head" -le "$cs" ] || [ "$b" -ge "$nb" ]; then
      # Not yet reached, or past the last band: the run-out, dithered in the
      # darkest amber on the ramp rather than left blank, so it still reads as
      # part of the meter.
      strip_sgr "$RUNOUT" ''; out="${out}░"
    elif [ "${BEND[$b]}" -ge "$ce" ]; then
      # Shade rather than solid, for the phosphor-and-oxide texture the rest of
      # the panel has. The same shade the whole way across a band, though — an
      # earlier version varied the density within a band and the speckle read as
      # gaps, which broke the one thing the bar is for. Uniform grain costs
      # nothing: a shaded cell is exactly as wide as a solid one.
      strip_sgr "${BCOL[$b]}" ''; out="${out}▓"
    else
      t=$(( BEND[b] - cs ))
      nxt=$(( b + 1 ))
      if [ "$nxt" -lt "$nb" ]; then
        strip_sgr "${BCOL[$b]}" "${BCOL[$nxt]}"
      else
        strip_sgr "${BCOL[$b]}" ''      # last band meeting the run-out
      fi
      out="${out}${PARTS[$t]}"
    fi
    j=$(( j + 1 ))
  done
  BANDBAR="$out\033[0m"
  return 0
}

# ------------------------------------------------------------------- input --

tui_block()  { stty -echo -icanon min 1 time 0 2>/dev/null || true; }
tui_cooked() { stty echo icanon 2>/dev/null || true; }

# Every read here blocks. bash 3.2 has no sub-second read timeout, and the
# obvious alternative — flipping the terminal between blocking and polling
# around each keystroke — is worse than useless: stty flushes input that has
# already arrived, so a fast escape sequence loses bytes and arrow keys go
# missing. Staying in one mode means the three bytes of an arrow key are always
# read together. The cost is that a bare ESC waits for another key, which is why
# ESC is not bound to anything.
KEY=""
read_key() {  # read_key [fd-redirected by caller] -> $KEY
  local k c
  KEY=""
  IFS= read -rsn1 k 2>/dev/null || return 1
  # read discards its delimiter, so Return comes back as an empty string rather
  # than as a newline. Reading exactly one byte makes that unambiguous.
  [ -z "$k" ] && { KEY=$'\n'; return 0; }
  if [ "$k" = $'\033' ]; then
    IFS= read -rsn1 c 2>/dev/null || c=""
    k="$k$c"
    # CSI and SS3 sequences run until the first letter or tilde.
    if [ "$c" = "[" ] || [ "$c" = "O" ]; then
      while :; do
        IFS= read -rsn1 c 2>/dev/null || break
        [ -z "$c" ] && break
        k="$k$c"
        case "$c" in [A-Za-z~]) break ;; esac
      done
    fi
  fi
  KEY="$k"
  return 0
}

# ------------------------------------------------------------ health check --

# One pass/warn/fail line per thing that has to be true, and a verdict at the
# end. --check is the first thing anyone runs on a new machine, so it says what
# is wrong and what to install rather than failing later with a shell error.
CHECK_FAIL=0
CHECK_WARN=0

check_open() {
  CHECK_FAIL=0
  CHECK_WARN=0
  printf '\n  \033[1m%s health check\033[0m\n\n' "$APP"
  return 0
}

ck() {   # ck <ok|warn|fail> <label> <detail>
  case "$1" in
    ok)   printf '  \033[32m✓\033[0m  %-20s %s\n' "$2" "$3" ;;
    warn) printf '  \033[33m!\033[0m  %-20s %s\n' "$2" "$3"; CHECK_WARN=1 ;;
    fail) printf '  \033[31m✗\033[0m  %-20s %s\n' "$2" "$3"; CHECK_FAIL=1 ;;
  esac
}

# Returns non-zero only on a hard failure. A warning is worth printing and worth
# saying out loud at the end — an empty drive bay is a warning, and so is a
# terminal that will draw the panel wrong — but neither is a reason to refuse.
check_summary() {  # check_summary <ready-line> <not-ready-line>
  printf '\n'
  if [ "$CHECK_FAIL" -eq 1 ]; then
    printf '  \033[31m%s\033[0m Fix the ✗ items above.\n\n' "$2"
    return 1
  fi
  if [ "$CHECK_WARN" -eq 1 ]; then
    printf '  \033[33mMostly ready.\033[0m Warnings above are usually fine.\n\n'
  else
    printf '  \033[32m%s\033[0m\n\n' "$1"
  fi
  return 0
}

# ------------------------------------------------------------------- drive --

# macOS names an optical drive after the richest media class its driver
# publishes, not after what you intend to do with it: a SuperDrive that burns
# CD-Rs all day comes up as IODVDServices because it can also read a DVD, and
# IOCompactDiscServices exists only on drives that can do nothing else — which,
# outside a museum, is none of them. Hard-coding one name is how a working drive
# with a disc in it gets reported as no drive at all, so ask each name in turn
# and keep the first one cdrecord can actually open. DVD first: it is what every
# SuperDrive and USB burner still sold answers to.
#
# Memoised in $DEV, because -checkdrive spins the disc up and more than one
# caller wants the answer. A $DEV already set — from the environment, say — skips
# the search entirely: a device named by hand is not second-guessed, and its
# failure is reported against the name that was asked for.
detect_dev() {
  [ -n "$DEV" ] && return 0
  local class n cand
  for class in IODVDServices IOCompactDiscServices IOBDServices; do
    for n in 0 1; do
      cand="$class/$n"
      if cdrecord -checkdrive dev="$cand" >/dev/null 2>&1; then
        DEV="$cand"
        return 0
      fi
    done
  done
  # Nothing answered. Name the common case anyway so every message downstream
  # has something concrete to print and -scanbus has something to contradict.
  DEV="IODVDServices/0"
  return 1
}
