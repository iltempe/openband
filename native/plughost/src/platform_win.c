// Windows: the main thread runs a Win32 message loop; plugin windows are top-most frames around the
// plugin's child window. Main-thread work arrives as thread messages.
#include <windows.h>
#include <process.h>
#include <stdlib.h>
#include "platform.h"

#define WM_OB_RUN (WM_APP + 1)
static DWORD main_tid;

struct gui_window {
  HWND hwnd;
  void (*on_close)(void *);
  void *ctx;
};

void platform_init(void) {
  main_tid = GetCurrentThreadId();
  MSG m;
  PeekMessageW(&m, NULL, WM_USER, WM_USER, PM_NOREMOVE); // create the thread's message queue
}

typedef struct {
  main_fn fn;
  void *ctx;
  HANDLE done;
} job_t;

void platform_run(void) {
  MSG m;
  while (GetMessageW(&m, NULL, 0, 0) > 0) {
    if (m.hwnd == NULL && m.message == WM_OB_RUN) {
      job_t *j = (job_t *)m.lParam;
      j->fn(j->ctx);
      SetEvent(j->done);
      continue;
    }
    TranslateMessage(&m);
    DispatchMessageW(&m);
  }
}

void platform_quit(void) { PostThreadMessageW(main_tid, WM_QUIT, 0, 0); }

int platform_is_main_thread(void) { return GetCurrentThreadId() == main_tid; }

void run_on_main(main_fn fn, void *ctx) {
  if (platform_is_main_thread()) {
    fn(ctx);
    return;
  }
  job_t j = {fn, ctx, CreateEventW(NULL, FALSE, FALSE, NULL)};
  if (PostThreadMessageW(main_tid, WM_OB_RUN, 0, (LPARAM)&j)) WaitForSingleObject(j.done, INFINITE);
  CloseHandle(j.done);
}

typedef struct {
  void (*fn)(void *);
  void *ctx;
} start_t;
static unsigned __stdcall thread_main(void *p) {
  start_t s = *(start_t *)p;
  free(p);
  s.fn(s.ctx);
  return 0;
}
void start_thread(void (*fn)(void *), void *ctx) {
  start_t *s = (start_t *)malloc(sizeof *s);
  s->fn = fn;
  s->ctx = ctx;
  HANDLE h = (HANDLE)_beginthreadex(NULL, 0, thread_main, s, 0, NULL);
  if (h) CloseHandle(h);
}

const char *platform_window_api(void) { return "win32"; }

static LRESULT CALLBACK wnd_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  gui_window *g = (gui_window *)GetWindowLongPtrW(h, GWLP_USERDATA);
  if (msg == WM_CLOSE) {
    if (g && g->on_close) g->on_close(g->ctx);
    return 0; // the host destroys it, after the plugin has let go
  }
  return DefWindowProcW(h, msg, wp, lp);
}

static DWORD style_for(int resizable) { return resizable ? WS_OVERLAPPEDWINDOW : (WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX); }

gui_window *window_open(const char *title, uint32_t width, uint32_t height, int resizable, void (*on_close)(void *), void *ctx) {
  static int registered = 0;
  if (!registered) {
    WNDCLASSW wc = {0};
    wc.lpfnWndProc = wnd_proc;
    wc.hInstance = GetModuleHandleW(NULL);
    wc.lpszClassName = L"OpenBandPluginWindow";
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    RegisterClassW(&wc);
    registered = 1;
  }
  gui_window *g = (gui_window *)calloc(1, sizeof *g);
  g->on_close = on_close;
  g->ctx = ctx;
  RECT r = {0, 0, (LONG)width, (LONG)height};
  AdjustWindowRect(&r, style_for(resizable), FALSE);
  wchar_t wt[512];
  MultiByteToWideChar(CP_UTF8, 0, title, -1, wt, 512);
  g->hwnd = CreateWindowExW(WS_EX_TOPMOST, L"OpenBandPluginWindow", wt, style_for(resizable), CW_USEDEFAULT, CW_USEDEFAULT, r.right - r.left, r.bottom - r.top, NULL, NULL, GetModuleHandleW(NULL), NULL);
  SetWindowLongPtrW(g->hwnd, GWLP_USERDATA, (LONG_PTR)g);
  ShowWindow(g->hwnd, SW_SHOW);
  SetForegroundWindow(g->hwnd);
  return g;
}

void *window_handle(gui_window *g) { return (void *)g->hwnd; }

void window_resize(gui_window *g, uint32_t width, uint32_t height) {
  RECT r = {0, 0, (LONG)width, (LONG)height};
  AdjustWindowRect(&r, (DWORD)GetWindowLongW(g->hwnd, GWL_STYLE), FALSE);
  SetWindowPos(g->hwnd, NULL, 0, 0, r.right - r.left, r.bottom - r.top, SWP_NOMOVE | SWP_NOZORDER);
}

void window_fit(gui_window *g) {
  HWND child = GetWindow(g->hwnd, GW_CHILD);
  RECT r;
  if (!child || !GetWindowRect(child, &r)) return;
  if (r.right - r.left >= 50 && r.bottom - r.top >= 50) window_resize(g, (uint32_t)(r.right - r.left), (uint32_t)(r.bottom - r.top));
}

void window_close(gui_window *g) {
  SetWindowLongPtrW(g->hwnd, GWLP_USERDATA, 0);
  DestroyWindow(g->hwnd);
  free(g);
}
