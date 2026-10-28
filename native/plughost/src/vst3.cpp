// VST3 in openband-plughost (G8.5): a VST3 plugin wrapped as a CLAP plugin object, so the rest of the host
// (threads, blocks, events, windows, state, offline mode) is the same for both formats. Notes become VST3
// events and parameter changes IParameterChanges, each at its sample offset; edits in the plugin's own
// window (IComponentHandler) come back as CLAP output events (gestures, values) and "state changed".
// Parameters are presented normalized (0..1), or as steps (0..stepCount) for stepped ones.
// Built on the VST 3 SDK 3.8 (MIT): its interfaces and hosting helpers, in third_party/vst3.
#include <clap/clap.h>

#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/utility/memoryibstream.h"
#include "public.sdk/source/vst/utility/stringconvert.h"

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace {

HostApplication *hostApp() {
  static HostApplication *app = new HostApplication();
  return app;
}

std::string json(const std::string &s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') o += '\\', o += (char)c;
    else if (c < 0x20) {
      char b[8];
      snprintf(b, sizeof b, "\\u%04x", c);
      o += b;
    } else
      o += (char)c;
  }
  return o + "\"";
}

struct V3;

/** What the plugin's controller tells the host: edits, restarts, dirty state. */
class Handler : public U::Implements<U::Directly<IComponentHandler, IComponentHandler2>> {
public:
  explicit Handler(V3 *p) : p(p) {}
  tresult PLUGIN_API beginEdit(ParamID id) override;
  tresult PLUGIN_API performEdit(ParamID id, ParamValue v) override;
  tresult PLUGIN_API endEdit(ParamID id) override;
  tresult PLUGIN_API restartComponent(int32 flags) override;
  tresult PLUGIN_API setDirty(TBool state) override;
  tresult PLUGIN_API requestOpenEditor(FIDString) override { return kResultFalse; }
  tresult PLUGIN_API startGroupEdit() override { return kResultOk; }
  tresult PLUGIN_API finishGroupEdit() override { return kResultOk; }
  V3 *p;
};

/** The window the plugin's view lives in: it may ask to be resized. */
class Frame : public U::Implements<U::Directly<IPlugFrame>> {
public:
  explicit Frame(V3 *p) : p(p) {}
  tresult PLUGIN_API resizeView(IPlugView *view, ViewRect *r) override;
  V3 *p;
};

struct OutEvent {
  uint16_t type;
  uint32_t id;
  double value;
};

struct V3 {
  clap_plugin_t clap{};
  clap_plugin_descriptor_t desc{};
  std::string id, name, vendor, version;
  const char *features[3] = {nullptr, nullptr, nullptr};
  const clap_host_t *host = nullptr;
  VST3::Hosting::Module::Ptr module;
  IPtr<IComponent> component;
  IPtr<IAudioProcessor> processor;
  IPtr<IEditController> controller;
  IPtr<IPlugView> view;
  IPtr<Handler> handler;
  IPtr<Frame> frame;
  bool separate = false;
  bool editor = false; // does it have a window of its own (createView answers)
  double sr = 48000;
  int32 maxBlock = 128;
  bool offline = false, active = false;
  int32 inCh = 0, outCh = 2;
  bool events = false;
  std::vector<ParameterInfo> params;
  ParameterChanges changes{1024};
  EventList list{1024};
  // What the plugin plays (a MIDI effect, an orchestrator: issue #9), back to the host as CLAP notes.
  EventList outList{1024};
  bool eventsOut = false;
  std::mutex mu;
  std::vector<std::pair<ParamID, ParamValue>> fromWindow;  // edits in the plugin's window → the processor
  std::vector<OutEvent> out;                               // → CLAP output events
  std::vector<std::pair<ParamID, ParamValue>> toWindow;    // automation → the controller (main thread)

  const ParameterInfo *info(ParamID pid) const {
    for (auto &p : params)
      if (p.id == pid) return &p;
    return nullptr;
  }
  double toClap(ParamID pid, ParamValue norm) const {
    auto *i = info(pid);
    return i && i->stepCount > 0 ? norm * i->stepCount : norm;
  }
  ParamValue toVst(ParamID pid, double v) const {
    auto *i = info(pid);
    return i && i->stepCount > 0 ? v / i->stepCount : v;
  }
};

tresult Handler::beginEdit(ParamID id) {
  std::lock_guard<std::mutex> l(p->mu);
  p->out.push_back({CLAP_EVENT_PARAM_GESTURE_BEGIN, id, 0});
  return kResultOk;
}
tresult Handler::performEdit(ParamID id, ParamValue v) {
  std::lock_guard<std::mutex> l(p->mu);
  p->fromWindow.emplace_back(id, v);
  p->out.push_back({CLAP_EVENT_PARAM_VALUE, id, p->toClap(id, v)});
  return kResultOk;
}
tresult Handler::endEdit(ParamID id) {
  std::lock_guard<std::mutex> l(p->mu);
  p->out.push_back({CLAP_EVENT_PARAM_GESTURE_END, id, 0});
  return kResultOk;
}
tresult Handler::restartComponent(int32 flags) {
  if (flags & kLatencyChanged) {
    auto *lat = (const clap_host_latency_t *)p->host->get_extension(p->host, CLAP_EXT_LATENCY);
    if (lat) lat->changed(p->host);
  }
  return kResultOk;
}
tresult Handler::setDirty(TBool state) {
  if (state) {
    auto *st = (const clap_host_state_t *)p->host->get_extension(p->host, CLAP_EXT_STATE);
    if (st) st->mark_dirty(p->host);
  }
  return kResultOk;
}
tresult Frame::resizeView(IPlugView *v, ViewRect *r) {
  auto *gui = (const clap_host_gui_t *)p->host->get_extension(p->host, CLAP_EXT_GUI);
  if (gui) gui->request_resize(p->host, (uint32_t)r->getWidth(), (uint32_t)r->getHeight());
  if (v) v->onSize(r);
  return kResultOk;
}

V3 *self(const clap_plugin_t *p) { return (V3 *)p->plugin_data; }

void setup(V3 *v) {
  ProcessSetup ps{};
  ps.processMode = v->offline ? kOffline : kRealtime;
  ps.symbolicSampleSize = kSample32;
  ps.maxSamplesPerBlock = v->maxBlock;
  ps.sampleRate = v->sr;
  v->processor->setupProcessing(ps);
}

// ---- the plugin, as CLAP sees it
bool p_init(const clap_plugin_t *) { return true; }

void p_destroy(const clap_plugin_t *p) {
  V3 *v = self(p);
  if (v->view) v->view->removed();
  v->view = nullptr;
  if (v->active) v->component->setActive(false);
  if (v->controller) v->controller->setComponentHandler(nullptr);
  if (v->separate) {
    FUnknownPtr<IConnectionPoint> a(v->component), b(v->controller);
    if (a && b) {
      a->disconnect(b);
      b->disconnect(a);
    }
    v->controller->terminate();
  }
  v->component->terminate();
  v->controller = nullptr;
  v->processor = nullptr;
  v->component = nullptr;
  v->module = nullptr;
  delete v;
}

bool p_activate(const clap_plugin_t *p, double sr, uint32_t, uint32_t max) {
  V3 *v = self(p);
  v->sr = sr;
  v->maxBlock = (int32)max;
  SpeakerArrangement in = SpeakerArr::kStereo, out = SpeakerArr::kStereo;
  v->processor->setBusArrangements(&in, v->inCh ? 1 : 0, &out, 1);
  setup(v);
  if (v->inCh) v->component->activateBus(kAudio, kInput, 0, true);
  v->component->activateBus(kAudio, kOutput, 0, true);
  if (v->events) v->component->activateBus(kEvent, kInput, 0, true);
  if (v->eventsOut) v->component->activateBus(kEvent, kOutput, 0, true);
  v->active = v->component->setActive(true) == kResultOk;
  return v->active;
}
void p_deactivate(const clap_plugin_t *p) {
  V3 *v = self(p);
  if (v->active) v->component->setActive(false);
  v->active = false;
}
bool p_start(const clap_plugin_t *p) {
  self(p)->processor->setProcessing(true);
  return true;
}
void p_stop(const clap_plugin_t *p) { self(p)->processor->setProcessing(false); }
void p_reset(const clap_plugin_t *) {}

clap_process_status p_process(const clap_plugin_t *p, const clap_process_t *pr) {
  V3 *v = self(p);
  v->list.clear();
  v->changes.clearQueue();
  int32 index = 0;
  {
    std::lock_guard<std::mutex> l(v->mu);
    for (auto &e : v->fromWindow) {
      auto *q = v->changes.addParameterData(e.first, index);
      if (q) q->addPoint(0, e.second, index);
    }
    v->fromWindow.clear();
  }
  bool toWindow = false;
  for (uint32_t i = 0; i < pr->in_events->size(pr->in_events); i++) {
    auto *h = pr->in_events->get(pr->in_events, i);
    if (h->space_id != CLAP_CORE_EVENT_SPACE_ID) continue;
    if (h->type == CLAP_EVENT_NOTE_ON || h->type == CLAP_EVENT_NOTE_OFF) {
      auto *n = (const clap_event_note_t *)h;
      Event e{};
      e.busIndex = 0;
      e.sampleOffset = (int32)h->time;
      e.flags = Event::kIsLive;
      if (h->type == CLAP_EVENT_NOTE_ON) {
        e.type = Event::kNoteOnEvent;
        e.noteOn.channel = 0;
        e.noteOn.pitch = n->key;
        e.noteOn.velocity = (float)n->velocity;
        e.noteOn.noteId = -1;
      } else {
        e.type = Event::kNoteOffEvent;
        e.noteOff.channel = 0;
        e.noteOff.pitch = n->key;
        e.noteOff.velocity = (float)n->velocity;
        e.noteOff.noteId = -1;
      }
      v->list.addEvent(e);
    } else if (h->type == CLAP_EVENT_PARAM_VALUE) {
      auto *pv = (const clap_event_param_value_t *)h;
      ParamValue norm = v->toVst(pv->param_id, pv->value);
      auto *q = v->changes.addParameterData(pv->param_id, index);
      int32 point = 0;
      if (q) q->addPoint((int32)h->time, norm, point);
      std::lock_guard<std::mutex> l(v->mu);
      v->toWindow.emplace_back(pv->param_id, norm);
      toWindow = true;
    }
  }
  // The controller (and the plugin's window) follow automation on the main thread.
  if (toWindow) v->host->request_callback(v->host);

  AudioBusBuffers in{}, out{};
  in.numChannels = v->inCh;
  in.channelBuffers32 = pr->audio_inputs_count ? pr->audio_inputs[0].data32 : nullptr;
  out.numChannels = v->outCh;
  out.channelBuffers32 = pr->audio_outputs[0].data32;
  ProcessContext ctx{};
  ctx.sampleRate = v->sr;
  ctx.tempo = 120;
  ctx.state = ProcessContext::kPlaying | ProcessContext::kTempoValid;
  ProcessData d{};
  d.processMode = v->offline ? kOffline : kRealtime;
  d.symbolicSampleSize = kSample32;
  d.numSamples = (int32)pr->frames_count;
  d.numInputs = v->inCh && in.channelBuffers32 ? 1 : 0;
  d.numOutputs = 1;
  d.inputs = d.numInputs ? &in : nullptr;
  d.outputs = &out;
  d.inputParameterChanges = &v->changes;
  d.inputEvents = &v->list;
  v->outList.clear();
  d.outputEvents = v->eventsOut ? &v->outList : nullptr;
  d.processContext = &ctx;
  v->processor->process(d);
  for (int32 i = 0, n = v->eventsOut ? v->outList.getEventCount() : 0; i < n; i++) {
    Event e{};
    if (v->outList.getEvent(i, e) != kResultOk) continue;
    if (e.type != Event::kNoteOnEvent && e.type != Event::kNoteOffEvent) continue;
    const bool on = e.type == Event::kNoteOnEvent;
    clap_event_note_t ev{};
    ev.header = {sizeof ev, (uint32_t)(e.sampleOffset < 0 ? 0 : e.sampleOffset), CLAP_CORE_EVENT_SPACE_ID, (uint16_t)(on ? CLAP_EVENT_NOTE_ON : CLAP_EVENT_NOTE_OFF), 0};
    ev.note_id = -1;
    ev.port_index = 0;
    ev.channel = on ? e.noteOn.channel : e.noteOff.channel;
    ev.key = on ? e.noteOn.pitch : e.noteOff.pitch;
    ev.velocity = on ? e.noteOn.velocity : e.noteOff.velocity;
    pr->out_events->try_push(pr->out_events, &ev.header);
  }

  std::lock_guard<std::mutex> l(v->mu);
  for (auto &e : v->out) {
    if (e.type == CLAP_EVENT_PARAM_VALUE) {
      clap_event_param_value_t ev{};
      ev.header = {sizeof ev, 0, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_PARAM_VALUE, 0};
      ev.param_id = e.id;
      ev.note_id = -1;
      ev.port_index = ev.channel = ev.key = -1;
      ev.value = e.value;
      pr->out_events->try_push(pr->out_events, &ev.header);
    } else {
      clap_event_param_gesture_t ev{};
      ev.header = {sizeof ev, 0, CLAP_CORE_EVENT_SPACE_ID, e.type, 0};
      ev.param_id = e.id;
      pr->out_events->try_push(pr->out_events, &ev.header);
    }
  }
  v->out.clear();
  return CLAP_PROCESS_CONTINUE;
}

void p_main(const clap_plugin_t *p) {
  V3 *v = self(p);
  std::vector<std::pair<ParamID, ParamValue>> todo;
  {
    std::lock_guard<std::mutex> l(v->mu);
    todo.swap(v->toWindow);
  }
  for (auto &e : todo) v->controller->setParamNormalized(e.first, e.second);
}

// ---- extensions
uint32_t ports_count(const clap_plugin_t *p, bool in) { return in ? (self(p)->inCh ? 1 : 0) : 1; }
bool ports_get(const clap_plugin_t *p, uint32_t i, bool in, clap_audio_port_info_t *info) {
  if (i) return false;
  memset(info, 0, sizeof *info);
  snprintf(info->name, sizeof info->name, "%s", in ? "In" : "Out");
  info->channel_count = (uint32_t)(in ? self(p)->inCh : self(p)->outCh);
  info->flags = CLAP_AUDIO_PORT_IS_MAIN;
  info->port_type = info->channel_count == 2 ? CLAP_PORT_STEREO : nullptr;
  info->in_place_pair = CLAP_INVALID_ID;
  return true;
}
const clap_plugin_audio_ports_t PORTS = {ports_count, ports_get};

uint32_t notes_count(const clap_plugin_t *p, bool in) { return in && self(p)->events ? 1 : 0; }
bool notes_get(const clap_plugin_t *p, uint32_t i, bool in, clap_note_port_info_t *info) {
  if (i || !in || !self(p)->events) return false;
  memset(info, 0, sizeof *info);
  info->supported_dialects = CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI;
  info->preferred_dialect = CLAP_NOTE_DIALECT_CLAP;
  snprintf(info->name, sizeof info->name, "Notes");
  return true;
}
const clap_plugin_note_ports_t NOTES = {notes_count, notes_get};

uint32_t params_count(const clap_plugin_t *p) { return (uint32_t)self(p)->params.size(); }
bool params_info(const clap_plugin_t *p, uint32_t i, clap_param_info_t *out) {
  V3 *v = self(p);
  if (i >= v->params.size()) return false;
  auto &pi = v->params[i];
  memset(out, 0, sizeof *out);
  out->id = pi.id;
  std::string title = VST3::StringConvert::convert(pi.title);
  snprintf(out->name, sizeof out->name, "%s", title.c_str());
  out->min_value = 0;
  out->max_value = pi.stepCount > 0 ? pi.stepCount : 1;
  out->default_value = v->toClap(pi.id, pi.defaultNormalizedValue);
  if (pi.flags & ParameterInfo::kCanAutomate) out->flags |= CLAP_PARAM_IS_AUTOMATABLE;
  if (pi.stepCount > 0) out->flags |= CLAP_PARAM_IS_STEPPED;
  if (pi.flags & (ParameterInfo::kIsHidden | ParameterInfo::kIsReadOnly)) out->flags |= CLAP_PARAM_IS_HIDDEN;
  return true;
}
bool params_value(const clap_plugin_t *p, clap_id id, double *value) {
  V3 *v = self(p);
  *value = v->toClap(id, v->controller->getParamNormalized(id));
  return true;
}
bool params_to_text(const clap_plugin_t *p, clap_id id, double value, char *out, uint32_t cap) {
  V3 *v = self(p);
  String128 s{};
  if (v->controller->getParamStringByValue(id, v->toVst(id, value), s) != kResultOk) return false;
  snprintf(out, cap, "%s", VST3::StringConvert::convert(s).c_str());
  return true;
}
bool params_from_text(const clap_plugin_t *, clap_id, const char *, double *) { return false; }
void params_flush(const clap_plugin_t *p, const clap_input_events_t *in, const clap_output_events_t *) {
  V3 *v = self(p);
  for (uint32_t i = 0; i < in->size(in); i++) {
    auto *h = in->get(in, i);
    if (h->space_id != CLAP_CORE_EVENT_SPACE_ID || h->type != CLAP_EVENT_PARAM_VALUE) continue;
    auto *pv = (const clap_event_param_value_t *)h;
    v->controller->setParamNormalized(pv->param_id, v->toVst(pv->param_id, pv->value));
  }
}
const clap_plugin_params_t PARAMS = {params_count, params_info, params_value, params_to_text, params_from_text, params_flush};

uint32_t latency_get(const clap_plugin_t *p) { return self(p)->processor->getLatencySamples(); }
const clap_plugin_latency_t LATENCY = {latency_get};

// State: the component's and the controller's, as [u32 component size][component][controller].
bool state_save(const clap_plugin_t *p, const clap_ostream_t *s) {
  V3 *v = self(p);
  ResizableMemoryIBStream a, b;
  if (v->component->getState(&a) != kResultOk) return false;
  if (v->separate) v->controller->getState(&b);
  int64 an = 0, bn = 0;
  a.tell(&an);
  b.tell(&bn);
  uint32_t n = (uint32_t)an;
  if (s->write(s, &n, 4) != 4) return false;
  if (an && s->write(s, a.getData(), (uint64_t)an) != an) return false;
  if (bn && s->write(s, b.getData(), (uint64_t)bn) != bn) return false;
  return true;
}
bool state_load(const clap_plugin_t *p, const clap_istream_t *s) {
  V3 *v = self(p);
  std::vector<uint8_t> all;
  uint8_t buf[65536];
  for (;;) {
    int64_t r = s->read(s, buf, sizeof buf);
    if (r <= 0) break;
    all.insert(all.end(), buf, buf + r);
  }
  if (all.size() < 4) return false;
  uint32_t n;
  memcpy(&n, all.data(), 4);
  if (4 + (size_t)n > all.size()) return false;
  ResizableMemoryIBStream a, b;
  int32 written = 0;
  a.write(all.data() + 4, (int32)n, &written);
  a.rewind();
  if (v->component->setState(&a) != kResultOk) return false;
  a.rewind();
  v->controller->setComponentState(&a);
  if (v->separate && all.size() > 4 + n) {
    b.write(all.data() + 4 + n, (int32)(all.size() - 4 - n), &written);
    b.rewind();
    v->controller->setState(&b);
  }
  return true;
}
const clap_plugin_state_t STATE = {state_save, state_load};

const char *platformType(const char *api) {
  if (!strcmp(api, CLAP_WINDOW_API_COCOA)) return kPlatformTypeNSView;
  if (!strcmp(api, CLAP_WINDOW_API_WIN32)) return kPlatformTypeHWND;
  if (!strcmp(api, CLAP_WINDOW_API_X11)) return kPlatformTypeX11EmbedWindowID;
  return nullptr;
}
bool gui_supported(const clap_plugin_t *p, const char *api, bool floating) { return self(p)->editor && !floating && platformType(api); }
bool gui_preferred(const clap_plugin_t *, const char **, bool *) { return false; }
bool gui_create(const clap_plugin_t *p, const char *api, bool floating) {
  V3 *v = self(p);
  if (floating || !platformType(api)) return false;
  v->view = owned(v->controller->createView(ViewType::kEditor));
  if (!v->view || v->view->isPlatformTypeSupported(platformType(api)) != kResultTrue) {
    v->view = nullptr;
    return false;
  }
  v->view->setFrame(v->frame);
  return true;
}
void gui_destroy(const clap_plugin_t *p) {
  V3 *v = self(p);
  if (v->view) {
    v->view->setFrame(nullptr);
    v->view->removed();
  }
  v->view = nullptr;
}
bool gui_scale(const clap_plugin_t *, double) { return false; }
bool gui_size(const clap_plugin_t *p, uint32_t *w, uint32_t *h) {
  V3 *v = self(p);
  ViewRect r;
  if (!v->view || v->view->getSize(&r) != kResultOk) return false;
  *w = (uint32_t)r.getWidth();
  *h = (uint32_t)r.getHeight();
  return true;
}
bool gui_can_resize(const clap_plugin_t *p) { return self(p)->view && self(p)->view->canResize() == kResultTrue; }
bool gui_hints(const clap_plugin_t *, clap_gui_resize_hints_t *) { return false; }
bool gui_adjust(const clap_plugin_t *, uint32_t *, uint32_t *) { return true; }
bool gui_set_size(const clap_plugin_t *p, uint32_t w, uint32_t h) {
  V3 *v = self(p);
  ViewRect r(0, 0, (int32)w, (int32)h);
  return v->view && v->view->onSize(&r) == kResultOk;
}
bool gui_set_parent(const clap_plugin_t *p, const clap_window_t *win) {
  V3 *v = self(p);
  return v->view && v->view->attached(win->ptr, platformType(win->api)) == kResultOk;
}
bool gui_transient(const clap_plugin_t *, const clap_window_t *) { return false; }
void gui_title(const clap_plugin_t *, const char *) {}
bool gui_show(const clap_plugin_t *) { return true; }
bool gui_hide(const clap_plugin_t *) { return true; }
const clap_plugin_gui_t GUI = {gui_supported, gui_preferred, gui_create, gui_destroy, gui_scale, gui_size, gui_can_resize, gui_hints, gui_adjust, gui_set_size, gui_set_parent, gui_transient, gui_title, gui_show, gui_hide};

bool render_hard(const clap_plugin_t *) { return false; }
bool render_set(const clap_plugin_t *p, clap_plugin_render_mode mode) {
  V3 *v = self(p);
  v->offline = mode == CLAP_RENDER_OFFLINE;
  if (v->active) {
    v->component->setActive(false);
    setup(v);
    v->component->setActive(true);
  }
  return true;
}
const clap_plugin_render_t RENDER = {render_hard, render_set};

const void *p_ext(const clap_plugin_t *, const char *id) {
  if (!strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &PORTS;
  if (!strcmp(id, CLAP_EXT_NOTE_PORTS)) return &NOTES;
  if (!strcmp(id, CLAP_EXT_PARAMS)) return &PARAMS;
  if (!strcmp(id, CLAP_EXT_LATENCY)) return &LATENCY;
  if (!strcmp(id, CLAP_EXT_STATE)) return &STATE;
  if (!strcmp(id, CLAP_EXT_GUI)) return &GUI;
  if (!strcmp(id, CLAP_EXT_RENDER)) return &RENDER;
  return nullptr;
}

int32 channels(IComponent *c, BusDirection dir) {
  if (c->getBusCount(kAudio, dir) < 1) return 0;
  BusInfo bi{};
  if (c->getBusInfo(kAudio, dir, 0, bi) != kResultOk) return dir == kOutput ? 2 : 0;
  return bi.channelCount > 2 ? 2 : bi.channelCount;
}

}  // namespace

/** The VST3 audio processors in a bundle, as JSON objects separated by commas; -1 and a message on error. */
extern "C" int ob_vst3_scan(const char *path, char *out, size_t cap) {
  std::string err;
  auto module = VST3::Hosting::Module::create(path, err);
  if (!module) {
    snprintf(out, cap, "%s", err.empty() ? "not a VST3 bundle" : err.c_str());
    return -1;
  }
  std::string list;
  int n = 0;
  for (auto &ci : module->getFactory().classInfos()) {
    if (ci.category() != kVstAudioEffectClass) continue;
    bool instrument = ci.subCategoriesString().find("Instrument") != std::string::npos;
    std::string features = instrument ? "\"instrument\"" : "\"audio-effect\"";
    for (auto &sc : ci.subCategories()) {
      std::string low;
      for (char c : sc) low += (char)tolower((unsigned char)c);
      if (low != "instrument" && low != "fx") features += "," + json(low);
    }
    if (n++) list += ",";
    list += "{\"format\":\"vst3\",\"id\":" + json(ci.ID().toString()) + ",\"name\":" + json(ci.name()) + ",\"vendor\":" + json(ci.vendor()) + ",\"version\":" + json(ci.version()) + ",\"description\":" + json(ci.subCategoriesString()) + ",\"features\":[" + features + "]}";
  }
  snprintf(out, cap, "%s", list.c_str());
  return n;
}

/** A VST3 plugin of a bundle, by class id, as a CLAP plugin (main thread). */
extern "C" const clap_plugin_t *ob_vst3_create(const char *path, const char *uid, const clap_host_t *host, char *err, size_t cap) {
  std::string e;
  auto module = VST3::Hosting::Module::create(path, e);
  if (!module) {
    snprintf(err, cap, "cannot load %s: %s", path, e.c_str());
    return nullptr;
  }
  auto id = VST3::UID::fromString(std::string(uid));
  if (!id) {
    snprintf(err, cap, "%s is not a VST3 class id", uid);
    return nullptr;
  }
  auto &factory = module->getFactory();
  factory.setHostContext(hostApp());
  auto component = factory.createInstance<IComponent>(*id);
  if (!component || component->initialize(hostApp()) != kResultOk) {
    snprintf(err, cap, "cannot create %s from %s", uid, path);
    return nullptr;
  }
  V3 *v = new V3();
  v->host = host;
  v->module = module;
  v->component = component;
  v->processor = U::cast<IAudioProcessor>(component);
  if (!v->processor) {
    component->terminate();
    delete v;
    snprintf(err, cap, "%s is not an audio processor", uid);
    return nullptr;
  }
  // The controller: the same object, or a class of its own connected to the component.
  v->controller = U::cast<IEditController>(component);
  if (!v->controller) {
    TUID cid;
    if (component->getControllerClassId(cid) == kResultOk) {
      v->controller = factory.createInstance<IEditController>(VST3::UID::fromTUID(cid));
      if (v->controller && v->controller->initialize(hostApp()) == kResultOk) {
        v->separate = true;
        auto a = U::cast<IConnectionPoint>(component);
        auto b = U::cast<IConnectionPoint>(v->controller);
        if (a && b) {
          a->connect(b);
          b->connect(a);
        }
      } else
        v->controller = nullptr;
    }
  }
  if (!v->controller) {
    component->terminate();
    delete v;
    snprintf(err, cap, "%s has no edit controller", uid);
    return nullptr;
  }
  ResizableMemoryIBStream s;
  if (component->getState(&s) == kResultOk) {
    s.rewind();
    v->controller->setComponentState(&s);
  }
  v->handler = owned(new Handler(v));
  v->frame = owned(new Frame(v));
  v->controller->setComponentHandler(v->handler);
  // Created on the main thread like every view; asked once, then released.
  if (IPtr<IPlugView> probe = owned(v->controller->createView(ViewType::kEditor))) v->editor = true;
  v->inCh = channels(component, kInput);
  v->outCh = channels(component, kOutput);
  if (!v->outCh) v->outCh = 2;
  v->events = component->getBusCount(kEvent, kInput) > 0;
  v->eventsOut = component->getBusCount(kEvent, kOutput) > 0;
  for (int32 i = 0; i < v->controller->getParameterCount(); i++) {
    ParameterInfo pi{};
    if (v->controller->getParameterInfo(i, pi) == kResultOk) v->params.push_back(pi);
  }
  for (auto &ci : factory.classInfos())
    if (ci.ID() == *id) {
      v->name = ci.name();
      v->vendor = ci.vendor();
      v->version = ci.version();
    }
  v->id = uid;
  v->features[0] = v->events ? CLAP_PLUGIN_FEATURE_INSTRUMENT : CLAP_PLUGIN_FEATURE_AUDIO_EFFECT;
  v->desc = {CLAP_VERSION_INIT, v->id.c_str(), v->name.c_str(), v->vendor.c_str(), "", "", "", v->version.c_str(), "", v->features};
  v->clap = {&v->desc, v, p_init, p_destroy, p_activate, p_deactivate, p_start, p_stop, p_reset, p_process, p_ext, p_main};
  return &v->clap;
}
