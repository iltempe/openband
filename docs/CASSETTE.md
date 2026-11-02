# The Cassette

🇬🇧 English · 🇮🇹 [Italiano](CASSETTE.it.md) · [← README](../README.md)

Remember passing songs around on a tape? Burn a cassette from your songs and give it to whoever you want. They listen from a phone with nothing to install, with lyrics and chords.

**OpenBand hosts nothing.** A cassette carries its own player, so it keeps playing whatever happens to this project. Songs and titles are encrypted, and the key travels only in the part of the link after `#`, which browsers never send to a server. Whoever hosts the files sees noise.

## Burn one

*Cassettes*, in the bottom panel: give it a title and a dedication, open a song, and add it to side A or B. Repeat for each song, then *Burn*. Each song uses the version it is at when you add it: a cassette is frozen, so a new mix means a new print.

All songs come out at the same loudness (−14 LUFS, −1 dBTP), as on a well-made tape.

## Give it away

- **One file**: `Title – Artist.cassetta.html`, for mail, chat or a USB stick. Use a password: a file travels. It can't be taken back. On iPhone, an `.html` received in a chat often opens as a preview with no sound, so for iPhones use a link.
- **Folder for a site**: upload it to anything that serves static files, then add `#k=…&s=…` to its address. The studio gives you that part.

- **From my OpenBand**: when the studio is connected to your server or Box, it serves the cassette at `/c/<series>/<print>/`. On a LAN it works at once. To reach the internet, `openband box --tunnel cloudflared` or `--tunnel tailscale` starts a tunnel you have set up, and prints the public address: check it from your phone. On this road listeners' returns reach your server directly over HTTPS, *Retire* takes the cassette down, and listeners see when a new print is out.

## On paper and on real tape

*Printable J-card* makes an A4 PDF to cut and fold, with the cover, the sides and a QR to the link (or a line for the password). *For a real tape* gives each side as a WAV at 48 kHz, 24 bit, with 4 s of leader and gaps, and warns if a side runs over a C60.

Listeners can *Duplicate for a friend*: the same link, with their name in it, so you see who passed it to whom. Nobody can be stopped from copying a link or a file: this only says whether the player invites them to.

## For a choir or a band

Name the tracks Soprano, Alto, T, Basso, Voce 2, Tromba 1… and tick *With the parts*. Each singer then picks their part in the player: *Highlighted*, *Muted* (to sing over it), *On the left*, with a speed from 50 to 100% that keeps the pitch, and a loop on a section. *Classic pack of the parts* gives the plain files. Takes sung back can be heard together, as a virtual choir, in one proposal.

## What comes back

If you allow it, listeners can react on a moment, write a word, or leave a voice note. It is sealed so only your studio can read it. It reaches you directly, through your own signaling server while the studio is open, or as a `.risposta` file they send you. Returns land on the bar where they were made, and stay on that phrase even if you rearrange the song.

Your signature is four emoji. The player remembers them and warns if a later print is signed by someone else.
