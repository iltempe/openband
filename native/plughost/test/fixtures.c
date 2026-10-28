// Test fixtures for openband-plughost (G8): small CLAP plugins built only for the tests, never shipped.
//   org.openband.fixture.gain    stereo effect, one parameter "Gain" (dB, default −6), state = the gain
//   org.openband.fixture.delay   stereo effect with 256 samples of latency (reported through clap.latency)
//   org.openband.fixture.crash   passes audio through; its "Crash" parameter makes it abort() in process
//   org.openband.fixture.synth   an instrument: a sine per note, starting on the event's exact sample; a
//                                "Level" parameter (id 2) applied at its event's sample; note 127 acts like
//                                the plugin's own window: it moves Level (with a gesture) and marks the state dirty
//   org.openband.fixture.orchestra  a MIDI effect, like an orchestrator (issue #9): each note in plays a chord
//                                out on three channels (the key on 0, an octave down on 1, a fifth up on
//                                2, as CLAP notes) and the key on channel 3 as raw MIDI; no sound
// Built with -DOB_HANG it is ob-hang.clap instead, whose entry never returns from init (scan timeout).
#include <clap/clap.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#define sleep_s(s) Sleep((s) * 1000)
#else
#include <unistd.h>
#define sleep_s(s) sleep(s)
#endif

#define DELAY 256

typedef struct {
  clap_plugin_t plugin;
  const clap_host_t *host;
  int kind; // 0 gain, 1 delay, 2 crash, 3 synth, 4 orchestra
  double gain_db;
  double crash;
  double level;
  double sr;
  double phase[128];
  int on[128];
  int echo; // note 127 seen: report a "GUI" change in this block's output events
  float line[2][DELAY];
  uint32_t pos;
} fx_t;

static const char *FEATURES[] = {CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, CLAP_PLUGIN_FEATURE_UTILITY, NULL};
static const char *SYNTH_FEATURES[] = {CLAP_PLUGIN_FEATURE_INSTRUMENT, CLAP_PLUGIN_FEATURE_SYNTHESIZER, NULL};
static const char *NOTE_FX_FEATURES[] = {CLAP_PLUGIN_FEATURE_NOTE_EFFECT, NULL};
#define NDESC 5
static const clap_plugin_descriptor_t DESC[NDESC] = {
    {CLAP_VERSION_INIT, "org.openband.fixture.gain", "OB Fixture Gain", "OpenBand", "", "", "", "1.0.0", "A gain for tests", FEATURES},
    {CLAP_VERSION_INIT, "org.openband.fixture.delay", "OB Fixture Delay", "OpenBand", "", "", "", "1.0.0", "256 samples of latency, for tests", FEATURES},
    {CLAP_VERSION_INIT, "org.openband.fixture.crash", "OB Fixture Crash", "OpenBand", "", "", "", "1.0.0", "Crashes on demand, for tests", FEATURES},
    {CLAP_VERSION_INIT, "org.openband.fixture.synth", "OB Fixture Synth", "OpenBand", "", "", "", "1.0.0", "A sine per note, for tests", SYNTH_FEATURES},
    {CLAP_VERSION_INIT, "org.openband.fixture.orchestra", "OB Fixture Orchestra", "OpenBand", "", "", "", "1.0.0", "Each note out as a chord on three channels, for tests", NOTE_FX_FEATURES},
};

// ---- audio ports: one stereo in, one stereo out
static uint32_t ports_count(const clap_plugin_t *p, bool in) { return in && ((fx_t *)p->plugin_data)->kind >= 3 ? 0 : 1; }
static bool ports_get(const clap_plugin_t *p, uint32_t i, bool in, clap_audio_port_info_t *info) {
  (void)p;
  if (i) return false;
  memset(info, 0, sizeof *info);
  info->id = 0;
  snprintf(info->name, sizeof info->name, "%s", in ? "In" : "Out");
  info->channel_count = 2;
  info->flags = CLAP_AUDIO_PORT_IS_MAIN;
  info->port_type = CLAP_PORT_STEREO;
  info->in_place_pair = CLAP_INVALID_ID;
  return true;
}
static const clap_plugin_audio_ports_t PORTS = {ports_count, ports_get};

static uint32_t notes_count(const clap_plugin_t *p, bool in) { return in || ((fx_t *)p->plugin_data)->kind == 4 ? 1 : 0; }
static bool notes_get(const clap_plugin_t *p, uint32_t i, bool in, clap_note_port_info_t *info) {
  if (i || (!in && ((fx_t *)p->plugin_data)->kind != 4)) return false;
  memset(info, 0, sizeof *info);
  info->supported_dialects = CLAP_NOTE_DIALECT_CLAP;
  info->preferred_dialect = CLAP_NOTE_DIALECT_CLAP;
  snprintf(info->name, sizeof info->name, "Notes");
  return true;
}
static const clap_plugin_note_ports_t NOTE_PORTS = {notes_count, notes_get};

// ---- params: gain (id 0) or crash (id 1)
static uint32_t params_count(const clap_plugin_t *p) { return ((fx_t *)p->plugin_data)->kind == 1 ? 0 : 1; }
static bool params_info(const clap_plugin_t *p, uint32_t i, clap_param_info_t *info) {
  fx_t *f = (fx_t *)p->plugin_data;
  if (i) return false;
  memset(info, 0, sizeof *info);
  info->flags = CLAP_PARAM_IS_AUTOMATABLE;
  if (f->kind == 3) {
    info->id = 2;
    snprintf(info->name, sizeof info->name, "Level");
    info->min_value = 0;
    info->max_value = 1;
    info->default_value = 0.5;
  } else if (f->kind == 0) {
    info->id = 0;
    snprintf(info->name, sizeof info->name, "Gain");
    info->min_value = -24;
    info->max_value = 24;
    info->default_value = -6;
  } else {
    info->id = 1;
    snprintf(info->name, sizeof info->name, "Crash");
    info->min_value = 0;
    info->max_value = 1;
    info->default_value = 0;
    info->flags |= CLAP_PARAM_IS_STEPPED;
  }
  return true;
}
static bool params_value(const clap_plugin_t *p, clap_id id, double *v) {
  fx_t *f = (fx_t *)p->plugin_data;
  *v = id == 0 ? f->gain_db : id == 2 ? f->level : f->crash;
  return true;
}
static bool params_to_text(const clap_plugin_t *p, clap_id id, double v, char *out, uint32_t cap) {
  (void)p;
  snprintf(out, cap, id == 0 ? "%.1f dB" : "%.0f", v);
  return true;
}
static bool params_from_text(const clap_plugin_t *p, clap_id id, const char *t, double *v) {
  (void)p;
  (void)id;
  *v = atof(t);
  return true;
}
static void apply_event(fx_t *f, const clap_event_header_t *h) {
  if (h->space_id != CLAP_CORE_EVENT_SPACE_ID || h->type != CLAP_EVENT_PARAM_VALUE) return;
  const clap_event_param_value_t *e = (const clap_event_param_value_t *)h;
  if (e->param_id == 0) f->gain_db = e->value;
  if (e->param_id == 1) f->crash = e->value;
  if (e->param_id == 2) f->level = e->value;
}
static void params_flush(const clap_plugin_t *p, const clap_input_events_t *in, const clap_output_events_t *out) {
  (void)out;
  for (uint32_t i = 0; i < in->size(in); i++) apply_event((fx_t *)p->plugin_data, in->get(in, i));
}
static const clap_plugin_params_t PARAMS = {params_count, params_info, params_value, params_to_text, params_from_text, params_flush};

// ---- latency
static uint32_t latency_get(const clap_plugin_t *p) { return ((fx_t *)p->plugin_data)->kind == 1 ? DELAY : 0; }
static const clap_plugin_latency_t LATENCY = {latency_get};

// ---- state: the gain as text
static bool state_save(const clap_plugin_t *p, const clap_ostream_t *s) {
  char buf[64];
  fx_t *f = (fx_t *)p->plugin_data;
  int n = snprintf(buf, sizeof buf, "gain=%.6f", f->kind == 3 ? f->level : f->gain_db);
  return s->write(s, buf, (uint64_t)n) == n;
}
static bool state_load(const clap_plugin_t *p, const clap_istream_t *s) {
  char buf[64] = {0};
  int64_t n = s->read(s, buf, sizeof buf - 1);
  if (n <= 0 || strncmp(buf, "gain=", 5)) return false;
  fx_t *f = (fx_t *)p->plugin_data;
  if (f->kind == 3) f->level = atof(buf + 5);
  else f->gain_db = atof(buf + 5);
  return true;
}
static const clap_plugin_state_t STATE = {state_save, state_load};

// ---- the plugin
static bool fx_init(const clap_plugin_t *p) {
  (void)p;
  return true;
}
static void fx_destroy(const clap_plugin_t *p) { free(p->plugin_data); }
static bool fx_activate(const clap_plugin_t *p, double sr, uint32_t min, uint32_t max) {
  ((fx_t *)p->plugin_data)->sr = sr;
  (void)min;
  (void)max;
  return true;
}
static void fx_deactivate(const clap_plugin_t *p) { (void)p; }
static bool fx_start(const clap_plugin_t *p) {
  (void)p;
  return true;
}
static void fx_stop(const clap_plugin_t *p) { (void)p; }
static void fx_reset(const clap_plugin_t *p) { (void)p; }
static void synth_event(fx_t *f, const clap_event_header_t *h) {
  if (h->space_id != CLAP_CORE_EVENT_SPACE_ID) return;
  if (h->type == CLAP_EVENT_PARAM_VALUE) return apply_event(f, h);
  if (h->type != CLAP_EVENT_NOTE_ON && h->type != CLAP_EVENT_NOTE_OFF) return;
  const clap_event_note_t *n = (const clap_event_note_t *)h;
  if (n->key < 0 || n->key > 127) return;
  if (n->key == 127 && h->type == CLAP_EVENT_NOTE_ON) f->echo = 1;
  else if (h->type == CLAP_EVENT_NOTE_ON) {
    f->on[n->key] = 1;
    f->phase[n->key] = 0;
  } else
    f->on[n->key] = 0;
}

/** The instrument: events applied on their own sample, so timing can be measured to the sample. */
static clap_process_status synth_process(fx_t *f, const clap_process_t *pr) {
  uint32_t ne = pr->in_events->size(pr->in_events), e = 0;
  for (uint32_t i = 0; i < pr->frames_count; i++) {
    while (e < ne) {
      const clap_event_header_t *h = pr->in_events->get(pr->in_events, e);
      if (h->time > i) break;
      synth_event(f, h);
      e++;
    }
    double s = 0;
    for (int k = 0; k < 127; k++)
      if (f->on[k]) {
        s += sin(f->phase[k]);
        f->phase[k] += 2 * 3.141592653589793 * 440.0 * pow(2.0, (k - 69) / 12.0) / f->sr;
      }
    float y = (float)(s * f->level);
    pr->audio_outputs[0].data32[0][i] = y;
    pr->audio_outputs[0].data32[1][i] = y;
  }
  for (; e < ne; e++) synth_event(f, pr->in_events->get(pr->in_events, e));
  if (f->echo) {
    // As if the user turned Level in the plugin's window: gesture, value, gesture end, state dirty.
    f->echo = 0;
    f->level = 0.25;
    clap_event_param_gesture_t g = {{sizeof g, 0, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_PARAM_GESTURE_BEGIN, 0}, 2};
    pr->out_events->try_push(pr->out_events, &g.header);
    clap_event_param_value_t v = {{sizeof v, 0, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_PARAM_VALUE, 0}, 2, NULL, -1, -1, -1, -1, 0.25};
    pr->out_events->try_push(pr->out_events, &v.header);
    g.header.type = CLAP_EVENT_PARAM_GESTURE_END;
    pr->out_events->try_push(pr->out_events, &g.header);
    const clap_host_state_t *hs = (const clap_host_state_t *)f->host->get_extension(f->host, CLAP_EXT_STATE);
    if (hs) hs->mark_dirty(f->host);
  }
  return CLAP_PROCESS_CONTINUE;
}

/** The orchestra: each note in comes out as three notes on three channels, and as MIDI on a fourth. */
static clap_process_status orchestra_process(const clap_process_t *pr) {
  for (uint32_t i = 0; i < pr->in_events->size(pr->in_events); i++) {
    const clap_event_header_t *h = pr->in_events->get(pr->in_events, i);
    if (h->space_id != CLAP_CORE_EVENT_SPACE_ID || (h->type != CLAP_EVENT_NOTE_ON && h->type != CLAP_EVENT_NOTE_OFF)) continue;
    const clap_event_note_t *n = (const clap_event_note_t *)h;
    const int shift[3] = {0, -12, 7};
    for (int c = 0; c < 3; c++) {
      clap_event_note_t o = *n;
      o.channel = (int16_t)c;
      o.key = (int16_t)(n->key + shift[c]);
      pr->out_events->try_push(pr->out_events, &o.header);
    }
    clap_event_midi_t m = {{sizeof m, h->time, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_MIDI, 0}, 0, {(uint8_t)((h->type == CLAP_EVENT_NOTE_ON ? 0x90 : 0x80) | 3), (uint8_t)n->key, (uint8_t)(n->velocity * 127)}};
    pr->out_events->try_push(pr->out_events, &m.header);
  }
  for (uint32_t i = 0; i < pr->frames_count; i++) pr->audio_outputs[0].data32[0][i] = pr->audio_outputs[0].data32[1][i] = 0;
  return CLAP_PROCESS_CONTINUE;
}

static clap_process_status fx_process(const clap_plugin_t *p, const clap_process_t *pr) {
  fx_t *f = (fx_t *)p->plugin_data;
  if (f->kind == 3) return synth_process(f, pr);
  if (f->kind == 4) return orchestra_process(pr);
  for (uint32_t i = 0; i < pr->in_events->size(pr->in_events); i++) apply_event(f, pr->in_events->get(pr->in_events, i));
  if (f->kind == 2 && f->crash > 0.5) abort();
  const float g = (float)pow(10.0, f->gain_db / 20.0);
  for (uint32_t i = 0; i < pr->frames_count; i++) {
    for (uint32_t c = 0; c < 2; c++) {
      float x = pr->audio_inputs_count ? pr->audio_inputs[0].data32[c][i] : 0.f;
      float y = x;
      if (f->kind == 0) y = x * g;
      if (f->kind == 1) {
        y = f->line[c][f->pos];
        f->line[c][f->pos] = x;
      }
      pr->audio_outputs[0].data32[c][i] = y;
    }
    if (f->kind == 1) f->pos = (f->pos + 1) % DELAY;
  }
  return CLAP_PROCESS_CONTINUE;
}
static const void *fx_ext(const clap_plugin_t *p, const char *id) {
  fx_t *f = (fx_t *)p->plugin_data;
  if (!strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &PORTS;
  if (!strcmp(id, CLAP_EXT_PARAMS)) return &PARAMS;
  if (!strcmp(id, CLAP_EXT_LATENCY) && f->kind == 1) return &LATENCY;
  if (!strcmp(id, CLAP_EXT_STATE) && (f->kind == 0 || f->kind == 3)) return &STATE;
  if (!strcmp(id, CLAP_EXT_NOTE_PORTS) && f->kind >= 3) return &NOTE_PORTS;
  return NULL;
}
static void fx_main(const clap_plugin_t *p) { (void)p; }

static const clap_plugin_t *create(const clap_plugin_factory_t *fac, const clap_host_t *host, const char *id) {
  (void)fac;
  for (int k = 0; k < NDESC; k++) {
    if (strcmp(id, DESC[k].id)) continue;
    fx_t *f = (fx_t *)calloc(1, sizeof *f);
    f->host = host;
    f->kind = k;
    f->gain_db = k == 0 ? -6 : 0;
    f->level = 0.5;
    f->sr = 48000;
    f->plugin = (clap_plugin_t){&DESC[k], f, fx_init, fx_destroy, fx_activate, fx_deactivate, fx_start, fx_stop, fx_reset, fx_process, fx_ext, fx_main};
    return &f->plugin;
  }
  return NULL;
}
static uint32_t count(const clap_plugin_factory_t *f) {
  (void)f;
  return NDESC;
}
static const clap_plugin_descriptor_t *descriptor(const clap_plugin_factory_t *f, uint32_t i) {
  (void)f;
  return i < NDESC ? &DESC[i] : NULL;
}
static const clap_plugin_factory_t FACTORY = {count, descriptor, create};

static bool entry_init(const char *path) {
  (void)path;
#ifdef OB_HANG
  for (;;) sleep_s(3600);
#endif
  return true;
}
static void entry_deinit(void) {}
static const void *entry_factory(const char *id) { return !strcmp(id, CLAP_PLUGIN_FACTORY_ID) ? &FACTORY : NULL; }

CLAP_EXPORT const clap_plugin_entry_t clap_entry = {CLAP_VERSION_INIT, entry_init, entry_deinit, entry_factory};
