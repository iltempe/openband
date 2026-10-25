# DiffSinger on a GPU machine

🇬🇧 English · 🇮🇹 [Italiano](#italiano)

[DiffSinger](https://github.com/openvpi/DiffSinger) (openvpi, Apache-2.0) sings with a voicebank: there is no
public hosted API for it, so if your computer has no GPU you can run it on a rented one (RunPod, Modal, a
Hugging Face Space, your own server) with this image. It holds DiffSinger and OpenBand's OMEP adapter and
answers at `http://<host>:8765/mcp`; OpenBand reaches it as a `url` engine. With a GPU at home, you don't need
it: see *Sing with DiffSinger* in [docs/ENSEMBLE.md](../../docs/ENSEMBLE.md).

You bring the **voicebank** (an acoustic model DiffSinger can load as an experiment folder) and respect its
licence — every voicebank has its own, and many forbid commercial use. DiffSinger's own disclaimer applies:
never synthesize someone's voice without their consent.

```bash
# from the root of the OpenBand repository
docker build -f deploy/diffsinger/Dockerfile -t openband-diffsinger .
docker run --gpus all -p 8765:8765 -e OMEP_TOKEN=<a long random password> -e VOICEBANK=my_voice \
  -v /path/to/my_voice:/opt/DiffSinger/checkpoints/my_voice openband-diffsinger
```

Then in `~/.openband/engines.json` on your computer:

```json
{ "engines": { "diffsinger": { "url": "https://<your-gpu-host>:8765/mcp", "token": "<the same password>" } } }
```

Put it behind HTTPS (the provider's proxy, or a tunnel) — the token travels with every request. The adapter
answers only that token, sends the voice back inline and keeps nothing.

Status: the adapter's network mode is tested (token, MCP over HTTP, the voice back inline) with the exact
packages the image installs; **the image itself was not built here** (no Docker daemon on the development
machine), and DiffSinger was not run with a real voicebank. Report what you find.

---

## Italiano

[DiffSinger](https://github.com/openvpi/DiffSinger) (openvpi, Apache-2.0) canta con un voicebank: non esiste
un'API pubblica che lo ospiti, quindi se il tuo computer non ha una GPU puoi farlo girare su una a noleggio
(RunPod, Modal, uno Space di Hugging Face, un tuo server) con questa immagine, che contiene DiffSinger e
l'adapter OMEP di OpenBand e risponde su `http://<host>:8765/mcp`; OpenBand lo raggiunge come motore `url`.
Con una GPU a casa non serve: vedi *Cantare con DiffSinger* in [docs/ENSEMBLE.it.md](../../docs/ENSEMBLE.it.md).

Il **voicebank** lo porti tu (un modello acustico che DiffSinger carica come cartella di esperimento) e ne
rispetti la licenza: ognuno ha la sua, e molti vietano l'uso commerciale. Vale l'avvertenza di DiffSinger:
mai sintetizzare la voce di qualcuno senza il suo consenso.

Comandi: gli stessi della sezione inglese (`docker build …`, `docker run … -e OMEP_TOKEN=… -e VOICEBANK=…
-v …:/opt/DiffSinger/checkpoints/<voicebank>`), poi in `~/.openband/engines.json`
`"diffsinger": { "url": "https://<host>:8765/mcp", "token": "<la stessa password>" }`. Mettilo dietro HTTPS:
il token viaggia con ogni richiesta.

Stato: la modalità di rete dell'adapter è testata (token, MCP su HTTP, la voce restituita inline) con gli
stessi pacchetti che installa l'immagine; **l'immagine non è stata costruita qui** (nessun Docker sulla
macchina di sviluppo) e DiffSinger non è stato provato con un voicebank vero.
