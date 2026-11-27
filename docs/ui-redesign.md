# An interface like BMW's own apps: the proposal (U1, step 1)

The owner, after the first install: "the app feels very homebrew, the design of it is a bit counter intuitive; could
its interface resemble the original iDrive 7 apps more?"

This is a proposal with pictures. No app code is changed. The owner approves or changes it; then step 2 builds it
(WORKPLAN.md section 9, U1).

- Pictures: `docs/ui-mock/*.png`, 1920 x 720, the whole centre display. Made by `tools/ui-mock.js` with the kit's
  own canvas, fonts and themes, so they show only what the kit can draw.
  Again: `docker run --rm -v "$PWD:/w" -w /w cmocan-tidal-kit node tools/ui-mock.js` (the image `make app-preview` builds).
- In every picture the title strip's home button, the status icons, the clock and the back arrow are **BMW's
  frame, sketched** from the owner's photos with shapes of our own. The app's name and tabs in the header and the
  bar at the bottom are the kit's, placed as the kit places them.
- **How sure the findings are:** section 1 was worked out from the code (the app and the kit's
  `kit/runtime/display.js`) and from the car's log (`docs/car-log.md`: renderer `mgu-render/1` with touch and
  controller, full-screen layout). Nothing in it was tried in the car for this document. Section 6 lists a
  five-minute check that confirms it.

## 1. What is counter-intuitive today

### The cause behind most of it: two programs handle the knob, and the car uses the other one

The app has its own rules for the controller (`apps/cmocan_tidal/nav.js`): knob moves the row, press chooses, push
left goes back one level, push right opens now playing, and now playing starts with the knob on Play / Pause.

In the car these rules do not run. With the Store's renderer the kit "runs the screen" and keeps the controller for
itself (`kit/runtime/display.js:204`: the app's handler is called only when the kit does not own the screen). The
kit's rule is one long chain for the knob: **the header's tabs, then everything on the page, then the bar**
(`display.js` `_ring`, line 272). `nav.js` is used only without the renderer, and in the tests. So the tests show an
interface the car does not have.

### Screen by screen

| Where | What happens in the car | Evidence | What an iDrive user expects |
|---|---|---|---|
| Every screen | The first knob step puts the focus on the **SETTINGS tab in the header**, not on the list. Until then a press does nothing | `display.js:385`: the first turn lands on the tab of the page shown, and with no page tabs that is place 0 of the chain, Settings | The list already has a highlighted row; turning moves it |
| Every screen | **Back never goes up one level.** The HMI's back arrow and the BACK key close the app's only screen, so they leave the app. Push left moves the focus to whatever lies to the left (the SETTINGS tab from the upper rows, PLAY / PAUSE in the bar from the lower ones); a second push left from there leaves the app | The app is one RHMI state (`app.json`: one screen); `display.js:374` `_toward`, `_back` | Back = one level up, everywhere |
| Every screen | Push right from a list row jumps to **LIBRARY** in the bar (the only thing to the right of the row's centre). The app meant it to open now playing (`nav.js:34`) | `display.js` `_toward` | A push sideways does the same thing on every screen |
| Every screen | The bar shows PLAY / PAUSE, NEXT, LIBRARY. **There is no PREVIOUS** (the photos show it). The app's button is called `BTN_PREV`, and that is the kit's name for "previous page", which it removes from the bar | `display.js:50` `PAGER`, line 949 | Previous beside Next |
| Every screen | Two highlight styles at once, in two colours: the app's own cyan row (`screens.js:22`, a fixed colour) and the kit's white ring with a red glow. The car's frame is red | `screens.js:22`; `display.js` `_drawChrome` | One highlight, in the theme's colour |
| Library | LIBRARY in the bar is the only way up, and it always goes to the top and forgets the lists that were open and where the knob was in them | `model.js:269` (`stack: []`) | Up one level, position kept |
| A list just opened | **The two highlights can sit on different rows, and the press follows the ring, not the filled row.** The kit keeps its focus by the row's number ("row 2"), the app starts a new list at row 0. Open Playlists (the third row of the library): the cyan row is the first playlist, the ring is on the third, and a press opens the third. Picture: `ui-mock/today-playlists.png` | `display.js:438` (the focus is a key, never reset); `model.js` `newFrame` (`sel: 0`) | The first row is highlighted and a press opens it |
| A long list | The knob leaves the list at its ends: up into SETTINGS, down into the bar. In a list of 500 tracks the bar can be reached with the knob only by going through all 500 rows | `_ring`: one chain | The knob stays in the list; the bar is one push down |
| A track list | One line per track with three columns spread over the whole width (title left, artist in the middle, time at the far right): the eye travels 1500 px to read one row. No sign of which track is playing. Position in the list: "8 of 120" counts what is loaded, not where the knob is | `listview.js` `COLS`; `screens.js` `drawList` | Title with the artist under it; the playing track marked; "12 of 120" |
| A track list | A track that cannot be played is grey but can still be chosen; the message then covers the bottom row | `screens.js` `drawToast` (golden `screen-list-tracks-unavailable.png`) | Greyed rows are skipped by the knob; messages do not cover rows |
| A track list | Choosing a track **jumps to now playing** by itself. To pick another track of the same list with the knob: 7 steps to LIBRARY in the bar, press, 8 steps back up to the list's row, press, and scroll to the place again | `tidal.js:149` (`played`), `model.js:292` | Stay, or come back with one move |
| Now playing | Play / Pause and Next exist twice on one screen (three pills on the page, and the bar), Previous once. The knob needs 3 steps and a press to pause: SETTINGS, Previous, Pause. The app's "starts on Play / Pause" is in `nav.js` only | `screens.js:236`; `_ring` | One set of controls; press = pause |
| Now playing | Pills with words, a cyan filled pill for the main action, a cyan progress bar | `screens.js` `drawNowPlaying` | Quiet type, the theme's colour only on the focused control |
| Search | 40 keys in keyboard rows, but the knob walks them as one line: 1 to 0, then Q to P, ... The first step is SETTINGS again; Search is the 40th place. The "starts on Q" is in `nav.js` only | `screens.js:147`; `_ring` | BMW's speller: one row of letters the knob turns through |
| Texts | Letters outside ASCII lose their marks (Știrile becomes Stirile) and anything else becomes "?" (東京 Nights becomes "?? Nights"), although the kit has a Chinese font | `text.js:37`; `kit/runtime/fonts/cjk.json` | Titles as they are written |
| Login, errors | Round pills as buttons; texts centred in the middle of the screen. Works, but looks unlike the car's own messages | `screens.js` `drawLogin`, `drawError` | A message with a short list of choices under it |

## 2. The proposed structure

Three places, shown as **tabs in the header** (the kit's own tabs, as its other apps have them): **LIBRARY**,
**NOW PLAYING**, **SETTINGS**. The tab of the place shown is underlined. **The bar is the same on every screen:
PREVIOUS, PLAY or PAUSE (the word says what a press does), NEXT.**

```
LIBRARY                                   NOW PLAYING                SETTINGS
  My music ──► Favourite tracks ─────────►  (cover, title,            (the kit's own
           ──► Favourite albums ► tracks ►   progress)                 settings list,
           ──► Playlists ► tracks ───────►                             unchanged)
           ──► Mixes ► tracks ───────────►
           ──► Search (letters, results) ►
           ──► Now playing
```

### One rule for the controller on every screen

| Input | Does |
|---|---|
| Turn the knob | Moves the highlight inside the list (or along the controls). It stops at both ends and never leaves into the header or the bar. Greyed rows are skipped |
| Press | Opens the row, plays the track, presses the control |
| Push left | **Back, one level.** From My music: leaves the app, as BMW's back does |
| Push right | To NOW PLAYING while a track is on. On now playing: to the list that is playing, at the playing track |
| Push down | To the bar (it remembers its button; first time PLAY / PAUSE). Push up returns to the row left |
| Push up | From the first row: to the header's tabs (turn, press) |
| HMI back arrow, BACK key | The same as push left. This part needs a trial in the car first (section 4, option A) |
| Touch | A tap on a row, a tab or a bar button does what a press there does. A finger drags a list |
| Steering wheel | Right / left: next / previous track, as today. Long press: seek, as task S2 builds it |
| Bar: PREVIOUS, PLAY / PAUSE, NEXT | The same on every screen |

A list that is opened again shows the row it was left on. Choosing a track starts it and **stays in the list**; the
playing mark moves to it. (Question 2 below: or go to now playing, as today.)

### Per screen

**My music** (`a-home.png`)

| Input | Does |
|---|---|
| Turn | Favourite tracks, Favourite albums, Playlists, Mixes, Search, Now playing (only while a track is on; the last row, so the others never move) |
| Press | Opens the row |
| Push left | Leaves the app |

**A list of albums, playlists or mixes** (`a-albums.png`)

| Input | Does |
|---|---|
| Turn | Row by row; the next 50 load before the end is reached (as today). The caption counts the highlighted row: "2 of 23" |
| Press | Opens its tracks |
| Push left | Back to My music, on the row it was opened from |

**A track list** (`a-tracks.png`, `a-notice.png`)

| Input | Does |
|---|---|
| Turn | Row by row. A track that cannot be played is grey, says "Not available", and is skipped |
| Press | Plays from this track on (the list is the queue, as today) |
| A long title | Cut with "…"; on the highlighted row it moves sideways after a second, as BMW's lists do |
| A message ("This track cannot be played here") | In the caption line for 5 seconds, in the warning colour. It never covers a row |

**Now playing** (`a-now-playing.png`)

| Input | Does |
|---|---|
| On arrival | The focus is on PAUSE in the bar: a press pauses at once |
| Turn | PREVIOUS, PAUSE, NEXT |
| Push up | To the progress line: turn = seek (as S2 builds it), press or push down = done |
| Push left | Back to where one came from |
| Push right | The list that is playing, at the playing track |
| The page | Cover; the list's name and "3 of 14"; title, artist, album; the progress line with both times; the next track's name when the list is known; the sound quality, small. No buttons on the page: the controls are the bar's, once |

**Search** (`a-search.png`)

| Input | Does |
|---|---|
| Turn | Along one row: A to Z, 123 (digits), space, delete, OK |
| Press | Adds the letter; OK searches |
| Push down | To the results (a normal track list). Push up: back to the letters |
| Push left | Back to My music |
| Touch | A tap on a letter adds it |
| While driving | No typing, as today (the letters are grey, one line says why). The last results stay and can be played |

**Login** (`a-login.png`): the QR code on the left, as the kit's own QR page has it; two numbered steps and the
code on the right; one choice, "New code". Only SETTINGS in the header. The bar is there but has nothing to do
(the kit cannot hide it on one page only).

**Errors** (`a-error.png`): a full page only when nothing else can be shown (no internet, no service, not found):
a headline, one sentence, and the choices as a short list with the first one highlighted. Push left = back. All
other errors are the one-line message in a list's caption.

## 3. The visual rules

All sizes are in the app's own units (the page is 1600 x 520; the kit scales it by 1.164 onto the screen), so the
build uses these numbers as they are.

| | Rule |
|---|---|
| Colours | Every colour comes from the kit's theme (`ctx.theme()`), none is fixed in the app: background `bg`, text `text`, second line and captions `dim`, **focus `sel`** (red in M Tricolour, the car's theme today), messages `warn`. The theme is the app's own setting (Settings, Colour theme: M Tricolour, M Red, Ice White, Night Amber). The kit does not read the car's own colour scheme; what the owner picks there, the whole app follows. Run `THEME=m_red` or `THEME=ice` on `tools/ui-mock.js` to see the others |
| The theme's colour | Used for one thing only: where the controller is. Not for the progress line, not for "primary" buttons, not for the playing mark (those are white) |
| The highlight | One, the same everywhere: the row's plate filled with the focus colour at 26 %, a 2.5 px edge in the full colour, corners 10. Text stays white and does not move. In the bar and the header: the kit's own highlight (it is already this colour) |
| Type | The kit's fonts (Ubuntu; BMW's own font is not ours to use). Headlines `light` 50 to 54 (54 is the largest size that has all letters). Row text `label` 27 (two-line rows) or 30 (one-line rows). Second line 20, captions 24, times and counts 22. Nothing smaller than 20. No bold except the login code |
| Rows | 70 high, six on a screen, a hairline between them. Left to right: number or playing mark (48 to 100), cover 52 x 52, title over artist, time at the right edge |
| Margins | 40 left and right; captions and row text on fixed lines, the same on every list |
| Position | "3 of 120" at the top right counts the highlighted row; a thin bar at the right edge shows where one is |
| Icons | Drawn by us from lines and circles (`tools/ui-mock.js` `ICON`): heart, disc, list, bars, magnifier, the three-bar playing mark, arrows, the warning triangle. No BMW artwork, no TIDAL artwork |
| Covers | 52 px in lists (option A only), 400 px on now playing. No cover: a grey tile with a note, as today |
| Words | Short, sentence case, no full stops in rows. "Favourite tracks", not "Fav. tracks". The bar's words say what a press does ("PAUSE" while playing) |
| Letters | The fonts are baked again with the accented Latin letters (the kit's `bake_fonts.py`), and Chinese and Japanese titles use the kit's own atlas instead of "?". The pictures still show "Stirile": they use today's fonts |

## 4. The decision: who draws the lists

**A. We draw every screen, in BMW's manner** (pictures `a-*.png`).

**B. BMW's HMI draws the library and the lists; we draw only now playing, search's letters, login** (pictures
`b-*.png`, sketches: in the car these lists look exactly like the car's own, which we cannot reproduce on the Mac).

**C. A mix:** the HMI draws My music (six fixed rows, and the settings in the same list); we draw the lists.

What the kit's HMI lists are (`kit/tools/build.py`, `"kind": "menu"`): a screen made of a **fixed number of rows
decided when the app is built**. Each row is one of BMW's widgets: one line of text, two lines of text, two columns,
or a checkbox. The app can change a row's text, hide a row and grey it out. There is no list that asks the app for
rows as it scrolls in the kit, no picture in a row that we know works, and no keyboard widget.

| | A: ours, in BMW's manner | B: BMW's own lists | C: mix |
|---|---|---|---|
| Looks like BMW's | Close: same structure, our font and our highlight | **Exactly**, with the car's own font, highlight, scrolling and animation | The first screen exactly, then ours: two looks side by side |
| Back arrow and BACK key | Must be built: when the HMI closes our screen while a list is open, the app goes up one level and opens its screen again. **Not tried in the car; it may flicker.** Push left works in any case | **Native**: every list is its own screen with a parent, the HMI does it | Native from the first list to My music; inside our lists as A |
| Covers in rows | Yes | **No** (text only) | In lists yes |
| The playing track | A mark | Only as a word in the second line ("Playing") | Mark |
| A track that cannot be played | Grey, skipped by the knob, "Not available" | Greyed by the HMI (whether the knob skips it is the HMI's choice; to be seen in the car) | As A |
| Long titles | Cut, and moving on the highlighted row (we build it) | The HMI cuts them its own way | As A |
| Long lists | Any length, loaded 50 at a time without the user noticing | **A fixed pool, 50 rows per screen**; after them a row "More tracks, 51 to 100 of 120", before them "Previous 50" (picture `b-tracks-end.png`). Every page is 50 to 100 text updates sent to the HMI one by one; how long that takes in the car is not known | As A |
| Accented and Chinese letters | After the fonts are baked again | **Yes, at once**: BMW's font | Mixed |
| Search | Our row of letters | Our row of letters too (no keyboard widget), then results in an HMI list | As A |
| The bar (Previous, Pause, Next) | On every screen | **Only on now playing.** In lists: the steering wheel, or go to now playing | Not on My music |
| The theme's colour | The kit's theme | The car's own | Mixed |
| Can be seen and tested on the Mac | **Yes**: pictures compared in the tests, the emulator | **No**: the lists exist only in the car. The tests can check the texts sent, not the look | Half |
| Work | About the size of the present app's screens again: `screens.js`, `listview.js`, `nav.js` rewritten, the model's back and focus, the golden pictures; two small hooks into the kit's display (the controller, as the app already hooks its focus in `tidal.js:208`; the bar's focus) | Less drawing, but new ground: three or four HMI screens with 50 rows each in `app.json`, a paging model, texts pushed row by row, and **several visits to the car** because nothing shows on the Mac. The widget names are "known to work", not documented by BMW (`docs/rhmi-widgets.md` in the kit) | Both kinds of work, less of each |
| What it cannot do | Be pixel-identical to BMW; use BMW's font | Covers, a playing mark, the bar in lists, one smooth long list, a preview on the Mac | A single look |

One fact worth knowing: on this renderer the kit's own author stopped using HMI lists even for the settings and
draws them himself ("sheets", `kit/runtime/sheet.js`; the QR log page in the owner's photos is one). So B goes
against the direction the kit is moving in.

**Recommendation: A.** The complaint is mostly about behaviour (where the knob goes, what Back does, two
highlights), and A fixes exactly that while keeping covers, the playing mark, the bar on every screen and lists of
any length; it can also be checked on the Mac before each car visit. B would give the true BMW look for the lists,
but pays for it with no covers, lists cut into pages of 50 and development that only shows its result in the car.
The one thing B does better for certain, the HMI's own Back, is the first thing step 2 tries in the car for A; if
it cannot be made to work well, C (My music as an HMI list) is the fallback, not B.

## 5. Questions for the owner

1. **A, B or C?** (Recommended: A.)
2. **After choosing a track: stay in the list** (proposed; the playing mark moves, push right shows now playing)
   **or go to now playing** as today?
3. **The controls on now playing: the bar's PREVIOUS / PAUSE / NEXT only** (proposed: one set, BMW's toolbar
   manner, 48 px high) **or three large round buttons on the page** as well (easier to hit with a finger, but then
   they exist twice)?
4. **Track rows: two lines with a small cover, six rows on a screen** (proposed) **or one line without covers,
   seven rows**, closer to BMW's plain lists?
5. **Is "Now playing" as the last row of My music wanted**, when the NOW PLAYING tab and push right already lead
   there?

## 6. Five minutes in the car that confirm section 1

With a track playing, on the library: (1) turn the knob one step: does SETTINGS in the header light up? (2) Open
Playlists: are two different rows marked, and which one does a press open? (3) In a list, push the controller left
twice: does the app close? (4) Is there a PREVIOUS in the bar? If any answer is "no", that row of the table in
section 1 is wrong and the plan for step 2 changes with it; the proposed structure does not depend on it.

## 7. Step 2, in order (after S2, C1 and K5 are merged)

1. In the car: can the app reopen its screen one level up after the HMI's Back? (An hour; decides A or C.)
2. Tests first: the model's navigation (back one level, position kept, greyed rows skipped, stay in the list after
   play), the controller's rule table of section 2, `BTN_PREV` renamed so the bar shows it.
3. The screens from the approved pictures; the golden pictures replaced by them, drawn in the frame as here.
4. The fonts baked again; the car check of every screen with knob, touch and wheel.

## The owner's decisions (2026-11-27)

| Question | Decision |
|---|---|
| A, B or C | **A**: we draw every screen, in BMW's manner |
| After choosing a track | the proposal: **stay in the list** (the owner does not mind either way) |
| Controls on now playing | the proposal: **only the bar's PREVIOUS / PAUSE / NEXT** |
| Track rows | the proposal: **two lines with a small cover, six per screen** |
| "Now playing" as the last row of My music | left to us: **kept**, shown only while a track is loaded (it carries the track's name, and a knob-only user reaches it without leaving the list) |
