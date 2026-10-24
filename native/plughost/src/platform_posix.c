// Linux and other POSIX systems: a main thread that runs handed-over work; no plugin windows yet (the
// studio shows the plugin's parameters instead).
#include <pthread.h>
#include <stdlib.h>
#include "platform.h"

static pthread_t main_thread;
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static main_fn job_fn;
static void *job_ctx;
static int job_pending, job_done, quitting;

void platform_init(void) { main_thread = pthread_self(); }

void platform_run(void) {
  pthread_mutex_lock(&mu);
  while (!quitting) {
    if (job_pending) {
      main_fn fn = job_fn;
      void *ctx = job_ctx;
      job_pending = 0;
      pthread_mutex_unlock(&mu);
      fn(ctx);
      pthread_mutex_lock(&mu);
      job_done = 1;
      pthread_cond_broadcast(&cv);
      continue;
    }
    pthread_cond_wait(&cv, &mu);
  }
  pthread_mutex_unlock(&mu);
}

void platform_quit(void) {
  pthread_mutex_lock(&mu);
  quitting = 1;
  pthread_cond_broadcast(&cv);
  pthread_mutex_unlock(&mu);
}

int platform_is_main_thread(void) { return pthread_equal(pthread_self(), main_thread); }

void run_on_main(main_fn fn, void *ctx) {
  if (platform_is_main_thread()) {
    fn(ctx);
    return;
  }
  // One job at a time: only the protocol thread hands work over.
  pthread_mutex_lock(&mu);
  job_fn = fn;
  job_ctx = ctx;
  job_pending = 1;
  job_done = 0;
  pthread_cond_broadcast(&cv);
  while (!job_done && !quitting) pthread_cond_wait(&cv, &mu);
  pthread_mutex_unlock(&mu);
}

typedef struct {
  void (*fn)(void *);
  void *ctx;
} start_t;
static void *thread_main(void *p) {
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

const char *platform_window_api(void) { return NULL; }
gui_window *window_open(const char *title, uint32_t w, uint32_t h, int r, void (*c)(void *), void *x) {
  (void)title, (void)w, (void)h, (void)r, (void)c, (void)x;
  return NULL;
}
void *window_handle(gui_window *w) {
  (void)w;
  return NULL;
}
void window_resize(gui_window *w, uint32_t a, uint32_t b) { (void)w, (void)a, (void)b; }
void window_fit(gui_window *w) { (void)w; }
void window_close(gui_window *w) { (void)w; }
