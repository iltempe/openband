// Test fixtures for openband-plughost (G8): small CLAP plugins built only for the tests, never shipped.
//   org.openband.fixture.gain    stereo effect, one parameter "Gain" (dB, default −6), state = the gain
//   org.openband.fixture.delay   stereo effect with 256 samples of latency (reported through clap.latency)
//   org.openband.fixture.crash   passes audio through; its "Crash" parameter makes it abort() in process
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
  int kind; // 0 gain, 1 delay, 2 crash
  double gain_db;
  double crash;
  float line[2][DELAY];
  uint32_t pos;
} fx_t;

static const char *FEATURES[] = {CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, CLAP_PLUGIN_FEATURE_UTILITY, NULL};
static const clap_plugin_descriptor_t DESC[3] = {
    {CLAP_VERSION_INIT, "org.openband.fixture.gain", "OB Fixture Gain", "OpenBand", "", "", "", "1.0.0", "A gain for tests", FEATURES},
    {CLAP_VERSION_INIT, "org.openband.fixture.delay", "OB Fixture Delay", "OpenBand", "", "", "", "1.0.0", "256 samples of latency, for tests", FEATURES},
    {CLAP_VERSION_INIT, "org.openband.fixture.crash", "OB Fixture Crash", "OpenBand", "", "", "", "1.0.0", "Crashes on demand, for tests", FEATURES},
};

// ---- audio ports: one stereo in, one stereo out
static uint32_t ports_count(const clap_plugin_t *p, bool in) {
  (void)p;
  (void)in;
  return 1;
}
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

// ---- params: gain (id 0) or crash (id 1)
static uint32_t params_count(const clap_plugin_t *p) { return ((fx_t *)p->plugin_data)->kind == 1 ? 0 : 1; }
static bool params_info(const clap_plugin_t *p, uint32_t i, clap_param_info_t *info) {
  fx_t *f = (fx_t *)p->plugin_data;
  if (i) return false;
  memset(info, 0, sizeof *info);
  info->flags = CLAP_PARAM_IS_AUTOMATABLE;
  if (f->kind == 0) {
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
  *v = id == 0 ? f->gain_db : f->crash;
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
  int n = snprintf(buf, sizeof buf, "gain=%.6f", ((fx_t *)p->plugin_data)->gain_db);
  return s->write(s, buf, (uint64_t)n) == n;
}
static bool state_load(const clap_plugin_t *p, const clap_istream_t *s) {
  char buf[64] = {0};
  int64_t n = s->read(s, buf, sizeof buf - 1);
  if (n <= 0 || strncmp(buf, "gain=", 5)) return false;
  ((fx_t *)p->plugin_data)->gain_db = atof(buf + 5);
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
  (void)p;
  (void)sr;
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
static clap_process_status fx_process(const clap_plugin_t *p, const clap_process_t *pr) {
  fx_t *f = (fx_t *)p->plugin_data;
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
  if (!strcmp(id, CLAP_EXT_STATE) && f->kind == 0) return &STATE;
  return NULL;
}
static void fx_main(const clap_plugin_t *p) { (void)p; }

static const clap_plugin_t *create(const clap_plugin_factory_t *fac, const clap_host_t *host, const char *id) {
  (void)fac;
  for (int k = 0; k < 3; k++) {
    if (strcmp(id, DESC[k].id)) continue;
    fx_t *f = (fx_t *)calloc(1, sizeof *f);
    f->host = host;
    f->kind = k;
    f->gain_db = k == 0 ? -6 : 0;
    f->plugin = (clap_plugin_t){&DESC[k], f, fx_init, fx_destroy, fx_activate, fx_deactivate, fx_start, fx_stop, fx_reset, fx_process, fx_ext, fx_main};
    return &f->plugin;
  }
  return NULL;
}
static uint32_t count(const clap_plugin_factory_t *f) {
  (void)f;
  return 3;
}
static const clap_plugin_descriptor_t *descriptor(const clap_plugin_factory_t *f, uint32_t i) {
  (void)f;
  return i < 3 ? &DESC[i] : NULL;
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
