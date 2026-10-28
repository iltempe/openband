// Audio Units in openband-plughost (G8.6, macOS): an AU wrapped as a CLAP plugin object, like VST3 in
// vst3.cpp, so the rest of the host (threads, blocks, events, windows, state, offline mode) is the same.
// AUs are found in the system's component registry (never by path, never instantiated to be listed):
// the "path" of every AU is "au:", its id "type:subtype:manufacturer" (e.g. "aufx:dely:appl").
// Notes become MIDI events and automation AudioUnitScheduleParameters, each at its sample offset; moves
// in the plugin's own view (AUEventListener) come back as CLAP output events and "state changed".
// Parameters keep the AU's own range and units. State: the AU's ClassInfo as a binary property list.
#include <clap/clap.h>

#import <AudioToolbox/AudioToolbox.h>
#import <CoreMIDI/CoreMIDI.h>
#import <AudioUnit/AUCocoaUIView.h>
#import <Cocoa/Cocoa.h>
#import <CoreAudioKit/CoreAudioKit.h>

#include <array>
#include <mutex>
#include <string>
#include <vector>

namespace {

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

std::string fourcc(OSType t) {
  char s[5] = {(char)(t >> 24), (char)(t >> 16), (char)(t >> 8), (char)t, 0};
  for (char &c : s)
    if (c && (c < 0x20 || c > 0x7e)) c = '?';
  return s;
}
bool parseFourcc(const char *s, OSType *t) {
  if (strlen(s) < 4) return false;
  *t = ((OSType)(uint8_t)s[0] << 24) | ((OSType)(uint8_t)s[1] << 16) | ((OSType)(uint8_t)s[2] << 8) | (uint8_t)s[3];
  return true;
}
std::string str(CFStringRef s) {
  if (!s) return "";
  char b[512];
  return CFStringGetCString(s, b, sizeof b, kCFStringEncodingUTF8) ? b : "";
}

// MIDI processors (MIDI FX, aumi) too: orchestrators and arpeggiators that play other tracks (issue #9).
const OSType KINDS[] = {kAudioUnitType_Effect, kAudioUnitType_MusicEffect, kAudioUnitType_MusicDevice, kAudioUnitType_MIDIProcessor};

struct OutEvent {
  uint16_t type;
  uint32_t id;
  double value;
};

struct AU {
  clap_plugin_t clap{};
  clap_plugin_descriptor_t desc{};
  std::string id, name, vendor, version;
  const char *features[3] = {nullptr, nullptr, nullptr};
  const clap_host_t *host = nullptr;
  AudioComponentDescription cd{};
  AudioUnit unit = nullptr;
  bool instrument = false, offline = false, initialized = false;
  uint32_t inCh = 0, outCh = 2;
  double sr = 48000;
  uint32_t maxBlock = 128;
  Float64 sampleTime = 0;
  const float *const *input = nullptr; // the piece being rendered (the input callback reads it)
  std::vector<AudioUnitParameterID> ids;
  std::vector<AudioUnitParameterInfo> infos;
  AUEventListenerRef listener = nullptr;
  NSView *view = nil;
  std::mutex mu;
  std::vector<OutEvent> out;
  /** MIDI the AU played (its MIDI output callback, during render), as bytes: status, data1, data2. */
  std::vector<std::array<uint8_t, 3>> midiOut;
};

AU *self(const clap_plugin_t *p) { return (AU *)p->plugin_data; }

/** Channel messages the AU sends out (called during AudioUnitRender, on the audio thread). */
OSStatus midiOutput(void *ref, const AudioTimeStamp *, UInt32, const MIDIPacketList *list) {
  AU *a = (AU *)ref;
  const MIDIPacket *p = &list->packet[0];
  for (UInt32 k = 0; k < list->numPackets; k++, p = MIDIPacketNext(p))
    for (UInt16 i = 0; i < p->length;) {
      uint8_t st = p->data[i];
      if (st < 0x80 || st >= 0xF0) {
        i++;
        continue;
      }
      const int len = (st & 0xF0) == 0xC0 || (st & 0xF0) == 0xD0 ? 2 : 3;
      if (i + len > p->length) break;
      a->midiOut.push_back({st, p->data[i + 1], len == 3 ? p->data[i + 2] : (uint8_t)0});
      i += len;
    }
  return noErr;
}

OSStatus inputProc(void *ref, AudioUnitRenderActionFlags *, const AudioTimeStamp *, UInt32, UInt32 frames, AudioBufferList *io) {
  AU *a = (AU *)ref;
  for (UInt32 b = 0; b < io->mNumberBuffers; b++) {
    float *dst = (float *)io->mBuffers[b].mData;
    const float *src = a->input && b < a->inCh ? a->input[b] : nullptr;
    if (!dst) continue;
    if (src) memcpy(dst, src, frames * sizeof(float));
    else memset(dst, 0, frames * sizeof(float));
  }
  return noErr;
}

/** The plugin's own view moved a parameter (main run loop): a value, a gesture; any of them, the state changed. */
void listen(void *ref, void *, const AudioUnitEvent *e, UInt64, AudioUnitParameterValue v) {
  AU *a = (AU *)ref;
  uint32_t id = e->mArgument.mParameter.mParameterID;
  if (id == kAUParameterListener_AnyParameter) return; // our own "everything changed" after a state load
  {
    std::lock_guard<std::mutex> l(a->mu);
    if (e->mEventType == kAudioUnitEvent_ParameterValueChange) a->out.push_back({CLAP_EVENT_PARAM_VALUE, id, v});
    else if (e->mEventType == kAudioUnitEvent_BeginParameterChangeGesture) a->out.push_back({CLAP_EVENT_PARAM_GESTURE_BEGIN, id, 0});
    else if (e->mEventType == kAudioUnitEvent_EndParameterChangeGesture) a->out.push_back({CLAP_EVENT_PARAM_GESTURE_END, id, 0});
  }
  if (e->mEventType != kAudioUnitEvent_BeginParameterChangeGesture) {
    auto *st = (const clap_host_state_t *)a->host->get_extension(a->host, CLAP_EXT_STATE);
    if (st) st->mark_dirty(a->host);
  }
}

AudioStreamBasicDescription floatFormat(double sr, uint32_t ch) {
  AudioStreamBasicDescription f{};
  f.mSampleRate = sr;
  f.mFormatID = kAudioFormatLinearPCM;
  f.mFormatFlags = kAudioFormatFlagsNativeFloatPacked | kAudioFormatFlagIsNonInterleaved;
  f.mBytesPerPacket = f.mBytesPerFrame = sizeof(float);
  f.mFramesPerPacket = 1;
  f.mChannelsPerFrame = ch;
  f.mBitsPerChannel = 32;
  return f;
}

bool initialize(AU *a) {
  AudioStreamBasicDescription out = floatFormat(a->sr, a->outCh), in = floatFormat(a->sr, a->inCh ? a->inCh : 2);
  AudioUnitSetProperty(a->unit, kAudioUnitProperty_SampleRate, kAudioUnitScope_Output, 0, &a->sr, sizeof a->sr);
  if (AudioUnitSetProperty(a->unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 0, &out, sizeof out) != noErr) return false;
  if (a->inCh) {
    AudioUnitSetProperty(a->unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &in, sizeof in);
    AURenderCallbackStruct cb{inputProc, a};
    AudioUnitSetProperty(a->unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &cb, sizeof cb);
  }
  UInt32 max = a->maxBlock, off = a->offline;
  AudioUnitSetProperty(a->unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &max, sizeof max);
  AudioUnitSetProperty(a->unit, kAudioUnitProperty_OfflineRender, kAudioUnitScope_Global, 0, &off, sizeof off);
  a->initialized = AudioUnitInitialize(a->unit) == noErr;
  // Its MIDI output, when it has one (MIDI FX, instruments that play other parts).
  AUMIDIOutputCallbackStruct mo{midiOutput, a};
  AudioUnitSetProperty(a->unit, kAudioUnitProperty_MIDIOutputCallback, kAudioUnitScope_Global, 0, &mo, sizeof mo);
  return a->initialized;
}
void uninitialize(AU *a) {
  if (a->initialized) AudioUnitUninitialize(a->unit);
  a->initialized = false;
}

// ---- the plugin, as CLAP sees it
bool p_init(const clap_plugin_t *) { return true; }
void p_destroy(const clap_plugin_t *p) {
  AU *a = self(p);
  if (a->view) [a->view removeFromSuperview];
  a->view = nil;
  if (a->listener) AUListenerDispose(a->listener);
  uninitialize(a);
  AudioComponentInstanceDispose(a->unit);
  delete a;
}
bool p_activate(const clap_plugin_t *p, double sr, uint32_t, uint32_t max) {
  AU *a = self(p);
  a->sr = sr;
  a->maxBlock = max;
  uninitialize(a);
  return initialize(a);
}
void p_deactivate(const clap_plugin_t *p) { uninitialize(self(p)); }
bool p_start(const clap_plugin_t *) { return true; }
void p_stop(const clap_plugin_t *) {}
void p_reset(const clap_plugin_t *p) { AudioUnitReset(self(p)->unit, kAudioUnitScope_Global, 0); }

clap_process_status p_process(const clap_plugin_t *p, const clap_process_t *pr) {
  AU *a = self(p);
  // Many AUs apply a parameter for a whole render call: the block is rendered in pieces, cut where a
  // parameter changes, so each change lands on its sample. Notes keep their offset inside their piece.
  struct Ev {
    uint32_t time;
    const clap_event_header_t *h;
  };
  std::vector<Ev> evs;
  for (uint32_t i = 0; i < pr->in_events->size(pr->in_events); i++) {
    auto *h = pr->in_events->get(pr->in_events, i);
    if (h->space_id == CLAP_CORE_EVENT_SPACE_ID) evs.push_back({h->time < pr->frames_count ? h->time : pr->frames_count - 1, h});
  }
  uint8_t storage[sizeof(AudioBufferList) + 8 * sizeof(AudioBuffer)];
  auto *abl = (AudioBufferList *)storage;
  const float *const *in = pr->audio_inputs_count ? pr->audio_inputs[0].data32 : nullptr;
  size_t e = 0;
  uint32_t at = 0;
  while (at < pr->frames_count) {
    // The events of this piece: parameters at its start, notes anywhere until the next parameter.
    uint32_t to = pr->frames_count;
    for (; e < evs.size(); e++) {
      auto *h = evs[e].h;
      if (h->type == CLAP_EVENT_PARAM_VALUE) {
        if (evs[e].time > at) {
          to = evs[e].time;
          break;
        }
        auto *pv = (const clap_event_param_value_t *)h;
        AudioUnitSetParameter(a->unit, pv->param_id, kAudioUnitScope_Global, 0, (AudioUnitParameterValue)pv->value, 0);
      } else if (h->type == CLAP_EVENT_NOTE_ON || h->type == CLAP_EVENT_NOTE_OFF) {
        auto *n = (const clap_event_note_t *)h;
        UInt32 vel = (UInt32)(n->velocity * 127 + 0.5);
        UInt32 off = evs[e].time - at;
        if (h->type == CLAP_EVENT_NOTE_ON) MusicDeviceMIDIEvent(a->unit, 0x90, (UInt32)n->key, vel ? vel : 1, off);
        else MusicDeviceMIDIEvent(a->unit, 0x80, (UInt32)n->key, vel, off);
      }
    }
    uint32_t frames = to - at;
    float *ins[8];
    for (uint32_t c = 0; c < a->inCh && c < 8; c++) ins[c] = in ? (float *)in[c] + at : nullptr;
    a->input = in ? ins : nullptr;
    abl->mNumberBuffers = a->outCh;
    for (uint32_t c = 0; c < a->outCh; c++) {
      abl->mBuffers[c].mNumberChannels = 1;
      abl->mBuffers[c].mDataByteSize = frames * sizeof(float);
      abl->mBuffers[c].mData = pr->audio_outputs[0].data32[c] + at;
    }
    AudioTimeStamp ts{};
    ts.mSampleTime = a->sampleTime;
    ts.mFlags = kAudioTimeStampSampleTimeValid;
    AudioUnitRenderActionFlags flags = 0;
    if (AudioUnitRender(a->unit, &flags, &ts, 0, frames, abl) != noErr)
      for (uint32_t c = 0; c < a->outCh; c++) memset(pr->audio_outputs[0].data32[c] + at, 0, frames * sizeof(float));
    // Some AUs render into their own buffers: copy back if they did.
    for (uint32_t c = 0; c < a->outCh; c++)
      if (abl->mBuffers[c].mData != pr->audio_outputs[0].data32[c] + at) memcpy(pr->audio_outputs[0].data32[c] + at, abl->mBuffers[c].mData, frames * sizeof(float));
    a->sampleTime += frames;
    at = to;
  }
  a->input = nullptr;
  for (auto &m : a->midiOut) {
    clap_event_midi_t ev{};
    ev.header = {sizeof ev, 0, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_MIDI, 0};
    ev.port_index = 0;
    ev.data[0] = m[0];
    ev.data[1] = m[1];
    ev.data[2] = m[2];
    pr->out_events->try_push(pr->out_events, &ev.header);
  }
  a->midiOut.clear();

  std::lock_guard<std::mutex> l(a->mu);
  for (auto &e : a->out) {
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
  a->out.clear();
  return CLAP_PROCESS_CONTINUE;
}
void p_main(const clap_plugin_t *) {}

// ---- extensions
uint32_t ports_count(const clap_plugin_t *p, bool in) { return in ? (self(p)->inCh ? 1 : 0) : 1; }
bool ports_get(const clap_plugin_t *p, uint32_t i, bool in, clap_audio_port_info_t *info) {
  if (i) return false;
  memset(info, 0, sizeof *info);
  snprintf(info->name, sizeof info->name, "%s", in ? "In" : "Out");
  info->channel_count = in ? self(p)->inCh : self(p)->outCh;
  info->flags = CLAP_AUDIO_PORT_IS_MAIN;
  info->port_type = info->channel_count == 2 ? CLAP_PORT_STEREO : nullptr;
  info->in_place_pair = CLAP_INVALID_ID;
  return true;
}
const clap_plugin_audio_ports_t PORTS = {ports_count, ports_get};

uint32_t notes_count(const clap_plugin_t *p, bool in) { return in && self(p)->instrument ? 1 : 0; }
bool notes_get(const clap_plugin_t *p, uint32_t i, bool in, clap_note_port_info_t *info) {
  if (i || !in || !self(p)->instrument) return false;
  memset(info, 0, sizeof *info);
  info->supported_dialects = CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI;
  info->preferred_dialect = CLAP_NOTE_DIALECT_CLAP;
  snprintf(info->name, sizeof info->name, "Notes");
  return true;
}
const clap_plugin_note_ports_t NOTES = {notes_count, notes_get};

uint32_t params_count(const clap_plugin_t *p) { return (uint32_t)self(p)->ids.size(); }
bool params_info(const clap_plugin_t *p, uint32_t i, clap_param_info_t *out) {
  AU *a = self(p);
  if (i >= a->ids.size()) return false;
  auto &pi = a->infos[i];
  memset(out, 0, sizeof *out);
  out->id = a->ids[i];
  std::string name = pi.cfNameString ? str(pi.cfNameString) : pi.name;
  snprintf(out->name, sizeof out->name, "%s", name.c_str());
  out->min_value = pi.minValue;
  out->max_value = pi.maxValue;
  out->default_value = pi.defaultValue;
  if (pi.flags & kAudioUnitParameterFlag_IsWritable) out->flags |= CLAP_PARAM_IS_AUTOMATABLE;
  if (pi.unit == kAudioUnitParameterUnit_Indexed || pi.unit == kAudioUnitParameterUnit_Boolean) out->flags |= CLAP_PARAM_IS_STEPPED;
  if (!(pi.flags & kAudioUnitParameterFlag_IsWritable)) out->flags |= CLAP_PARAM_IS_HIDDEN;
  return true;
}
bool params_value(const clap_plugin_t *p, clap_id id, double *value) {
  AudioUnitParameterValue v = 0;
  if (AudioUnitGetParameter(self(p)->unit, id, kAudioUnitScope_Global, 0, &v) != noErr) return false;
  *value = v;
  return true;
}
bool params_to_text(const clap_plugin_t *, clap_id, double, char *, uint32_t) { return false; }
bool params_from_text(const clap_plugin_t *, clap_id, const char *, double *) { return false; }
void params_flush(const clap_plugin_t *p, const clap_input_events_t *in, const clap_output_events_t *) {
  for (uint32_t i = 0; i < in->size(in); i++) {
    auto *h = in->get(in, i);
    if (h->space_id != CLAP_CORE_EVENT_SPACE_ID || h->type != CLAP_EVENT_PARAM_VALUE) continue;
    auto *pv = (const clap_event_param_value_t *)h;
    AudioUnitSetParameter(self(p)->unit, pv->param_id, kAudioUnitScope_Global, 0, (AudioUnitParameterValue)pv->value, 0);
  }
}
const clap_plugin_params_t PARAMS = {params_count, params_info, params_value, params_to_text, params_from_text, params_flush};

uint32_t latency_get(const clap_plugin_t *p) {
  Float64 s = 0;
  UInt32 n = sizeof s;
  AudioUnitGetProperty(self(p)->unit, kAudioUnitProperty_Latency, kAudioUnitScope_Global, 0, &s, &n);
  return (uint32_t)(s * self(p)->sr + 0.5);
}
const clap_plugin_latency_t LATENCY = {latency_get};

bool state_save(const clap_plugin_t *p, const clap_ostream_t *s) {
  CFPropertyListRef plist = nullptr;
  UInt32 n = sizeof plist;
  if (AudioUnitGetProperty(self(p)->unit, kAudioUnitProperty_ClassInfo, kAudioUnitScope_Global, 0, &plist, &n) != noErr || !plist) return false;
  CFDataRef data = CFPropertyListCreateData(nullptr, plist, kCFPropertyListBinaryFormat_v1_0, 0, nullptr);
  CFRelease(plist);
  if (!data) return false;
  const uint8_t *b = CFDataGetBytePtr(data);
  int64_t len = CFDataGetLength(data), done = 0;
  while (done < len) {
    int64_t w = s->write(s, b + done, (uint64_t)(len - done));
    if (w <= 0) break;
    done += w;
  }
  CFRelease(data);
  return done == len;
}
bool state_load(const clap_plugin_t *p, const clap_istream_t *s) {
  AU *a = self(p);
  std::vector<uint8_t> all;
  uint8_t buf[65536];
  for (;;) {
    int64_t r = s->read(s, buf, sizeof buf);
    if (r <= 0) break;
    all.insert(all.end(), buf, buf + r);
  }
  CFDataRef data = CFDataCreate(nullptr, all.data(), (CFIndex)all.size());
  CFPropertyListRef plist = CFPropertyListCreateWithData(nullptr, data, kCFPropertyListImmutable, nullptr, nullptr);
  CFRelease(data);
  if (!plist) return false;
  OSStatus err = AudioUnitSetProperty(a->unit, kAudioUnitProperty_ClassInfo, kAudioUnitScope_Global, 0, &plist, sizeof plist);
  CFRelease(plist);
  if (err != noErr) return false;
  // Tell the views (and listeners) that every parameter may have changed.
  AudioUnitParameter all_{a->unit, kAUParameterListener_AnyParameter, kAudioUnitScope_Global, 0};
  AUParameterListenerNotify(nullptr, nullptr, &all_);
  return true;
}
const clap_plugin_state_t STATE = {state_save, state_load};

/** The AU's own Cocoa view, or the system's generic one. */
NSView *makeView(AU *a) {
  UInt32 size = 0;
  Boolean writable = false;
  if (AudioUnitGetPropertyInfo(a->unit, kAudioUnitProperty_CocoaUI, kAudioUnitScope_Global, 0, &size, &writable) == noErr && size >= sizeof(AudioUnitCocoaViewInfo)) {
    std::vector<uint8_t> b(size);
    auto *info = (AudioUnitCocoaViewInfo *)b.data();
    if (AudioUnitGetProperty(a->unit, kAudioUnitProperty_CocoaUI, kAudioUnitScope_Global, 0, info, &size) == noErr) {
      NSURL *url = (__bridge_transfer NSURL *)info->mCocoaAUViewBundleLocation;
      NSString *cls = (__bridge_transfer NSString *)info->mCocoaAUViewClass[0];
      for (UInt32 i = 1; i < (size - sizeof(CFURLRef)) / sizeof(CFStringRef); i++) CFRelease(info->mCocoaAUViewClass[i]);
      NSBundle *bundle = url ? [NSBundle bundleWithURL:url] : nil;
      Class factory = bundle && cls ? [bundle classNamed:cls] : nil;
      if (factory && [factory conformsToProtocol:@protocol(AUCocoaUIBase)]) {
        id<AUCocoaUIBase> f = [[factory alloc] init];
        NSView *v = [f uiViewForAudioUnit:a->unit withSize:NSMakeSize(600, 400)];
        if (v) return v;
      }
    }
  }
  AUGenericView *g = [[AUGenericView alloc] initWithAudioUnit:a->unit displayFlags:AUViewTitleDisplayFlag | AUViewPropertiesDisplayFlag | AUViewParametersDisplayFlag];
  [g setShowsExpertParameters:YES];
  return g;
}

bool gui_supported(const clap_plugin_t *, const char *api, bool floating) { return !floating && !strcmp(api, CLAP_WINDOW_API_COCOA); }
bool gui_preferred(const clap_plugin_t *, const char **, bool *) { return false; }
bool gui_create(const clap_plugin_t *p, const char *api, bool floating) {
  if (floating || strcmp(api, CLAP_WINDOW_API_COCOA)) return false;
  self(p)->view = makeView(self(p));
  return self(p)->view != nil;
}
void gui_destroy(const clap_plugin_t *p) {
  [self(p)->view removeFromSuperview];
  self(p)->view = nil;
}
bool gui_scale(const clap_plugin_t *, double) { return false; }
bool gui_size(const clap_plugin_t *p, uint32_t *w, uint32_t *h) {
  NSView *v = self(p)->view;
  if (!v) return false;
  *w = (uint32_t)v.frame.size.width;
  *h = (uint32_t)v.frame.size.height;
  return *w && *h;
}
bool gui_can_resize(const clap_plugin_t *) { return false; }
bool gui_hints(const clap_plugin_t *, clap_gui_resize_hints_t *) { return false; }
bool gui_adjust(const clap_plugin_t *, uint32_t *, uint32_t *) { return true; }
bool gui_set_size(const clap_plugin_t *, uint32_t, uint32_t) { return false; }
bool gui_set_parent(const clap_plugin_t *p, const clap_window_t *win) {
  NSView *parent = (__bridge NSView *)win->cocoa;
  if (!self(p)->view || !parent) return false;
  [parent addSubview:self(p)->view];
  return true;
}
bool gui_transient(const clap_plugin_t *, const clap_window_t *) { return false; }
void gui_title(const clap_plugin_t *, const char *) {}
bool gui_show(const clap_plugin_t *) { return true; }
bool gui_hide(const clap_plugin_t *) { return true; }
const clap_plugin_gui_t GUI = {gui_supported, gui_preferred, gui_create, gui_destroy, gui_scale, gui_size, gui_can_resize, gui_hints, gui_adjust, gui_set_size, gui_set_parent, gui_transient, gui_title, gui_show, gui_hide};

bool render_hard(const clap_plugin_t *) { return false; }
bool render_set(const clap_plugin_t *p, clap_plugin_render_mode mode) {
  AU *a = self(p);
  a->offline = mode == CLAP_RENDER_OFFLINE;
  bool was = a->initialized;
  uninitialize(a);
  return was ? initialize(a) : true;
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

std::string idOf(const AudioComponentDescription &d) { return fourcc(d.componentType) + ":" + fourcc(d.componentSubType) + ":" + fourcc(d.componentManufacturer); }

/** "Vendor: Name" is how AUs are named; split it. */
void names(AudioComponent c, std::string &vendor, std::string &name) {
  CFStringRef s = nullptr;
  AudioComponentCopyName(c, &s);
  std::string full = str(s);
  if (s) CFRelease(s);
  size_t k = full.find(": ");
  vendor = k == std::string::npos ? "" : full.substr(0, k);
  name = k == std::string::npos ? full : full.substr(k + 2);
}
std::string versionOf(AudioComponent c) {
  UInt32 v = 0;
  AudioComponentGetVersion(c, &v);
  char b[32];
  snprintf(b, sizeof b, "%u.%u.%u", v >> 16, (v >> 8) & 0xff, v & 0xff);
  return b;
}

}  // namespace

extern "C" int ob_is_au(const char *path) { return !strcmp(path, "au:"); }

/** Every effect and instrument AU in the registry, as JSON objects separated by commas. */
extern "C" int ob_au_scan(char *out, size_t cap) {
  std::string list;
  int n = 0;
  for (OSType kind : KINDS) {
    AudioComponentDescription want{kind, 0, 0, 0, 0};
    for (AudioComponent c = AudioComponentFindNext(nullptr, &want); c; c = AudioComponentFindNext(c, &want)) {
      AudioComponentDescription d{};
      if (AudioComponentGetDescription(c, &d) != noErr) continue;
      std::string vendor, name;
      names(c, vendor, name);
      std::string features = kind == kAudioUnitType_MusicDevice ? "\"instrument\"" : kind == kAudioUnitType_MIDIProcessor ? "\"note-effect\"" : kind == kAudioUnitType_MusicEffect ? "\"audio-effect\",\"note-input\"" : "\"audio-effect\"";
      if (n++) list += ",";
      list += "{\"format\":\"au\",\"id\":" + json(idOf(d)) + ",\"name\":" + json(name) + ",\"vendor\":" + json(vendor) + ",\"version\":" + json(versionOf(c)) + ",\"description\":" + json(fourcc(kind)) + ",\"features\":[" + features + "]}";
    }
  }
  if (list.size() + 1 > cap) return -1;
  snprintf(out, cap, "%s", list.c_str());
  return n;
}

/** An AU by "type:subtype:manufacturer", as a CLAP plugin (main thread). */
extern "C" const clap_plugin_t *ob_au_create(const char *uid, const clap_host_t *host, char *err, size_t cap) {
  AudioComponentDescription d{};
  if (strlen(uid) != 14 || uid[4] != ':' || uid[9] != ':' || !parseFourcc(uid, &d.componentType) || !parseFourcc(uid + 5, &d.componentSubType) || !parseFourcc(uid + 10, &d.componentManufacturer)) {
    snprintf(err, cap, "%s is not an Audio Unit id (type:subtype:manufacturer)", uid);
    return nullptr;
  }
  AudioComponent c = AudioComponentFindNext(nullptr, &d);
  AudioUnit unit = nullptr;
  if (!c || AudioComponentInstanceNew(c, &unit) != noErr || !unit) {
    snprintf(err, cap, "cannot create %s", uid);
    return nullptr;
  }
  AU *a = new AU();
  a->host = host;
  a->cd = d;
  a->unit = unit;
  // A MIDI processor takes notes like an instrument, and has no audio in.
  a->instrument = d.componentType == kAudioUnitType_MusicDevice || d.componentType == kAudioUnitType_MIDIProcessor;
  a->inCh = a->instrument ? 0 : 2;
  names(c, a->vendor, a->name);
  a->version = versionOf(c);
  a->id = uid;
  UInt32 size = 0;
  if (AudioUnitGetPropertyInfo(unit, kAudioUnitProperty_ParameterList, kAudioUnitScope_Global, 0, &size, nullptr) == noErr && size) {
    a->ids.resize(size / sizeof(AudioUnitParameterID));
    AudioUnitGetProperty(unit, kAudioUnitProperty_ParameterList, kAudioUnitScope_Global, 0, a->ids.data(), &size);
    for (auto pid : a->ids) {
      AudioUnitParameterInfo pi{};
      UInt32 n = sizeof pi;
      AudioUnitGetProperty(unit, kAudioUnitProperty_ParameterInfo, kAudioUnitScope_Global, pid, &pi, &n);
      a->infos.push_back(pi);
    }
  }
  if (AUEventListenerCreate(listen, a, CFRunLoopGetMain(), kCFRunLoopCommonModes, 0.005, 0.005, &a->listener) == noErr)
    for (auto pid : a->ids)
      for (AudioUnitEventType t : {kAudioUnitEvent_ParameterValueChange, kAudioUnitEvent_BeginParameterChangeGesture, kAudioUnitEvent_EndParameterChangeGesture}) {
        AudioUnitEvent e{};
        e.mEventType = t;
        e.mArgument.mParameter = {unit, pid, kAudioUnitScope_Global, 0};
        AUEventListenerAddEventType(a->listener, a, &e);
      }
  a->features[0] = a->instrument ? CLAP_PLUGIN_FEATURE_INSTRUMENT : CLAP_PLUGIN_FEATURE_AUDIO_EFFECT;
  a->desc = {CLAP_VERSION_INIT, a->id.c_str(), a->name.c_str(), a->vendor.c_str(), "", "", "", a->version.c_str(), "", a->features};
  a->clap = {&a->desc, a, p_init, p_destroy, p_activate, p_deactivate, p_start, p_stop, p_reset, p_process, p_ext, p_main};
  return &a->clap;
}
