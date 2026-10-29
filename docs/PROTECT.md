# Protect: a proof that your song existed

In the **Release** tab, under *Protect*, OpenBand can timestamp your song in Bitcoin with
[OpenTimestamps](https://opentimestamps.org). An AI can do the same with `timestamp_work` (the `protect`
toolset).

## What you get, and what not
- **A proof of date.** The timestamp shows that these files existed on that date: the master, the project,
  the lyrics and the chord sheet, each identified by its SHA-256.
- **Evidence, not a registration.** In Italy and the EU copyright is born with the work, so nothing has to
  be filed. In a dispute, a timestamp is evidence of date and authorship. Art. 8-ter of DL 135/2018 gives it
  the effect of an electronic time stamp under art. 41 eIDAS: it is accepted as evidence and the court
  weighs it freely, but it is not a qualified time stamp.
- **No royalties.** Collecting royalties (concerts, radio, streaming) needs a collecting society, such as
  SIAE or Soundreef/LEA. That step is still manual.
- **Not legal advice.**

## How it works
1. OpenBand makes the work's files and a **manifest**, `work.json`. It is canonical JSON with the title,
   authors, declared date, licence, each file's SHA-256, and the song's version. The same files always give
   the same manifest.
2. Only the manifest's **32-byte fingerprint** leaves your computer. A random nonce is added first, so the
   servers see only a fingerprint that can't be traced back to your song. It goes to at least two public
   OpenTimestamps calendars, through the local OpenBand (the calendars don't accept requests from web
   pages). The audio and the text never leave.
3. The proof stays **pending** for a few hours, until Bitcoin confirms it. OpenBand then completes it by
   itself, whenever the song is open with the local OpenBand.
4. **Verify** checks the proof against the Bitcoin block it is anchored in, using a public block explorer.
   *Check any file with its proof* does the same for any file and its `.ots`, yours or someone else's.

The master is kept exactly as it was timestamped, as a sample saved with the song: a new render of the same
song differs in its last bits, and the proof covers those exact bytes.

### How much is human

The manifest also carries **who made what**, from the contribution ledger. It records the share of the
song made by people and by AI engines, for each track and in all. It lists the engines whose parts are
still in the song, with their licences, and the attributions they require, plus a hash of the whole
ledger. So the timestamp proves not only that the song existed, but how much of it you made. The
certificate says it in one line: *Made by people: 100%*, or the share and the engines. Proofs made before
v0.6.41 don't have it. Embedding the same information in the audio files as C2PA Content Credentials was
evaluated and put off: see [ADR 0003](adr/0003-c2pa.md).

## The Proof package
`Proof package` (or `export_proof_package`) saves a zip that anyone can verify without OpenBand:
- `work.json` and `work.json.ots`, the manifest and its OpenTimestamps proof;
- the files the manifest lists: the master WAV, the project, `lyrics.txt` and the ChordPro sheet;
- `README.txt`, explaining how to verify it independently: `ots verify work.json.ots`, then `sha256sum` each
  file against `work.json`;
- `certificate.pdf`, a one-page certificate with the title, authors, block, date and hashes.

## Needs
The OpenBand app or `npx openband` on your computer. In the online studio, connect it to a local OpenBand.
