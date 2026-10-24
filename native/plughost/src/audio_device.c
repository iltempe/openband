// The audio output of low-latency monitoring (G8.7): the computer's default output device, opened by the
// host itself with a small buffer (miniaudio: CoreAudio, WASAPI, ALSA / PulseAudio), or miniaudio's null
// device (no sound, real timing) for tests and computers without audio.
#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
#define MA_NO_WAV
#define MA_NO_FLAC
#define MA_NO_MP3
#include "miniaudio.h"

#include "audio_device.h"
#include <stdio.h>

#define MAX_FRAMES 4096

static ma_context ctx;
static ma_device dev;
static int ctx_open, dev_open;
static ob_render_fn render;
static void *render_user;
static float planar[2][MAX_FRAMES];

static void callback(ma_device *d, void *out, const void *in, ma_uint32 frames) {
  (void)d, (void)in;
  float *o = (float *)out;
  while (frames) {
    ma_uint32 n = frames < MAX_FRAMES ? frames : MAX_FRAMES;
    float *ch[2] = {planar[0], planar[1]};
    render(ch, n, render_user);
    for (ma_uint32 i = 0; i < n; i++) {
      o[2 * i] = planar[0][i];
      o[2 * i + 1] = planar[1][i];
    }
    o += 2 * n;
    frames -= n;
  }
}

int ob_device_start(uint32_t sample_rate, uint32_t period, int null_device, ob_render_fn fn, void *user, char *info, size_t cap) {
  ob_device_stop();
  render = fn;
  render_user = user;
  ma_backend null_backend[] = {ma_backend_null};
  if (ma_context_init(null_device ? null_backend : NULL, null_device ? 1 : 0, NULL, &ctx) != MA_SUCCESS) {
    snprintf(info, cap, "no audio system");
    return -1;
  }
  ctx_open = 1;
  ma_device_config c = ma_device_config_init(ma_device_type_playback);
  c.playback.format = ma_format_f32;
  c.playback.channels = 2;
  c.sampleRate = sample_rate;
  c.periodSizeInFrames = period;
  c.periods = 2;
  c.performanceProfile = ma_performance_profile_low_latency;
  c.noPreSilencedOutputBuffer = MA_TRUE;
  c.dataCallback = callback;
  if (ma_device_init(&ctx, &c, &dev) != MA_SUCCESS) {
    snprintf(info, cap, "cannot open the audio output");
    ob_device_stop();
    return -1;
  }
  dev_open = 1;
  if (ma_device_start(&dev) != MA_SUCCESS) {
    snprintf(info, cap, "cannot start the audio output");
    ob_device_stop();
    return -1;
  }
  char name[256] = "";
  ma_device_get_name(&dev, ma_device_type_playback, name, sizeof name, NULL);
  for (char *p = name; *p; p++)
    if (*p == '"' || *p == '\\' || (unsigned char)*p < 0x20) *p = ' ';
  snprintf(info, cap, "\"backend\":\"%s\",\"device\":\"%s\",\"period\":%u,\"periods\":%u,\"deviceRate\":%u", ma_get_backend_name(ctx.backend), name,
           dev.playback.internalPeriodSizeInFrames, dev.playback.internalPeriods, dev.playback.internalSampleRate);
  return 0;
}

uint32_t ob_device_buffer(void) { return dev_open ? dev.playback.internalPeriodSizeInFrames * dev.playback.internalPeriods : 0; }

void ob_device_stop(void) {
  if (dev_open) ma_device_uninit(&dev);
  if (ctx_open) ma_context_uninit(&ctx);
  dev_open = ctx_open = 0;
}
