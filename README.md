# Splice — Audio Mashup Studio

A installable web app (PWA) that blends two songs into one: match tempos, drag
to align the beat or lyric you want, mix levels, and export as WAV or MP3.
Everything runs locally on the device — no audio is ever uploaded.

## What it actually does

"Merge two songs, with one tempo matched to the other and the lyrics blended"
is a real audio-engineering task (this is what's commonly called a mashup),
and there's no reliable way to do it 100% automatically — even professional
DJ software needs a human to pick the right section and nudge the alignment
by ear. So Splice automates the hard math and leaves you the creative call:

- **Auto BPM detection** for both tracks (editable — automatic tempo detection
  occasionally locks onto half/double the real tempo, so double check it).
- **One-tap tempo matching**: stretches one track's speed to match the other's
  BPM without changing its pitch (so a vocal track doesn't turn into a
  chipmunk), using a phase-aligned time-stretch algorithm (WSOLA).
- **Trim** each track down to the section you actually want (e.g. just a
  verse, or just the instrumental break).
- **Drag-to-align timeline**: the two waveforms are stacked like a physical
  tape splice — drag the bottom one left/right until the beat (or the line
  you want over the other track) lines up. A beat grid and a "snap to beat"
  toggle help with this.
- **Mix**: independent volume/mute/solo per track, so you can blend a vocal
  over an instrumental, or balance two full songs.
- **Export** as WAV (lossless) or MP3 (128/192/320kbps).

## Running it / installing it on your phone

A PWA needs to be served over **HTTPS** (or `localhost`) for "Add to Home
Screen" and offline support to work — opening the HTML file directly from
your phone's file system won't allow installation. Pick whichever is easiest:

**Quickest — Netlify Drop (no account, ~30 seconds):**
1. On a computer, go to https://app.netlify.com/drop
2. Drag this whole folder onto the page.
3. Open the URL it gives you on your phone.
4. Android/Chrome: tap the "Install" button that appears in the app, or the
   menu → "Add to Home screen". iPhone/Safari: tap Share → "Add to Home Screen".

**GitHub Pages:** push this folder to a repo, enable Pages in Settings, open
the resulting `https://<you>.github.io/<repo>/` URL on your phone.

**Your own server / any static host:** these are plain static files — copy
the folder anywhere that serves over HTTPS (Vercel, Cloudflare Pages, S3 +
CloudFront, nginx with a cert, etc.).

**Local testing on a computer right now**, no hosting needed:
```
cd splice-app
python3 -m http.server 8000
```
then open `http://localhost:8000` in a browser (installable there too, since
`localhost` counts as a secure context).

## Files

- `index.html` — markup + styles
- `app.js` — all app logic (decode, BPM detection, time-stretch, alignment,
  mixing, playback, WAV/MP3 export)
- `manifest.json`, `sw.js` — make it installable and work offline
- `icon-*.png` — app icons

## Notes & limits

- MP3 export needs an internet connection the first time, to load the
  `lamejs` encoder from a CDN (cached by the service worker afterward).
  WAV export always works offline.
- Tempo matching is capped to a 0.5×–2× range to keep audio quality
  reasonable; if your two songs are wildly different tempos, trim to a
  section where they're closer, or just skip matching and align by feel.
- This is built as an installable web app (PWA) rather than a native
  App Store / Play Store app — that's the realistic path to "install it on
  your phone" without an Apple/Google developer account and a native build
  toolchain.
