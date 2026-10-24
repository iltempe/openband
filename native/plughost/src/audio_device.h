// The host's own audio output, for low-latency monitoring (G8.7). See audio_device.c.
#pragma once
#include <stddef.h>
#include <stdint.h>

/** Fills `frames` samples of two planar channels, on the device's audio thread. */
typedef void (*ob_render_fn)(float **out, uint32_t frames, void *user);

/** Opens and starts the output (null_device: no sound, real timing); writes a JSON fragment to info, or the error. */
int ob_device_start(uint32_t sample_rate, uint32_t period, int null_device, ob_render_fn fn, void *user, char *info, size_t cap);
/** The device's buffer, in frames (period × periods). */
uint32_t ob_device_buffer(void);
void ob_device_stop(void);
