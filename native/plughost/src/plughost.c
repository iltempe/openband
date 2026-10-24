// openband-plughost (G8): runs native plugins for OpenBand in a process of their own, so a plugin that
// crashes takes only this process down. CLAP for now (VST3 and AU come next).
//
//   openband-plughost scan <bundle.clap>   print the plugins in a bundle as JSON, then exit
//   openband-plughost host                 serve one plugin over stdin/stdout (frames below)
//
// Frames, both ways: u32 length (of what follows, little-endian), u8 type, payload.
//   app → host  1 LOAD       path \0 plugin id \0 sample rate \0 max block \0
//               2 PROCESS    u32 seq, u32 frames, u32 channels, u32 events, events, float32 planar samples
//                            an event: u32 offset, u8 kind (0 note on, 1 note off, 2 parameter, 3 all notes
//                            off), u8 key, u16 0, u32 parameter id, f64 value (velocity 0..1, or the value)
//               3 PARAM      u32 param id, f64 value            (applied at the start of the next block)
//               4 GET_STATE
//               5 SET_STATE  the plugin's state bytes
//               6 QUIT
//               7 GUI_OPEN   window title
//               8 GUI_CLOSE
//               10 GET_VALUES
//   host → app  1 LOADED     JSON {ok, name, latency, inputs, outputs, gui, params[] | error}
//               2 BLOCK      u32 seq, u32 frames, u32 channels, float32 planar samples
//               4 STATE      the plugin's state bytes
//               5 STATE_SET  JSON {ok}
//               7 LATENCY    JSON {latency}                      (the plugin changed its latency)
//               8 ERROR      JSON {error}
//               9 PARAM_CHANGED JSON {id, value}                 (moved in the plugin's own window)
//               10 GESTURE   JSON {id, begin}                    (a control grabbed / let go)
//               11 STATE_DIRTY                                   (the plugin's state changed)
//               12 GUI       JSON {open, supported?, error?}
//               13 VALUES    JSON [{id, value}]
//
// Threads, as CLAP wants them: the main thread runs the system's event loop (the plugin's window lives
// there) and everything CLAP marks [main-thread]; the protocol thread is the audio thread and runs
// process(). No access to the project or the network: only audio, events, parameters and state come in.
#include <clap/clap.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "platform.h"

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
static SRWLOCK out_mu = SRWLOCK_INIT;
#define OUT_LOCK() AcquireSRWLockExclusive(&out_mu)
#define OUT_UNLOCK() ReleaseSRWLockExclusive(&out_mu)
#else
#include <dlfcn.h>
#include <pthread.h>
static pthread_mutex_t out_mu = PTHREAD_MUTEX_INITIALIZER;
#define OUT_LOCK() pthread_mutex_lock(&out_mu)
#define OUT_UNLOCK() pthread_mutex_unlock(&out_mu)
#endif

#define MAX_CH 8
#define MAX_BLOCK 8192
#define MAX_EVENTS 1024

// ---------------------------------------------------------------- I/O

static int read_full(void *buf, size_t n) {
  uint8_t *p = (uint8_t *)buf;
  while (n) {
    size_t r = fread(p, 1, n, stdin);
    if (r == 0) return 0;
    p += r;
    n -= r;
  }
  return 1;
}

static void write_frame(uint8_t type, const void *a, uint32_t alen) {
  uint32_t len = 1 + alen;
  OUT_LOCK();
  fwrite(&len, 4, 1, stdout);
  fwrite(&type, 1, 1, stdout);
  if (alen) fwrite(a, 1, alen, stdout);
  fflush(stdout);
  OUT_UNLOCK();
}

static void write_json(uint8_t type, const char *json) { write_frame(type, json, (uint32_t)strlen(json)); }

/** A JSON string literal of s (quotes included) appended to out. */
static void json_str(char *out, size_t cap, const char *s) {
  size_t o = strlen(out);
  if (o + 2 >= cap) return;
  out[o++] = '"';
  for (; s && *s && o + 8 < cap; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') {
      out[o++] = '\\';
      out[o++] = (char)c;
    } else if (c < 0x20) {
      o += (size_t)snprintf(out + o, cap - o, "\\u%04x", c);
    } else
      out[o++] = (char)c;
  }
  out[o++] = '"';
  out[o] = 0;
}

static void error_json(uint8_t type, const char *msg) {
  char buf[1024] = "{\"ok\":false,\"error\":";
  json_str(buf, sizeof buf, msg);
  strcat(buf, "}");
  write_json(type, buf);
}

// ---------------------------------------------------------------- loading a bundle

static void *lib_open(const char *path) {
#ifdef _WIN32
  wchar_t w[2048];
  MultiByteToWideChar(CP_UTF8, 0, path, -1, w, 2048);
  return (void *)LoadLibraryW(w);
#else
  void *h = NULL;
#ifdef __APPLE__
  // A macOS bundle: <name>.clap/Contents/MacOS/<name>
  const char *base = strrchr(path, '/');
  base = base ? base + 1 : path;
  char name[512], bin[2048];
  snprintf(name, sizeof name, "%s", base);
  char *dot = strstr(name, ".clap");
  if (dot) *dot = 0;
  snprintf(bin, sizeof bin, "%s/Contents/MacOS/%s", path, name);
  h = dlopen(bin, RTLD_NOW | RTLD_LOCAL);
#endif
  if (!h) h = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  return h;
#endif
}

static void *lib_sym(void *h, const char *name) {
#ifdef _WIN32
  return (void *)GetProcAddress((HMODULE)h, name);
#else
  return dlsym(h, name);
#endif
}

static const char *lib_error(void) {
#ifdef _WIN32
  return "LoadLibrary failed";
#else
  const char *e = dlerror();
  return e ? e : "dlopen failed";
#endif
}

static const clap_plugin_entry_t *open_entry(const char *path, char *err, size_t errcap) {
  void *lib = lib_open(path);
  if (!lib) {
    snprintf(err, errcap, "cannot load %s: %s", path, lib_error());
    return NULL;
  }
  const clap_plugin_entry_t *entry = (const clap_plugin_entry_t *)lib_sym(lib, "clap_entry");
  if (!entry) {
    snprintf(err, errcap, "%s has no clap_entry", path);
    return NULL;
  }
  if (!clap_version_is_compatible(entry->clap_version)) {
    snprintf(err, errcap, "%s uses an incompatible CLAP version %u.%u", path, entry->clap_version.major, entry->clap_version.minor);
    return NULL;
  }
  if (!entry->init(path)) {
    snprintf(err, errcap, "%s: clap_entry.init failed", path);
    return NULL;
  }
  return entry;
}

// ---------------------------------------------------------------- scan

static int scan(const char *path) {
  char err[1024];
  const clap_plugin_entry_t *entry = open_entry(path, err, sizeof err);
  if (!entry) {
    fprintf(stderr, "%s\n", err);
    return 2;
  }
  const clap_plugin_factory_t *f = (const clap_plugin_factory_t *)entry->get_factory(CLAP_PLUGIN_FACTORY_ID);
  if (!f) {
    fprintf(stderr, "%s: no plugin factory\n", path);
    return 2;
  }
  static char out[65536];
  strcpy(out, "{\"plugins\":[");
  uint32_t n = f->get_plugin_count(f);
  for (uint32_t i = 0; i < n; i++) {
    const clap_plugin_descriptor_t *d = f->get_plugin_descriptor(f, i);
    if (!d) continue;
    if (i) strcat(out, ",");
    strcat(out, "{\"id\":");
    json_str(out, sizeof out, d->id);
    strcat(out, ",\"name\":");
    json_str(out, sizeof out, d->name);
    strcat(out, ",\"vendor\":");
    json_str(out, sizeof out, d->vendor ? d->vendor : "");
    strcat(out, ",\"version\":");
    json_str(out, sizeof out, d->version ? d->version : "");
    strcat(out, ",\"description\":");
    json_str(out, sizeof out, d->description ? d->description : "");
    strcat(out, ",\"features\":[");
    for (const char *const *ft = d->features; ft && *ft; ft++) {
      if (ft != d->features) strcat(out, ",");
      json_str(out, sizeof out, *ft);
    }
    strcat(out, "]}");
  }
  strcat(out, "]}");
  fputs(out, stdout);
  fputc('\n', stdout);
  entry->deinit();
  return 0;
}

// ---------------------------------------------------------------- one plugin, served

typedef struct {
  const clap_plugin_entry_t *entry;
  const clap_plugin_t *plugin;
  const clap_plugin_params_t *params;
  const clap_plugin_latency_t *latency;
  const clap_plugin_state_t *state;
  const clap_plugin_gui_t *gui;
  uint32_t in_ch, out_ch;
  double sr;
  uint32_t max_block;
  int64_t steady;
  int processing;
  gui_window *window;
  int gui_floating;
} session_t;

static session_t S;
static volatile int g_latency_changed, g_callback_requested, g_restart_requested, g_state_dirty;

// ---- what the host offers the plugin
static void host_latency_changed(const clap_host_t *h) {
  (void)h;
  g_latency_changed = 1;
}
static const clap_host_latency_t HOST_LATENCY = {host_latency_changed};

static void host_params_rescan(const clap_host_t *h, clap_param_rescan_flags f) { (void)h, (void)f; }
static void host_params_clear(const clap_host_t *h, clap_id id, clap_param_clear_flags f) { (void)h, (void)id, (void)f; }
static void host_params_request_flush(const clap_host_t *h) { (void)h; }
static const clap_host_params_t HOST_PARAMS = {host_params_rescan, host_params_clear, host_params_request_flush};

static void host_state_mark_dirty(const clap_host_t *h) {
  (void)h;
  g_state_dirty = 1;
}
static const clap_host_state_t HOST_STATE = {host_state_mark_dirty};

static bool host_is_main(const clap_host_t *h) {
  (void)h;
  return platform_is_main_thread() != 0;
}
static bool host_is_audio(const clap_host_t *h) {
  (void)h;
  return platform_is_main_thread() == 0;
}
static const clap_host_thread_check_t HOST_THREADS = {host_is_main, host_is_audio};

typedef struct {
  uint32_t w, h;
} size_t2;
static void do_resize(void *ctx) {
  size_t2 *s = (size_t2 *)ctx;
  if (S.window) window_resize(S.window, s->w, s->h);
}
static void host_gui_hints(const clap_host_t *h) { (void)h; }
static bool host_gui_resize(const clap_host_t *h, uint32_t w, uint32_t hh) {
  (void)h;
  size_t2 s = {w, hh};
  run_on_main(do_resize, &s);
  return true;
}
static bool host_gui_show(const clap_host_t *h) {
  (void)h;
  return true;
}
static bool host_gui_hide(const clap_host_t *h) {
  (void)h;
  return true;
}
static void gui_close_main(void *ctx);
static void host_gui_closed(const clap_host_t *h, bool destroyed) {
  (void)h, (void)destroyed;
  run_on_main(gui_close_main, NULL);
}
static const clap_host_gui_t HOST_GUI = {host_gui_hints, host_gui_resize, host_gui_show, host_gui_hide, host_gui_closed};

static const void *host_get_extension(const clap_host_t *h, const char *id) {
  (void)h;
  if (!strcmp(id, CLAP_EXT_LATENCY)) return &HOST_LATENCY;
  if (!strcmp(id, CLAP_EXT_PARAMS)) return &HOST_PARAMS;
  if (!strcmp(id, CLAP_EXT_STATE)) return &HOST_STATE;
  if (!strcmp(id, CLAP_EXT_THREAD_CHECK)) return &HOST_THREADS;
  if (!strcmp(id, CLAP_EXT_GUI)) return &HOST_GUI;
  return NULL;
}
static void host_request_restart(const clap_host_t *h) {
  (void)h;
  g_restart_requested = 1;
}
static void host_request_process(const clap_host_t *h) { (void)h; }
static void host_request_callback(const clap_host_t *h) {
  (void)h;
  g_callback_requested = 1;
}

static const clap_host_t HOST = {
    CLAP_VERSION_INIT, NULL, "OpenBand", "OpenBand", "https://github.com/iltempe/openband", "1.0.0", host_get_extension, host_request_restart, host_request_process, host_request_callback,
};

// ---- events into process(): notes and parameters, in time order
typedef union {
  clap_event_header_t h;
  clap_event_note_t note;
  clap_event_param_value_t param;
} any_event_t;
typedef struct {
  any_event_t ev[MAX_EVENTS];
  uint32_t n;
} events_t;
static events_t IN;          // this block's events
static events_t PENDING;     // PARAM messages since the last block (at its start)
static uint8_t held[128];    // notes on, for "all notes off"

static uint32_t in_size(const clap_input_events_t *l) { return ((events_t *)l->ctx)->n; }
static const clap_event_header_t *in_get(const clap_input_events_t *l, uint32_t i) { return &((events_t *)l->ctx)->ev[i].h; }

static void push_param(events_t *e, uint32_t time, uint32_t id, double v) {
  if (e->n >= MAX_EVENTS) return;
  clap_event_param_value_t *p = &e->ev[e->n++].param;
  memset(p, 0, sizeof *p);
  p->header.size = sizeof *p;
  p->header.time = time;
  p->header.space_id = CLAP_CORE_EVENT_SPACE_ID;
  p->header.type = CLAP_EVENT_PARAM_VALUE;
  p->param_id = id;
  p->note_id = -1;
  p->port_index = -1;
  p->channel = -1;
  p->key = -1;
  p->value = v;
}
static void push_note(events_t *e, uint32_t time, uint16_t type, int16_t key, double vel) {
  if (e->n >= MAX_EVENTS || key < 0 || key > 127) return;
  clap_event_note_t *n = &e->ev[e->n++].note;
  memset(n, 0, sizeof *n);
  n->header.size = sizeof *n;
  n->header.time = time;
  n->header.space_id = CLAP_CORE_EVENT_SPACE_ID;
  n->header.type = type;
  n->note_id = -1;
  n->port_index = 0;
  n->channel = 0;
  n->key = key;
  n->velocity = vel;
  held[key] = type == CLAP_EVENT_NOTE_ON;
}

// ---- what comes out of process(): parameters moved in the plugin's window, gestures
typedef struct {
  uint16_t type;
  uint32_t id;
  double value;
} out_ev_t;
static out_ev_t OUTQ[256];
static uint32_t outq_n;
static bool out_push(const clap_output_events_t *l, const clap_event_header_t *e) {
  (void)l;
  if (e->space_id != CLAP_CORE_EVENT_SPACE_ID || outq_n >= 256) return true;
  if (e->type == CLAP_EVENT_PARAM_VALUE) {
    const clap_event_param_value_t *p = (const clap_event_param_value_t *)e;
    OUTQ[outq_n++] = (out_ev_t){CLAP_EVENT_PARAM_VALUE, p->param_id, p->value};
  } else if (e->type == CLAP_EVENT_PARAM_GESTURE_BEGIN || e->type == CLAP_EVENT_PARAM_GESTURE_END) {
    const clap_event_param_gesture_t *g = (const clap_event_param_gesture_t *)e;
    OUTQ[outq_n++] = (out_ev_t){e->type, g->param_id, 0};
  }
  return true;
}
static void flush_out_events(void) {
  char buf[128];
  for (uint32_t i = 0; i < outq_n; i++) {
    if (OUTQ[i].type == CLAP_EVENT_PARAM_VALUE) {
      snprintf(buf, sizeof buf, "{\"id\":%u,\"value\":%.17g}", OUTQ[i].id, OUTQ[i].value);
      write_json(9, buf);
    } else {
      snprintf(buf, sizeof buf, "{\"id\":%u,\"begin\":%s}", OUTQ[i].id, OUTQ[i].type == CLAP_EVENT_PARAM_GESTURE_BEGIN ? "true" : "false");
      write_json(10, buf);
    }
  }
  outq_n = 0;
}

static uint32_t port_channels(const clap_plugin_t *p, bool input) {
  const clap_plugin_audio_ports_t *ap = (const clap_plugin_audio_ports_t *)p->get_extension(p, CLAP_EXT_AUDIO_PORTS);
  if (!ap || ap->count(p, input) == 0) return input ? 0 : 2;
  clap_audio_port_info_t info;
  if (!ap->get(p, 0, input, &info)) return 2;
  return info.channel_count > MAX_CH ? MAX_CH : info.channel_count;
}

static void loaded_reply(void) {
  static char out[262144];
  snprintf(out, sizeof out, "{\"ok\":true,\"name\":");
  json_str(out, sizeof out, S.plugin->desc->name);
  uint32_t lat = S.latency ? S.latency->get(S.plugin) : 0;
  const char *api = platform_window_api();
  int gui = S.gui && api && (S.gui->is_api_supported(S.plugin, api, false) || S.gui->is_api_supported(S.plugin, api, true));
  size_t o = strlen(out);
  snprintf(out + o, sizeof out - o, ",\"latency\":%u,\"inputs\":%u,\"outputs\":%u,\"gui\":%s,\"params\":[", lat, S.in_ch, S.out_ch, gui ? "true" : "false");
  if (S.params) {
    uint32_t n = S.params->count(S.plugin);
    int first = 1;
    for (uint32_t i = 0; i < n; i++) {
      clap_param_info_t info;
      if (!S.params->get_info(S.plugin, i, &info)) continue;
      if (info.flags & CLAP_PARAM_IS_HIDDEN) continue;
      if (strlen(out) + 768 > sizeof out) break;
      if (!first) strcat(out, ",");
      first = 0;
      double value = info.default_value;
      S.params->get_value(S.plugin, info.id, &value);
      o = strlen(out);
      snprintf(out + o, sizeof out - o, "{\"id\":%u,\"name\":", info.id);
      json_str(out, sizeof out, info.name);
      o = strlen(out);
      snprintf(out + o, sizeof out - o, ",\"module\":");
      json_str(out, sizeof out, info.module);
      o = strlen(out);
      snprintf(out + o, sizeof out - o, ",\"min\":%.17g,\"max\":%.17g,\"default\":%.17g,\"value\":%.17g,\"stepped\":%s,\"automatable\":%s}", info.min_value, info.max_value, info.default_value, value,
               (info.flags & CLAP_PARAM_IS_STEPPED) ? "true" : "false", (info.flags & CLAP_PARAM_IS_AUTOMATABLE) ? "true" : "false");
    }
  }
  strcat(out, "]}");
  write_json(1, out);
}

typedef struct {
  char *payload;
  uint32_t len;
  int ok;
} load_job_t;

static void load_main(void *ctx) {
  load_job_t *j = (load_job_t *)ctx;
  // path \0 id \0 sr \0 max_block \0
  char *fields[4] = {0};
  uint32_t k = 0;
  char *p = j->payload;
  for (uint32_t i = 0; i < j->len && k < 4; i++)
    if (j->payload[i] == 0) {
      fields[k++] = p;
      p = j->payload + i + 1;
    }
  if (k < 4) {
    error_json(1, "LOAD needs path, id, sample rate and block size");
    return;
  }
  char err[1024];
  S.entry = open_entry(fields[0], err, sizeof err);
  if (!S.entry) {
    error_json(1, err);
    return;
  }
  const clap_plugin_factory_t *f = (const clap_plugin_factory_t *)S.entry->get_factory(CLAP_PLUGIN_FACTORY_ID);
  S.plugin = f ? f->create_plugin(f, &HOST, fields[1]) : NULL;
  if (!S.plugin || !S.plugin->init(S.plugin)) {
    snprintf(err, sizeof err, "cannot create %s from %s", fields[1], fields[0]);
    S.plugin = NULL;
    error_json(1, err);
    return;
  }
  S.params = (const clap_plugin_params_t *)S.plugin->get_extension(S.plugin, CLAP_EXT_PARAMS);
  S.latency = (const clap_plugin_latency_t *)S.plugin->get_extension(S.plugin, CLAP_EXT_LATENCY);
  S.state = (const clap_plugin_state_t *)S.plugin->get_extension(S.plugin, CLAP_EXT_STATE);
  S.gui = (const clap_plugin_gui_t *)S.plugin->get_extension(S.plugin, CLAP_EXT_GUI);
  S.in_ch = port_channels(S.plugin, true);
  S.out_ch = port_channels(S.plugin, false);
  S.sr = atof(fields[2]);
  S.max_block = (uint32_t)atoi(fields[3]);
  if (S.max_block < 1 || S.max_block > MAX_BLOCK) S.max_block = 128;
  if (!S.plugin->activate(S.plugin, S.sr, 1, S.max_block)) {
    error_json(1, "the plugin did not activate");
    return;
  }
  loaded_reply();
  j->ok = 1;
}

static float g_in[MAX_CH][MAX_BLOCK];
static float g_out[MAX_CH][MAX_BLOCK];

static void process(const uint8_t *payload, uint32_t len) {
  if (len < 16) return;
  uint32_t seq, frames, nch, nev;
  memcpy(&seq, payload, 4);
  memcpy(&frames, payload + 4, 4);
  memcpy(&nch, payload + 8, 4);
  memcpy(&nev, payload + 12, 4);
  const uint8_t *evp = payload + 16;
  if (frames > MAX_BLOCK || nch > MAX_CH || nev > MAX_EVENTS || len < 16 + (size_t)nev * 20 + (size_t)frames * nch * 4) return;
  if (!S.processing) S.processing = S.plugin->start_processing(S.plugin);
  // Events: the PARAM messages at the start, then the block's own, in time order (the app sends them sorted).
  IN.n = 0;
  for (uint32_t i = 0; i < PENDING.n; i++) IN.ev[IN.n++] = PENDING.ev[i];
  PENDING.n = 0;
  for (uint32_t i = 0; i < nev; i++, evp += 20) {
    uint32_t offset, id;
    uint8_t kind = evp[4], key = evp[5];
    double value;
    memcpy(&offset, evp, 4);
    memcpy(&id, evp + 8, 4);
    memcpy(&value, evp + 12, 8);
    if (offset >= frames) offset = frames - 1;
    if (kind == 0) push_note(&IN, offset, CLAP_EVENT_NOTE_ON, key, value);
    else if (kind == 1) push_note(&IN, offset, CLAP_EVENT_NOTE_OFF, key, value);
    else if (kind == 2) push_param(&IN, offset, id, value);
    else if (kind == 3)
      for (int k = 0; k < 128; k++)
        if (held[k]) push_note(&IN, offset, CLAP_EVENT_NOTE_OFF, (int16_t)k, 0);
  }
  const float *src = (const float *)(payload + 16 + (size_t)nev * 20);
  float *ins[MAX_CH], *outs[MAX_CH];
  for (uint32_t c = 0; c < MAX_CH; c++) {
    uint32_t from = nch ? (c < nch ? c : nch - 1) : 0;
    if (nch) memcpy(g_in[c], src + (size_t)from * frames, frames * 4);
    else memset(g_in[c], 0, frames * 4);
    ins[c] = g_in[c];
    outs[c] = g_out[c];
    memset(g_out[c], 0, frames * 4);
  }
  clap_audio_buffer_t in = {ins, NULL, S.in_ch, 0, 0};
  clap_audio_buffer_t out = {outs, NULL, S.out_ch, 0, 0};
  clap_input_events_t ievs = {&IN, in_size, in_get};
  clap_output_events_t oevs = {NULL, out_push};
  clap_process_t proc;
  memset(&proc, 0, sizeof proc);
  proc.steady_time = S.steady;
  proc.frames_count = frames;
  proc.audio_inputs = S.in_ch ? &in : NULL;
  proc.audio_inputs_count = S.in_ch ? 1 : 0;
  proc.audio_outputs = &out;
  proc.audio_outputs_count = 1;
  proc.in_events = &ievs;
  proc.out_events = &oevs;
  S.plugin->process(S.plugin, &proc);
  S.steady += frames;
  // Reply with as many channels as came in (stereo in → stereo out; a mono plugin's output is copied).
  uint32_t och = nch ? nch : 2;
  static uint8_t reply[12 + MAX_CH * MAX_BLOCK * 4];
  memcpy(reply, &seq, 4);
  memcpy(reply + 4, &frames, 4);
  memcpy(reply + 8, &och, 4);
  uint32_t have = S.out_ch ? S.out_ch : 1;
  for (uint32_t c = 0; c < och; c++) memcpy(reply + 12 + (size_t)c * frames * 4, g_out[c < have ? c : have - 1], frames * 4);
  write_frame(2, reply, 12 + och * frames * 4);
  flush_out_events();
}

static void queue_param(const uint8_t *payload, uint32_t len) {
  if (len < 12) return;
  uint32_t id;
  double v;
  memcpy(&id, payload, 4);
  memcpy(&v, payload + 4, 8);
  push_param(&PENDING, 0, id, v);
}

// ---- state
typedef struct {
  uint8_t *buf;
  size_t len, cap, pos;
} bytes_t;
static int64_t os_write(const clap_ostream_t *s, const void *b, uint64_t n) {
  bytes_t *x = (bytes_t *)s->ctx;
  if (x->len + n > x->cap) {
    size_t cap = (x->cap ? x->cap * 2 : 4096);
    while (cap < x->len + n) cap *= 2;
    uint8_t *nb = (uint8_t *)realloc(x->buf, cap);
    if (!nb) return -1;
    x->buf = nb;
    x->cap = cap;
  }
  memcpy(x->buf + x->len, b, n);
  x->len += n;
  return (int64_t)n;
}
static int64_t is_read(const clap_istream_t *s, void *b, uint64_t n) {
  bytes_t *x = (bytes_t *)s->ctx;
  size_t k = x->len - x->pos < n ? x->len - x->pos : (size_t)n;
  memcpy(b, x->buf + x->pos, k);
  x->pos += k;
  return (int64_t)k;
}
static void get_state_main(void *ctx) {
  (void)ctx;
  bytes_t x = {0};
  clap_ostream_t os = {&x, os_write};
  if (!S.state || !S.state->save(S.plugin, &os)) write_frame(4, NULL, 0);
  else write_frame(4, x.buf, (uint32_t)x.len);
  free(x.buf);
}
typedef struct {
  uint8_t *p;
  uint32_t n;
} blob_t;
static void set_state_main(void *ctx) {
  blob_t *b = (blob_t *)ctx;
  bytes_t x = {b->p, b->n, b->n, 0};
  clap_istream_t is = {&x, is_read};
  int ok = S.state && S.state->load(S.plugin, &is);
  write_json(5, ok ? "{\"ok\":true}" : "{\"ok\":false}");
}

static void values_main(void *ctx) {
  (void)ctx;
  static char out[131072];
  strcpy(out, "[");
  if (S.params) {
    uint32_t n = S.params->count(S.plugin);
    for (uint32_t i = 0; i < n && strlen(out) + 64 < sizeof out; i++) {
      clap_param_info_t info;
      double v;
      if (!S.params->get_info(S.plugin, i, &info) || !S.params->get_value(S.plugin, info.id, &v)) continue;
      size_t o = strlen(out);
      snprintf(out + o, sizeof out - o, "%s{\"id\":%u,\"value\":%.17g}", o > 1 ? "," : "", info.id, v);
    }
  }
  strcat(out, "]");
  write_json(13, out);
}

// ---- the plugin's window
static void gui_close_main(void *ctx) {
  (void)ctx;
  if (!S.gui || (!S.window && !S.gui_floating)) return;
  S.gui->hide(S.plugin);
  S.gui->destroy(S.plugin);
  if (S.window) window_close(S.window);
  S.window = NULL;
  S.gui_floating = 0;
  write_json(12, "{\"open\":false}");
}
static void on_window_close(void *ctx) { gui_close_main(ctx); }

static void gui_open_main(void *ctx) {
  const char *title = (const char *)ctx;
  const char *api = platform_window_api();
  if (S.window || S.gui_floating) {
    write_json(12, "{\"open\":true}");
    return;
  }
  if (!S.gui || !api) {
    write_json(12, "{\"open\":false,\"supported\":false}");
    return;
  }
  if (S.gui->is_api_supported(S.plugin, api, false) && S.gui->create(S.plugin, api, false)) {
    uint32_t w = 640, h = 400;
    // Cocoa sizes are in points and the plugin scales itself; elsewhere the scale is 1 (no HiDPI yet).
    if (strcmp(api, "cocoa")) S.gui->set_scale(S.plugin, 1.0);
    S.gui->get_size(S.plugin, &w, &h);
    S.window = window_open(title, w, h, 0, on_window_close, NULL);
    clap_window_t win;
    memset(&win, 0, sizeof win);
    win.api = api;
    win.ptr = window_handle(S.window);
    if (!S.gui->set_parent(S.plugin, &win)) {
      S.gui->destroy(S.plugin);
      window_close(S.window);
      S.window = NULL;
      write_json(12, "{\"open\":false,\"error\":\"the plugin did not attach its window\"}");
      return;
    }
    // Some plugins only know their size once attached.
    if (S.gui->get_size(S.plugin, &w, &h)) window_resize(S.window, w, h);
    S.gui->show(S.plugin);
    window_fit(S.window);
  } else if (S.gui->is_api_supported(S.plugin, api, true) && S.gui->create(S.plugin, api, true)) {
    S.gui->suggest_title(S.plugin, title);
    S.gui->show(S.plugin);
    S.gui_floating = 1;
  } else {
    write_json(12, "{\"open\":false,\"supported\":false}");
    return;
  }
  write_json(12, "{\"open\":true}");
}

static void on_main_thread(void *ctx) {
  (void)ctx;
  if (S.plugin) S.plugin->on_main_thread(S.plugin);
}

static void cleanup_main(void *ctx) {
  (void)ctx;
  if (!S.plugin) return;
  if (S.window || S.gui_floating) {
    S.gui->hide(S.plugin);
    S.gui->destroy(S.plugin);
    if (S.window) window_close(S.window);
  }
  S.plugin->deactivate(S.plugin);
  S.plugin->destroy(S.plugin);
  if (S.entry) S.entry->deinit();
  S.plugin = NULL;
}

static uint8_t buf[16 + MAX_EVENTS * 20 + MAX_CH * MAX_BLOCK * 4 + 65536];

static void serve_thread(void *unused) {
  (void)unused;
  for (;;) {
    uint32_t len;
    if (!read_full(&len, 4)) break;
    if (len == 0 || len > sizeof buf) {
      fprintf(stderr, "bad frame length %u\n", len);
      break;
    }
    if (!read_full(buf, len)) break;
    uint8_t type = buf[0];
    uint8_t *payload = buf + 1;
    uint32_t plen = len - 1;
    if (type == 1) {
      load_job_t j = {(char *)payload, plen, 0};
      run_on_main(load_main, &j);
      if (!j.ok) break;
    } else if (!S.plugin) {
      error_json(8, "no plugin loaded");
    } else if (type == 2) {
      process(payload, plen);
    } else if (type == 3) {
      queue_param(payload, plen);
    } else if (type == 4) {
      run_on_main(get_state_main, NULL);
    } else if (type == 5) {
      blob_t b = {payload, plen};
      run_on_main(set_state_main, &b);
    } else if (type == 6) {
      break;
    } else if (type == 7) {
      payload[plen] = 0;
      run_on_main(gui_open_main, payload);
    } else if (type == 8) {
      run_on_main(gui_close_main, NULL);
    } else if (type == 10) {
      run_on_main(values_main, NULL);
    }
    if (S.plugin && g_callback_requested) {
      g_callback_requested = 0;
      run_on_main(on_main_thread, NULL);
    }
    if (S.plugin && g_state_dirty) {
      g_state_dirty = 0;
      write_frame(11, NULL, 0);
    }
    if (S.plugin && g_latency_changed) {
      g_latency_changed = 0;
      char out[64];
      snprintf(out, sizeof out, "{\"latency\":%u}", S.latency ? S.latency->get(S.plugin) : 0);
      write_json(7, out);
    }
  }
  if (S.plugin && S.processing) S.plugin->stop_processing(S.plugin);
  run_on_main(cleanup_main, NULL);
  platform_quit();
}

int main(int argc, char **argv) {
  if (argc >= 3 && !strcmp(argv[1], "scan")) return scan(argv[2]);
  if (argc >= 2 && !strcmp(argv[1], "host")) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    platform_init();
    start_thread(serve_thread, NULL);
    platform_run();
    return 0;
  }
  if (argc >= 2 && !strcmp(argv[1], "--version")) {
    printf("openband-plughost 1.1.0 (CLAP %u.%u.%u)\n", CLAP_VERSION_MAJOR, CLAP_VERSION_MINOR, CLAP_VERSION_REVISION);
    return 0;
  }
  fprintf(stderr, "usage: openband-plughost scan <bundle.clap> | host | --version\n");
  return 1;
}
