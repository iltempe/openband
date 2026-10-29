# Releasing and publishing a song

Everything happens in the **Release** tab at the bottom of the studio. An AI can do the same with the
tools in the `release` toolset ([MCP-TOOLS.md](MCP-TOOLS.md)), but it never publishes on its own: every
publish waits for your click.

![The confirmation every publish waits for](publish-confirm.png)

## 1. Get the song ready
- **About the song**: title, artist, genre, tags, date, contact, description.
- **Licence**: answer the three questions (commercial use? changes? same licence for changes?) or give it to
  the public domain. Creative Commons licences can't be withdrawn for copies already shared. If you belong
  to a collecting society (SIAE, PRS, ASCAP…), check with it before choosing one.
- **What the song contains**: give each imported sample its licence. A sample whose licence doesn't allow
  the song's licence is named, here and in *Problems*, and blocks publishing.
- **Cover**: generate one (style, palette, *Another one*), or set your own image.
- **Release Kit** and **Make the video**: the files to upload anywhere by hand.

## 2. Set up your accounts
Publishing needs the **OpenBand desktop app or `npx openband`** on your computer. Your keys and sign-ins
are kept there, in `~/.openband/publish.json`, readable only by you. They are never in the web page and never
pass through an AI. In the online studio, use the Release Kit.

**Internet Archive**: open [archive.org/account/s3.php](https://archive.org/account/s3.php) while signed
in, copy the *access* and *secret* keys into *Release → Accounts → Internet Archive*, and save.

**Wikimedia Commons**, either way:
- **Owner-only consumer** (quickest; works only for your own account). Propose an OAuth 2.0 consumer at
  [Special:OAuthConsumerRegistration](https://meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration/propose/oauth2)
  and tick *This consumer is for use only by you*. For the grants, choose *Upload new files*. Paste the
  **access token** it shows into *Accounts → Wikimedia Commons*.
- **Regular consumer** (needs Wikimedia's approval). Propose one with the same grant, untick *Client is
  confidential*, and register the **redirect URL** shown in *Accounts*
  (`http://127.0.0.1:<port>/publish/oauth/callback`). Once it is approved, paste its client key and press
  **Sign in**. A Wikimedia window opens; after you allow it, OpenBand keeps the sign-in (OAuth 2.0 with
  PKCE) and renews it when it expires.

**SoundCloud**: create an app at [soundcloud.com/you/apps](https://soundcloud.com/you/apps) with the
**redirect URL** shown in *Accounts* (`http://127.0.0.1:<port>/publish/oauth/callback`), paste its client ID
and secret, and press **Sign in**.

**YouTube**: in the [Google Cloud console](https://console.cloud.google.com/apis/credentials), enable the
*YouTube Data API v3*, set up the OAuth consent screen (add yourself as a test user) and create an OAuth
client of type **Desktop app**. Paste its client ID and secret and press **Sign in**. Each upload uses API
quota: about 100 videos a day per project.

**Mixcloud**: create an app at [mixcloud.com/developers](https://www.mixcloud.com/developers/create/) with the
redirect URL shown in *Accounts* (it ends in `/callback/mixcloud`), paste its client ID and secret, and press
**Sign in**.

**Funkwhale**: on your instance, *Settings → Applications → New*, with the redirect URL shown in *Accounts*
and the scopes `read:libraries` and `write:libraries`. Paste your instance's address, the application's ID
and secret, and press **Sign in**. You need a library on the instance for each visibility you publish with
(libraries can't be made through the API).

The redirect URL contains the port the local OpenBand is using (7777 unless it was taken): register the one
*Accounts* shows.

## 3. Publish
Tick the platforms (*Publish in CC* ticks the ones your licence allows) and press **Publish…**. The studio
checks the release again, then asks you to confirm:
- **Internet Archive**: an item in *Community Audio* with the master as 24-bit FLAC (tags and cover inside),
  the cover, the LRC, LICENSE.txt and CREDITS.txt. Its metadata includes the licence URL. The item is
  **public and permanent**.
- **Wikimedia Commons**: the master as FLAC, uploaded in chunks (a failed one is sent again). Its description
  page holds `{{Information}}` and the licence template (`{{cc-zero}}`, `{{cc-by-4.0}}` or
  `{{cc-by-sa-4.0}}`). Commons takes only free licences: with NC or ND it is switched off.

- **SoundCloud**: the master as FLAC with the cover as artwork, the licence in SoundCloud's terms (all
  Creative Commons ones), genre and tags; *public*, or *private* (a private link) for anything else.
- **YouTube**: the 16:9 video made in the studio (cover, spectrum, lyrics), uploaded in pieces that resume
  after a dropped connection; *public*, *unlisted* or *private*; licence *Creative Commons* for CC BY, the
  standard one otherwise; *altered or synthetic content* is declared when AI engines made part of the song
  (from its ledger).
- **Mixcloud**: an MP3 at 320 kbit/s with the cover, at most 5 tags; always public.
- **Funkwhale**: the master as FLAC into your library visible to *everyone* (public), *your instance*
  (unlisted) or *only you* (private), with title, description, copyright, tags and the licence; followed
  until the instance has imported it. A licence the instance doesn't know is left out, and you are told.

Pick *Public*, *Unlisted* or *Private* next to **Publish…**: it applies to YouTube, SoundCloud and Funkwhale.

What went out, where, when and which master stays in the song (*Published*, `get_publications`).

**Not yet**: Audius.
Spotify, Apple Music and the other stores need a distributor and have no open upload API, so OpenBand doesn't publish there.
