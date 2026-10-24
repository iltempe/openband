// macOS: an accessory app (no Dock icon) whose main thread runs Cocoa, with floating plugin windows.
#import <Cocoa/Cocoa.h>
#include <pthread.h>
#include "platform.h"

struct gui_window {
  NSWindow *win;
  id delegate;
};

@interface OBWindowDelegate : NSObject <NSWindowDelegate>
@property(nonatomic) void (*onClose)(void *);
@property(nonatomic) void *ctx;
@end
@implementation OBWindowDelegate
- (BOOL)windowShouldClose:(NSWindow *)sender {
  (void)sender;
  if (self.onClose) self.onClose(self.ctx);
  return NO; // the host closes it, after the plugin has let go of its view
}
@end

static id activity;

void platform_init(void) {
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  // Audio can't wait: no App Nap or timer throttling for this process, even with no window on screen.
  activity = [[NSProcessInfo processInfo] beginActivityWithOptions:NSActivityUserInitiated | NSActivityLatencyCritical reason:@"OpenBand plays audio through this plugin"];
}

void platform_run(void) { [NSApp run]; }

void platform_quit(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [NSApp stop:nil];
    // stop: takes effect after the next event.
    NSEvent *e = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil subtype:0 data1:0 data2:0];
    [NSApp postEvent:e atStart:YES];
  });
}

int platform_is_main_thread(void) { return [NSThread isMainThread] ? 1 : 0; }

void run_on_main(main_fn fn, void *ctx) {
  if ([NSThread isMainThread]) fn(ctx);
  else dispatch_sync_f(dispatch_get_main_queue(), ctx, fn);
}

typedef struct {
  void (*fn)(void *);
  void *ctx;
} start_t;
static void *thread_main(void *p) {
  // The protocol thread is the audio thread: the highest quality of service.
  pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
  start_t s = *(start_t *)p;
  free(p);
  s.fn(s.ctx);
  return NULL;
}
void start_thread(void (*fn)(void *), void *ctx) {
  start_t *s = malloc(sizeof *s);
  s->fn = fn;
  s->ctx = ctx;
  pthread_t t;
  pthread_create(&t, NULL, thread_main, s);
  pthread_detach(t);
}

const char *platform_window_api(void) { return "cocoa"; }

gui_window *window_open(const char *title, uint32_t width, uint32_t height, int resizable, void (*on_close)(void *), void *ctx) {
  gui_window *g = calloc(1, sizeof *g);
  NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | (resizable ? NSWindowStyleMaskResizable : 0);
  g->win = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, width, height) styleMask:style backing:NSBackingStoreBuffered defer:NO];
  [g->win setReleasedWhenClosed:NO];
  [g->win setTitle:[NSString stringWithUTF8String:title]];
  [g->win setLevel:NSFloatingWindowLevel];
  OBWindowDelegate *d = [OBWindowDelegate new];
  d.onClose = on_close;
  d.ctx = ctx;
  g->delegate = d;
  [g->win setDelegate:d];
  [g->win center];
  [g->win makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  return g;
}

void *window_handle(gui_window *g) { return (__bridge void *)[g->win contentView]; }

void window_resize(gui_window *g, uint32_t width, uint32_t height) { [g->win setContentSize:NSMakeSize(width, height)]; }

static void fit_now(gui_window *g) {
  if (!g || !g->win) return;
  NSArray *subs = [[g->win contentView] subviews];
  if (![subs count]) return;
  NSView *view = subs[0];
  NSSize s = [view frame].size;
  if (s.width < 50 || s.height < 50) return;
  [g->win setContentSize:s];
  // Cocoa's origin is bottom-left: after the window shrinks the view must move back into it.
  [view setFrameOrigin:NSZeroPoint];
}

void window_fit(gui_window *g) {
  fit_now(g);
  NSWindow *win = g->win;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 400 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    if (g->win == win) fit_now(g);
  });
}

void window_close(gui_window *g) {
  [g->win setDelegate:nil];
  [g->win orderOut:nil];
  [g->win close];
  g->delegate = nil;
  g->win = nil;
  free(g);
}
