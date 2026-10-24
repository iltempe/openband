// The platform side of openband-plughost (G8): the main thread runs the system's event loop (plugin
// windows need it), the protocol runs on a thread of its own (CLAP's audio thread), and main-thread work
// is handed over synchronously. macOS: Cocoa (platform_mac.m); Windows: Win32 (platform_win.c); elsewhere
// no plugin windows yet (platform_posix.c).
#pragma once
#include <stdint.h>

typedef void (*main_fn)(void *ctx);

void platform_init(void);
/** Run the main loop until platform_quit(). */
void platform_run(void);
void platform_quit(void);
/** Run fn(ctx) on the main thread and wait for it (runs it directly when already there). */
void run_on_main(main_fn fn, void *ctx);
int platform_is_main_thread(void);
void start_thread(void (*fn)(void *), void *ctx);

// Plugin windows: the CLAP window API this platform offers ("cocoa", "win32"), or NULL.
const char *platform_window_api(void);
typedef struct gui_window gui_window;
gui_window *window_open(const char *title, uint32_t width, uint32_t height, int resizable, void (*on_close)(void *), void *ctx);
/** NSView* (cocoa) or HWND (win32), for clap_window_t. */
void *window_handle(gui_window *w);
void window_resize(gui_window *w, uint32_t width, uint32_t height);
/** Size the window to the view the plugin attached (its own idea of its size can be off), now and again
 *  shortly after, for plugins that size themselves late. */
void window_fit(gui_window *w);
void window_close(gui_window *w);
