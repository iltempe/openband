// OpenBand website: Italian / English, the download for this computer, live numbers from GitHub, and the
// feature suggestion form (it opens a prefilled GitHub issue from .github/ISSUE_TEMPLATE/feature.yml), and
// privacy-friendly visit counts (GoatCounter: no cookies, no personal data, none with Do Not Track / GPC).
(() => {
  const REPO = 'iltempe/openband';
  const API = `https://api.github.com/repos/${REPO}`;
  const LATEST = `https://github.com/${REPO}/releases/latest/download/`;

  // ---------------------------------------------------------------- language
  const IT = {
    'nav.how': 'Come cresce',
    'nav.features': 'Funzioni',
    'nav.download': 'Scarica',
    'nav.contribute': 'Contribuisci',
    'nav.open': 'Apri lo studio',
    'hero.kicker': 'Gratis · Open source · Costruito alla luce del sole',
    'hero.title': 'Lo studio musicale <span class="grad">che costruiamo insieme</span>',
    'hero.lead': 'OpenBand è la prima DAW open source che <strong>chiunque può migliorare</strong>: proponi una funzione, seguila sulla roadmap pubblica e suonala nella prossima versione. Fai musica nel browser o sul tuo computer, e lascia suonare anche la tua AI.',
    'hero.download': "Scarica l'app",
    'hero.browser': 'Provalo nel browser',
    'hero.note': 'Gratis per sempre · Senza account · macOS, Windows, Linux',
    'hero.tag1': '“Una batteria funk”',
    'hero.tag1s': 'Crea una parte a parole',
    'hero.tag2': '−19,8 → −14,0 LUFS',
    'hero.tag2s': 'Mix e master in un gesto',
    'facts.license': 'Licenza <b>MIT</b>',
    'facts.platforms': '<b>Browser</b>, macOS, Windows, Linux',
    'facts.ai': '<b>169</b> strumenti per le app AI',
    'facts.lang': '<b>Italiano</b> e English',
    'facts.offline': 'Funziona <b>offline</b>',
    'how.eyebrow': 'Come cresce OpenBand',
    'how.title': 'La tua idea può essere nella prossima versione.',
    'how.lead': 'Quasi tutti i programmi musicali vengono decisi a porte chiuse. OpenBand si costruisce dove tutti possono vedere: ogni idea è pubblica, ogni modifica è testata, ogni funzione esce con una versione sua.',
    'how.s1': 'La proponi',
    'how.s1p': 'Descrivi con parole tue cosa vorresti che lo studio facesse. Diventa una issue pubblica su GitHub.',
    'how.s2': 'Tutti la vedono',
    'how.s2p': 'Altri musicisti la votano con un 👍 e aggiungono il loro caso. Le idee più volute salgono nella roadmap.',
    'how.s3': 'Viene costruita',
    'how.s3p': "Alla luce del sole, con test che ascoltano l'audio: contributori e agenti AI di programmazione, fianco a fianco.",
    'how.s4': 'La suoni',
    'how.s4p': "Ogni funzione è una versione a sé. L'app ti avvisa quando esce; lo studio online si aggiorna da solo.",
    'how.pulse': 'Nuove versioni ogni settimana',
    'how.suggest': 'Proponi una funzione →',
    'feat.eyebrow': 'Cosa fa',
    'feat.title': 'Uno studio completo, reso semplice.',
    'feat.lead': "Dalla prima idea a un master pronto per Spotify: strumenti, batteria, audio, effetti, mix e mastering. Ogni passo è un gesto, non un manuale.",
    'feat.new': 'Novità',
    'feat.pilot': 'Mix e master in un gesto',
    'feat.pilotp': 'Scegli un genere e una piattaforma: il Mix Pilot bilancia, equalizza, panpotta, mette il sidechain e masterizza il brano per Spotify, Apple Music o il club. Ogni modifica è spiegata e dosata con una manopola.',
    'feat.create': 'Crea una parte a parole',
    'feat.createp': '“Batteria funk”, “piano arpeggiato”, “un loop di tastiere lo-fi”: i motori di OpenBand, o i modelli musicali che installi, la suonano a tempo e in tonalità con il tuo brano.',
    'feat.jam': "Improvvisa con l'AI",
    'feat.jamp': 'Suona una frase e ti risponde alla battuta dopo, con note che puoi tenere.',
    'feat.rec': 'Registra come in studio',
    'feat.recp': 'Microfono o scheda audio, punch-in, take e comping, test A/B alla cieca, una melodia canticchiata diventa MIDI.',
    'feat.versions': 'Non perdere mai un’idea',
    'feat.versionsp': 'Versioni e rami come git per le canzoni, una macchina del tempo di 30 giorni, recupero dopo un crash.',
    'feat.together': 'Suonate insieme',
    'feat.togetherp': "Condividi un link e modificate la stessa canzone dal vivo, con i commenti, e l'AI come terzo musicista.",
    'feat.desktop': 'App desktop',
    'feat.plugins': 'I tuoi plugin',
    'feat.pluginsp': 'Plugin web open source ovunque, e i synth e gli effetti CLAP, VST3 e Audio Unit installati sul computer, con le loro finestre e l’automazione al campione, ognuno nel suo processo: un crash non ferma mai la musica.',
    'feat.master': 'Suona come un disco',
    'feat.masterp': 'Limiter true-peak, sidechain, misuratori di loudness ed export per ogni piattaforma, con stem che sommati tornano al master.',
    'ai.eyebrow': 'Qualsiasi AI',
    'ai.title': 'Anche la tua AI può suonarlo.',
    'ai.lead': 'OpenBand parla MCP, lo standard aperto con cui le app AI usano gli strumenti. Chiedi una linea di basso, un mix, un arrangiamento, e guardalo accadere nello studio, a un “annulla” di distanza.',
    'ai.l1': '<span><b>Nella chat dello studio</b>: Claude, OpenAI, Gemini con la tua chiave, o un modello gratuito sul tuo computer con Ollama.</span>',
    'ai.l2': '<span><b>Dalla tua app AI</b>: Claude Desktop, Claude Code, ChatGPT, Codex, Gemini CLI, Hermes Agent, Cursor, VS Code.</span>',
    'ai.l3': '<span><b>Ascolta prima di toccare</b>: loudness, bilanciamento, mascheramento, armonia. Spiega le sue scelte sulle note.</span>',
    'dl.eyebrow': 'Scarica',
    'dl.title': 'Prendi OpenBand. È gratis.',
    'dl.lead': "Sempre l'ultima versione, direttamente dalle release di GitHub.",
    'dl.yours': 'Il tuo sistema',
    'dl.macreq': 'macOS 11 o successivo',
    'dl.macarm': 'Apple Silicon (M1–M4)',
    'dl.macintel': 'Intel',
    'dl.macnote': 'Non ancora firmata: come aprirla la prima volta',
    'dl.winreq': 'Windows 10 o 11',
    'dl.winx64': 'Scarica (64 bit)',
    'dl.winarm': 'ARM (Snapdragon)',
    'dl.winnote': 'SmartScreen può chiedere una volta: “Ulteriori informazioni → Esegui comunque”.',
    'dl.linreq': 'AppImage, o .deb per Debian / Ubuntu',
    'dl.linarm': 'ARM64:',
    'dl.web': 'Senza installare',
    'dl.webp': 'Apri lo studio in Chrome, Edge o Safari, e installalo come app dal browser per usarlo offline. <a href="https://iltempe.github.io/openband/">Apri lo studio →</a>',
    'dl.claude': 'Per Claude Desktop',
    'dl.claudep': 'Un file, doppio clic per installarlo: <a href="https://github.com/iltempe/openband/releases/latest/download/openband.mcpb">openband.mcpb</a>. Poi chiedi a Claude di fare musica.',
    'dl.npx': 'Da un terminale',
    'dl.npxp': 'Con Node.js 18+, lo studio e il suo server AI con un comando:',
    'dl.all': 'Tutte le versioni e cosa è cambiato in ognuna →',
    'join.eyebrow': 'Fallo tuo',
    'join.title': 'La prossima funzione può essere una tua idea.',
    'join.lead': 'Non serve saper programmare. Dicci cosa renderebbe OpenBand migliore per la musica che fai: basta un minuto, e tutti possono vedere dove va.',
    'join.suggest': 'Proponi una funzione',
    'join.star': 'Una stella su GitHub',
    'foot.made': 'OpenBand · licenza MIT · fatto dai suoi contributori, con l’AI',
    'foot.studio': 'Studio',
    'foot.features': 'Tutte le funzioni',
    'foot.changelog': 'Novità',
    'c.kicker': 'Costruito alla luce del sole',
    'c.title': 'Dai forma alla <span class="grad">prossima versione</span> di OpenBand',
    'c.lead': 'Dicci cosa renderebbe lo studio migliore per la musica che fai. La tua idea diventa una issue pubblica su GitHub, dove altri musicisti possono sostenerla e tutti possono seguirla fino alla versione che la porta.',
    'c.form': 'Proponi una funzione',
    'c.formp': 'Bastano poche frasi. Di’ cosa vuoi fare, non come andrebbe costruito.',
    'c.ftitle': 'In una riga',
    'c.ftitleph': 'es. Esportare il mix in MP3 per WhatsApp',
    'c.fidea': 'Cosa vorresti che OpenBand facesse?',
    'c.fideah': 'La musica che stai facendo e dove OpenBand ti ostacola.',
    'c.fideaph': 'Registro voci a casa e…',
    'c.ftoday': 'Come fai oggi?',
    'c.ftodayh': 'Facoltativo: in un’altra app, con un plugin, a mano…',
    'c.who': 'Fai musica come…',
    'c.whoh': 'Facoltativo',
    'c.w1': 'principiante',
    'c.w2': 'appassionato',
    'c.w3': 'produttore',
    'c.w4': 'insegnante',
    'c.w5': 'sviluppatore',
    'c.ai': 'Dovrebbe essere disponibile anche alle app AI (uno strumento MCP)',
    'c.send': 'Aprila su GitHub',
    'c.copy': 'Copia il testo',
    'c.hint': 'GitHub si apre in una nuova scheda con tutto già compilato: premi <b>Create</b> lì ed è pubblica. Serve un account GitHub gratuito; la bozza resta qui fino ad allora.',
    'c.sent': '✓ GitHub è aperto in una nuova scheda con la tua proposta. Premi <b>Create</b> per pubblicarla, poi condividi il link perché altri possano darle un 👍.',
    'c.recent': 'Proposte recenti',
    'c.recentp': 'Dai un 👍 a quelle che vuoi anche tu: le più volute salgono nella roadmap.',
    'c.loading': 'Caricamento…',
    'c.all': 'Tutte le proposte, le più volute prima →',
    'c.other': 'Altri modi per aiutare',
    'c.bug': 'Segnala un problema',
    'c.bugp': 'Qualcosa suona male o non funziona: raccontaci cosa hai fatto.',
    'c.code': 'Costruisci una funzione',
    'c.codep': 'La guida per sviluppatori, e le issue “good first issue”.',
    'c.translate': 'Traducilo',
    'c.translatep': 'Oggi inglese e italiano: porta OpenBand nella tua lingua.',
    'foot.contacts': 'Contatti',
    'foot.contactsp': 'OpenBand è fatto da @iltempe e dai suoi contributori.',
    'foot.coffee': 'Offrimi un caffè',
    'feat.voice': 'Mani sulla chitarra',
    'feat.voicep': 'Tieni premuto un pedale e di’ “registra”, “dal ritornello”, “segna errore”, “tieni questa”. Comandi vocali in italiano e inglese, riconosciuti offline nel tuo browser. La modalità Sessione registra cinque passaggi, valuta ogni battuta e unisce le migliori per te.',
    'feat.release': 'Pronto da pubblicare',
    'feat.releasep': 'Scegli una licenza rispondendo a tre domande, e OpenBand controlla che ogni campione, loop e motore IA del brano la permetta. Vedi quali piattaforme lo accettano, genera una copertina ed esporta il Release Kit: il master in FLAC con i tag, la copertina, la licenza, i crediti con la dichiarazione sull’uso dell’IA e il testo sincronizzato. In più il video per YouTube, o uno Short dal ritornello, creato nel tuo browser, e la pubblicazione con un clic sull’Internet Archive e su Wikimedia Commons con i tuoi account.',
    'feat.stems': 'Qualsiasi canzone, in stem',
    'feat.stemsp': 'Trascina un mix e premi Separa gli stem: batteria, basso, voce e il resto arrivano su tracce proprie, pronte da remixare, silenziare o su cui suonare. Demucs gira nel tuo browser: gratis, offline dopo un download una tantum, e il tuo audio non lascia il computer.',
    'feat.energy': 'Disegna la canzone',
    'feat.energyp': 'Hai un loop di 8 battute che non diventa mai una canzone? Disegna quanto deve essere grande nel tempo, o scegli “pop classico”, “crescendo lento”, “drop EDM”, e Arrangia la costruisce: intro, strofe, ritornelli, strumenti che entrano, fill, riser e un finale. Le tue note restano come le hai scritte, su un branch da confrontare.',
    'feat.ghosts': 'Tab per scrivere la battuta dopo',
    'feat.ghostsp': 'Mentre scrivi, OpenBand propone in grigio come continuare: il resto della melodia, una linea di basso sotto i tuoi accordi, un’armonia, una contromelodia, un fill di batteria. Tab la prende, ⇧Tab ne mostra un’altra e “?” spiega perché. Istantaneo, offline, senza account AI: impara dalla tua canzone.',
    'foot.privacy': 'Le visite si contano in forma anonima con <a href="https://www.goatcounter.com/help/privacy">GoatCounter</a>: niente cookie né dati personali, e nulla se il browser chiede di non essere tracciato.',
    'join.coffee': 'OpenBand è gratis e resta gratis. Se ti aiuta a fare musica, puoi sostenerlo:',
    'c.coffee': 'Offrimi un caffè',
    'c.coffeep': 'OpenBand è gratis: un caffè aiuta a portare avanti il lavoro.',
    'c.star': 'Stella e condividi',
    'c.starp': 'Più musicisti, più idee, uno studio migliore per tutti.',
  };
  const MSG = {
    en: {
      need: 'Write a one-line title and what you would like OpenBand to do.',
      copied: 'Copied: paste it in a new issue on GitHub.',
      none: 'No suggestions yet: be the first!',
      offline: 'GitHub is not reachable right now.',
      done: 'done',
      releases: (n, v, when) => `<b>${v}</b> released ${when} · <b>${n}</b> releases so far`,
      ideas: (n) => `<b>${n}</b> ideas suggested`,
      dl: { mac: 'Download for macOS', win: 'Download for Windows', linux: 'Download for Linux', other: 'Download the app' },
      ago: (d) => (d < 1 ? 'today' : d < 2 ? 'yesterday' : `${Math.round(d)} days ago`),
      footer: 'Suggested from the OpenBand website',
      who: 'I make music as',
      aiLine: 'It should also be available to AI apps (an MCP tool).',
    },
    it: {
      need: 'Scrivi un titolo di una riga e cosa vorresti che OpenBand facesse.',
      copied: 'Copiato: incollalo in una nuova issue su GitHub.',
      none: 'Ancora nessuna proposta: sii il primo!',
      offline: 'GitHub non è raggiungibile in questo momento.',
      done: 'fatto',
      releases: (n, v, when) => `<b>${v}</b> uscita ${when} · <b>${n}</b> versioni finora`,
      ideas: (n) => `<b>${n}</b> idee proposte`,
      dl: { mac: 'Scarica per macOS', win: 'Scarica per Windows', linux: 'Scarica per Linux', other: "Scarica l'app" },
      ago: (d) => (d < 1 ? 'oggi' : d < 2 ? 'ieri' : `${Math.round(d)} giorni fa`),
      footer: 'Proposta dal sito di OpenBand',
      who: 'Faccio musica come',
      aiLine: 'Dovrebbe essere disponibile anche alle app AI (uno strumento MCP).',
    },
  };

  const store = {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {}
    },
  };
  let lang = store.get('openband.site.lang') || (/^it\b/i.test(navigator.language || '') ? 'it' : 'en');
  const m = () => MSG[lang];

  function applyLang() {
    document.documentElement.lang = lang;
    for (const el of document.querySelectorAll('[data-i18n]')) {
      el.dataset.en ??= el.textContent;
      el.textContent = lang === 'it' ? (IT[el.dataset.i18n] ?? el.dataset.en) : el.dataset.en;
    }
    for (const el of document.querySelectorAll('[data-i18n-html]')) {
      el.dataset.enHtml ??= el.innerHTML;
      el.innerHTML = lang === 'it' ? (IT[el.dataset.i18nHtml] ?? el.dataset.enHtml) : el.dataset.enHtml;
    }
    for (const el of document.querySelectorAll('[data-i18n-ph]')) {
      el.dataset.enPh ??= el.placeholder;
      el.placeholder = lang === 'it' ? (IT[el.dataset.i18nPh] ?? el.dataset.enPh) : el.dataset.enPh;
    }
    for (const b of document.querySelectorAll('[data-lang-toggle]')) {
      b.textContent = lang === 'it' ? 'EN' : 'IT';
      b.setAttribute('aria-label', lang === 'it' ? 'English' : 'Italiano');
    }
    renderLive();
    setDownload();
  }
  for (const b of document.querySelectorAll('[data-lang-toggle]'))
    b.addEventListener('click', () => {
      lang = lang === 'it' ? 'en' : 'it';
      store.set('openband.site.lang', lang);
      applyLang();
    });

  // ---------------------------------------------------------------- this computer
  const ua = navigator.userAgent;
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const os = /mac/i.test(platform) || /Mac OS X/.test(ua) ? (/iPhone|iPad/.test(ua) ? 'other' : 'mac') : /win/i.test(platform) || /Windows/.test(ua) ? 'win' : /linux/i.test(platform) && !/Android/.test(ua) ? 'linux' : 'other';
  let arch = /arm|aarch64/i.test(ua) ? 'arm' : null;
  const asset = () => {
    if (os === 'mac') return arch === 'x86' ? 'OpenBand-mac-x64.dmg' : 'OpenBand-mac-arm64.dmg';
    if (os === 'win') return arch === 'arm' ? 'OpenBand-win-arm64.exe' : 'OpenBand-win-x64.exe';
    if (os === 'linux') return arch === 'arm' ? 'OpenBand-linux-arm64.AppImage' : 'OpenBand-linux-x86_64.AppImage';
    return null;
  };
  function setDownload() {
    const a = document.querySelector('[data-download-primary]');
    const label = document.querySelector('[data-download-label]');
    if (a && label) {
      const file = asset();
      a.href = file ? LATEST + file : '#download';
      label.textContent = m().dl[os] ?? m().dl.other;
    }
    for (const card of document.querySelectorAll('[data-os]')) card.classList.toggle('mine', card.dataset.os === os);
  }
  // Chromium says the architecture (an Intel Mac, a Windows on ARM); Safari and Firefox don't.
  if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues)
    navigator.userAgentData
      .getHighEntropyValues(['architecture'])
      .then((v) => {
        if (v.architecture) arch = v.architecture === 'arm' ? 'arm' : 'x86';
        setDownload();
      })
      .catch(() => {});

  // ---------------------------------------------------------------- live from GitHub
  const live = { releases: null, ideas: null };
  const days = (iso) => (Date.now() - new Date(iso).getTime()) / 86400000;
  function renderLive() {
    if (live.releases) {
      const [latest] = live.releases;
      for (const el of document.querySelectorAll('[data-version]')) el.textContent = latest.tag_name;
      const p = document.querySelector('[data-pulse-releases]');
      if (p) p.innerHTML = m().releases(live.releases.length, latest.tag_name, m().ago(days(latest.published_at)));
    }
    const ideas = document.querySelector('[data-pulse-ideas]');
    if (ideas && live.ideas !== null) ideas.innerHTML = '· ' + m().ideas(live.ideas);
    renderRecent();
  }
  const getJson = (url) => fetch(url, { headers: { Accept: 'application/vnd.github+json' } }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))));
  if (document.querySelector('[data-version]'))
    getJson(`${API}/releases?per_page=100`)
      .then((list) => {
        live.releases = list.filter((r) => !r.draft && !r.prerelease);
        if (live.releases.length) renderLive();
      })
      .catch(() => {});
  if (document.querySelector('[data-pulse-ideas]'))
    getJson(`https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${REPO} label:enhancement`)}&per_page=1`)
      .then((r) => {
        live.ideas = r.total_count;
        renderLive();
      })
      .catch(() => {});

  // ---------------------------------------------------------------- recent suggestions
  const recentEl = document.getElementById('recent');
  let recent = null;
  let recentFailed = false;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  function renderRecent() {
    if (!recentEl) return;
    if (recentFailed) return void (recentEl.innerHTML = `<li class="empty">${esc(m().offline)}</li>`);
    if (!recent) return;
    if (!recent.length) return void (recentEl.innerHTML = `<li class="empty">${esc(m().none)}</li>`);
    recentEl.innerHTML = recent
      .map((i) => {
        const votes = i.reactions ? i.reactions['+1'] : 0;
        const state = i.state === 'closed' ? `<span class="v done">✓ ${esc(m().done)}</span>` : `<span class="v">👍 ${votes}</span>`;
        return `<li><a href="${esc(i.html_url)}"><span class="t">${esc(i.title)}</span>${state}<span class="m">#${i.number} · ${esc(m().ago(days(i.created_at)))}</span></a></li>`;
      })
      .join('');
  }
  if (recentEl)
    getJson(`${API}/issues?labels=enhancement&state=all&sort=created&direction=desc&per_page=6`)
      .then((list) => {
        recent = list.filter((i) => !i.pull_request);
        renderRecent();
      })
      .catch(() => {
        recentFailed = true;
        renderRecent();
      });

  // ---------------------------------------------------------------- the suggestion form
  const form = document.getElementById('suggest');
  if (form) {
    const DRAFT = 'openband.site.draft';
    const who = new Set();
    const chips = [...form.querySelectorAll('[data-who]')];
    try {
      const d = JSON.parse(store.get(DRAFT) || '{}');
      for (const k of ['title', 'idea', 'today']) if (d[k]) form.elements[k].value = d[k];
      form.elements.ai.checked = !!d.ai;
      for (const w of d.who || []) who.add(w);
    } catch {}
    const syncChips = () => chips.forEach((c) => c.setAttribute('aria-pressed', String(who.has(c.dataset.who))));
    syncChips();
    const save = () => store.set(DRAFT, JSON.stringify({ title: form.elements.title.value, idea: form.elements.idea.value, today: form.elements.today.value, ai: form.elements.ai.checked, who: [...who] }));
    form.addEventListener('input', save);
    chips.forEach((c) =>
      c.addEventListener('click', () => {
        who.has(c.dataset.who) ? who.delete(c.dataset.who) : who.add(c.dataset.who);
        syncChips();
        save();
      }),
    );
    const err = document.getElementById('form-error');
    const fields = () => {
      const title = form.elements.title.value.trim();
      const idea = form.elements.idea.value.trim();
      const today = form.elements.today.value.trim();
      if (!title || idea.length < 10) {
        err.textContent = m().need;
        err.style.color = '';
        err.hidden = false;
        (title ? form.elements.idea : form.elements.title).focus();
        return null;
      }
      err.hidden = true;
      const whoLabels = chips.filter((c) => who.has(c.dataset.who)).map((c) => c.textContent.trim());
      const extra = [whoLabels.length ? `${m().who}: ${whoLabels.join(', ')}.` : '', form.elements.ai.checked ? m().aiLine : '', `_${m().footer}_`].filter(Boolean).join('\n');
      return { title, idea: `${idea}\n\n${extra}`, today };
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = fields();
      if (!f) return;
      // An issue form prefilled by field id (template feature.yml adds the "enhancement" label).
      const q = new URLSearchParams({ template: 'feature.yml', title: f.title.slice(0, 200), idea: f.idea.slice(0, 5000) });
      if (f.today) q.set('today', f.today.slice(0, 2000));
      window.open(`https://github.com/${REPO}/issues/new?${q}`, '_blank', 'noopener');
      document.getElementById('sent').classList.add('show');
    });
    document.getElementById('copy').addEventListener('click', async () => {
      const f = fields();
      if (!f) return;
      const text = `${f.title}\n\n${f.idea}${f.today ? `\n\n${f.today}` : ''}`;
      try {
        await navigator.clipboard.writeText(text);
        err.textContent = m().copied;
        err.hidden = false;
        err.style.color = 'var(--green)';
      } catch {}
    });
  }

  // ---------------------------------------------------------------- reveal on scroll
  const reveal = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }),
      { rootMargin: '0px 0px -8% 0px' },
    );
    reveal.forEach((el) => io.observe(el));
  } else reveal.forEach((el) => el.classList.add('in'));

  // ---------------------------------------------------------------- visits (GoatCounter)
  // Only on the official site, never when the browser asks not to be tracked. GoatCounter keeps no
  // cookies and no personal data: a page, the referrer, the browser and the screen size, in aggregate.
  const GOAT = 'https://openband.goatcounter.com/count';
  const noTrack = navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true;
  if (location.hostname === 'www.openband.it' && !noTrack) {
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://gc.zgo.at/count.js';
    s.dataset.goatcounter = GOAT;
    document.head.appendChild(s);
    // Downloads as events (which file only), to see what people take.
    document.addEventListener('click', (e) => {
      const a = e.target instanceof Element ? e.target.closest('a[href*="/releases/"]') : null;
      if (!a || !window.goatcounter?.count) return;
      const file = a.getAttribute('href').split('/').pop() || 'release';
      window.goatcounter.count({ path: `download/${file}`, title: 'Download', event: true });
    });
  }

  applyLang();
})();
