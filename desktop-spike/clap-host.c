// F26 spike: a minimal CLAP host (C ABI, the one the Rust crate `clack` wraps).
//   clap-host <plugin.clap> --list                 descriptors in the bundle
//   clap-host <plugin.clap> --render out.wav       a C-major chord for 2 s (+1 s release), 48 kHz stereo
//   clap-host <plugin.clap> --serve                stdin → plugin → stdout, 128-frame stereo float32 blocks
//                                                  (the native side of the WebView ↔ native audio bridge)
// Build: clang -O2 -I<clap>/include clap-host.c -o clap-host   (macOS: .clap bundles, dlopen)
#include <clap/clap.h>
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <unistd.h>

#define SR 48000
#define BLOCK 128

static const void *host_get_extension(const clap_host_t *h, const char *id) { (void)h; (void)id; return NULL; }
static void host_request_restart(const clap_host_t *h) { (void)h; }
static void host_request_process(const clap_host_t *h) { (void)h; }
static void host_request_callback(const clap_host_t *h) { (void)h; }
static const clap_host_t HOST = {
  .clap_version = CLAP_VERSION_INIT, .host_data = NULL, .name = "OpenBand spike", .vendor = "OpenBand", .url = "https://github.com/iltempe/openband", .version = "0.0.1",
  .get_extension = host_get_extension, .request_restart = host_request_restart, .request_process = host_request_process, .request_callback = host_request_callback,
};

// ---- a tiny event list (note on / off) for one process() call
typedef struct { clap_event_note_t ev[16]; uint32_t n; } events_t;
static uint32_t ev_size(const clap_input_events_t *l) { return ((events_t *)l->ctx)->n; }
static const clap_event_header_t *ev_get(const clap_input_events_t *l, uint32_t i) { return &((events_t *)l->ctx)->ev[i].header; }
static bool out_push(const clap_output_events_t *l, const clap_event_header_t *e) { (void)l; (void)e; return true; }
static void note(events_t *e, uint16_t type, int16_t key, double vel, uint32_t time) {
  clap_event_note_t *n = &e->ev[e->n++];
  memset(n, 0, sizeof *n);
  n->header.size = sizeof *n; n->header.time = time; n->header.space_id = CLAP_CORE_EVENT_SPACE_ID; n->header.type = type;
  n->note_id = -1; n->port_index = 0; n->channel = 0; n->key = key; n->velocity = vel;
}

static const clap_plugin_t *load(const char *path, int index) {
  char bin[2048];
  // A macOS bundle: Contents/MacOS/<name without .clap>
  const char *base = strrchr(path, '/'); base = base ? base + 1 : path;
  char name[512]; snprintf(name, sizeof name, "%s", base); char *dot = strstr(name, ".clap"); if (dot) *dot = 0;
  snprintf(bin, sizeof bin, "%s/Contents/MacOS/%s", path, name);
  void *lib = dlopen(bin, RTLD_NOW | RTLD_LOCAL);
  if (!lib) lib = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!lib) { fprintf(stderr, "dlopen: %s\n", dlerror()); exit(1); }
  const clap_plugin_entry_t *entry = dlsym(lib, "clap_entry");
  if (!entry || !entry->init(path)) { fprintf(stderr, "no clap_entry / init failed\n"); exit(1); }
  const clap_plugin_factory_t *f = entry->get_factory(CLAP_PLUGIN_FACTORY_ID);
  uint32_t n = f->get_plugin_count(f);
  if (index < 0) {
    for (uint32_t i = 0; i < n; i++) { const clap_plugin_descriptor_t *d = f->get_plugin_descriptor(f, i); fprintf(stdout, "%u %s (%s) %s\n", i, d->name, d->id, d->version); }
    exit(0);
  }
  const clap_plugin_descriptor_t *d = f->get_plugin_descriptor(f, (uint32_t)index);
  const clap_plugin_t *p = f->create_plugin(f, &HOST, d->id);
  if (!p || !p->init(p)) { fprintf(stderr, "create/init failed\n"); exit(1); }
  if (!p->activate(p, SR, 1, BLOCK)) { fprintf(stderr, "activate failed\n"); exit(1); }
  if (!p->start_processing(p)) { fprintf(stderr, "start_processing failed\n"); exit(1); }
  fprintf(stderr, "loaded %s %s\n", d->name, d->version);
  return p;
}

/** One block: stereo in → stereo out, with events. */
static void run(const clap_plugin_t *p, float *inL, float *inR, float *outL, float *outR, events_t *ev, int64_t steady) {
  float *in[2] = {inL, inR}, *out[2] = {outL, outR};
  clap_audio_buffer_t ib = {.data32 = in, .channel_count = 2, .latency = 0, .constant_mask = 0};
  clap_audio_buffer_t ob = {.data32 = out, .channel_count = 2, .latency = 0, .constant_mask = 0};
  clap_input_events_t iev = {.ctx = ev, .size = ev_size, .get = ev_get};
  clap_output_events_t oev = {.ctx = NULL, .try_push = out_push};
  clap_process_t pr = {.steady_time = steady, .frames_count = BLOCK, .transport = NULL, .audio_inputs = &ib, .audio_outputs = &ob, .audio_inputs_count = 1, .audio_outputs_count = 1, .in_events = &iev, .out_events = &oev};
  p->process(p, &pr);
}

static void wav16(const char *file, float *L, float *R, size_t frames) {
  FILE *f = fopen(file, "wb");
  uint32_t data = (uint32_t)(frames * 4), riff = 36 + data, fmt = 16, rate = SR, bps = SR * 4;
  uint16_t pcm = 1, ch = 2, align = 4, bits = 16;
  fwrite("RIFF", 1, 4, f); fwrite(&riff, 4, 1, f); fwrite("WAVEfmt ", 1, 8, f); fwrite(&fmt, 4, 1, f); fwrite(&pcm, 2, 1, f); fwrite(&ch, 2, 1, f);
  fwrite(&rate, 4, 1, f); fwrite(&bps, 4, 1, f); fwrite(&align, 2, 1, f); fwrite(&bits, 2, 1, f); fwrite("data", 1, 4, f); fwrite(&data, 4, 1, f);
  for (size_t i = 0; i < frames; i++) { int16_t s[2] = {(int16_t)fmaxf(-32767, fminf(32767, L[i] * 32767)), (int16_t)fmaxf(-32767, fminf(32767, R[i] * 32767))}; fwrite(s, 2, 2, f); }
  fclose(f);
}

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: clap-host <plugin.clap> --list | --render out.wav | --serve [index]\n"); return 2; }
  if (!strcmp(argv[2], "--list")) load(argv[1], -1);
  int index = argc > 4 ? atoi(argv[4]) : 0;
  const clap_plugin_t *p = load(argv[1], !strcmp(argv[2], "--serve") && argc > 3 ? atoi(argv[3]) : index);
  static float zl[BLOCK], zr[BLOCK];
  if (!strcmp(argv[2], "--render")) {
    size_t blocks = (size_t)(3.0 * SR / BLOCK), frames = blocks * BLOCK;
    float *L = calloc(frames, sizeof(float)), *R = calloc(frames, sizeof(float));
    double peak = 0, sum = 0;
    for (size_t b = 0; b < blocks; b++) {
      events_t ev = {.n = 0};
      if (b == 0) { note(&ev, CLAP_EVENT_NOTE_ON, 48, 0.8, 0); note(&ev, CLAP_EVENT_NOTE_ON, 52, 0.8, 0); note(&ev, CLAP_EVENT_NOTE_ON, 55, 0.8, 0); }
      if (b == (size_t)(2.0 * SR / BLOCK)) { note(&ev, CLAP_EVENT_NOTE_OFF, 48, 0, 0); note(&ev, CLAP_EVENT_NOTE_OFF, 52, 0, 0); note(&ev, CLAP_EVENT_NOTE_OFF, 55, 0, 0); }
      run(p, zl, zr, L + b * BLOCK, R + b * BLOCK, &ev, (int64_t)(b * BLOCK));
    }
    for (size_t i = 0; i < frames; i++) { double a = fabs(L[i]); if (a > peak) peak = a; sum += L[i] * L[i]; }
    wav16(argv[3], L, R, frames);
    printf("rendered %zu frames: peak %.3f, rms %.1f dBFS → %s\n", frames, peak, 10 * log10(sum / frames + 1e-12), argv[3]);
    return peak > 0.001 ? 0 : 3;
  }
  if (!strcmp(argv[2], "--serve")) {
    // Blocks of 128 stereo float32 frames (L then R) in, the same out, until EOF. A first block can
    // carry a note-on (the 4-byte header's top bit), so an instrument also has something to play.
    float in[2][BLOCK], out[2][BLOCK];
    uint32_t header;
    int64_t steady = 0;
    while (fread(&header, 4, 1, stdin) == 1) {
      if (fread(in, sizeof in, 1, stdin) != 1) break;
      events_t ev = {.n = 0};
      if (header & 0x80000000u) note(&ev, CLAP_EVENT_NOTE_ON, (int16_t)(header & 0x7f), 0.8, 0);
      run(p, in[0], in[1], out[0], out[1], &ev, steady);
      steady += BLOCK;
      fwrite(&header, 4, 1, stdout);
      fwrite(out, sizeof out, 1, stdout);
      fflush(stdout);
    }
    return 0;
  }
  return 2;
}
