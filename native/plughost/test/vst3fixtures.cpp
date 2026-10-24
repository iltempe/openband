// Test plugins for the VST3 side of openband-plughost (G8.5), built with the VST3 SDK's plugin classes.
// Never shipped: built only with OPENBAND_FIXTURES, into ob-vst3-fixtures.vst3.
//   OB VST3 Gain   an effect: output = input × Gain (default 0.5, −6 dB), 256 samples late (it reports it)
//   OB VST3 Synth  an instrument: a sine per held note, sample-accurate, × Level (default 0.5)
// The state of both is their one parameter as a float.
#include "base/source/fstreamer.h"
#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "public.sdk/source/main/pluginfactory.h"
#include "public.sdk/source/vst/vstaudioeffect.h"
#include "public.sdk/source/vst/vsteditcontroller.h"
#include <cmath>
#include <vector>

using namespace Steinberg;
using namespace Steinberg::Vst;

static const FUID GainProc(0x0B5E0001, 0x4F70656E, 0x42616E64, 0x4761696E);
static const FUID GainCtrl(0x0B5E0002, 0x4F70656E, 0x42616E64, 0x47616943);
static const FUID SynthProc(0x0B5E0003, 0x4F70656E, 0x42616E64, 0x53796E74);
static const FUID SynthCtrl(0x0B5E0004, 0x4F70656E, 0x42616E64, 0x53796E43);
static const int LATENCY = 256;

class Fixture : public AudioEffect {
 public:
  explicit Fixture(bool synth) : synth(synth) { setControllerClass(synth ? SynthCtrl : GainCtrl); }

  tresult PLUGIN_API initialize(FUnknown *context) override {
    tresult r = AudioEffect::initialize(context);
    if (r != kResultOk) return r;
    if (synth) addEventInput(STR16("Notes"), 1);
    else addAudioInput(STR16("In"), SpeakerArr::kStereo);
    addAudioOutput(STR16("Out"), SpeakerArr::kStereo);
    return kResultOk;
  }
  uint32 PLUGIN_API getLatencySamples() override { return synth ? 0 : LATENCY; }
  tresult PLUGIN_API setActive(TBool on) override {
    line.assign(2 * LATENCY, 0.f);
    pos = 0;
    for (auto &n : notes) n = 0;
    return AudioEffect::setActive(on);
  }
  tresult PLUGIN_API process(ProcessData &d) override {
    // Parameter changes: the value at each point applies from its sample on.
    std::vector<std::pair<int32, double>> changes;
    if (d.inputParameterChanges)
      for (int32 i = 0; i < d.inputParameterChanges->getParameterCount(); i++) {
        IParamValueQueue *q = d.inputParameterChanges->getParameterData(i);
        if (!q || q->getParameterId() != (synth ? 2u : 0u)) continue;
        for (int32 k = 0; k < q->getPointCount(); k++) {
          int32 at;
          ParamValue v;
          if (q->getPoint(k, at, v) == kResultOk) changes.push_back({at, v});
        }
      }
    std::vector<Event> events;
    if (d.inputEvents)
      for (int32 i = 0; i < d.inputEvents->getEventCount(); i++) {
        Event e;
        if (d.inputEvents->getEvent(i, e) == kResultOk) events.push_back(e);
      }
    if (!d.numOutputs || !d.outputs[0].channelBuffers32) return kResultOk;
    float **out = d.outputs[0].channelBuffers32;
    float **in = !synth && d.numInputs ? d.inputs[0].channelBuffers32 : nullptr;
    size_t c = 0, e = 0;
    const double w = 2 * M_PI / processSetup.sampleRate;
    for (int32 s = 0; s < d.numSamples; s++) {
      while (c < changes.size() && changes[c].first <= s) value = changes[c++].second;
      while (e < events.size() && events[e].sampleOffset <= s) {
        const Event &ev = events[e++];
        if (ev.type == Event::kNoteOnEvent) notes[ev.noteOn.pitch & 127] = 1, phase[ev.noteOn.pitch & 127] = 0;
        if (ev.type == Event::kNoteOffEvent) notes[ev.noteOff.pitch & 127] = 0;
      }
      for (int ch = 0; ch < 2; ch++) {
        float y;
        if (synth) {
          double sum = 0;
          for (int n = 0; n < 128; n++)
            if (notes[n]) sum += std::sin(phase[n]);
          y = (float)(sum * value);
        } else {
          float x = in ? in[ch][s] : 0.f;
          y = line[ch * LATENCY + pos];
          line[ch * LATENCY + pos] = (float)(x * value);
        }
        out[ch][s] = y;
      }
      if (synth)
        for (int n = 0; n < 128; n++)
          if (notes[n]) phase[n] = std::fmod(phase[n] + w * 440.0 * std::pow(2.0, (n - 69) / 12.0), 2 * M_PI);
      if (!synth) pos = (pos + 1) % LATENCY;
    }
    d.outputs[0].silenceFlags = 0;
    return kResultOk;
  }
  tresult PLUGIN_API setState(IBStream *state) override {
    IBStreamer s(state, kLittleEndian);
    double v;
    if (!s.readDouble(v)) return kResultFalse;
    value = v;
    return kResultOk;
  }
  tresult PLUGIN_API getState(IBStream *state) override {
    IBStreamer s(state, kLittleEndian);
    s.writeDouble(value);
    return kResultOk;
  }
  tresult PLUGIN_API canProcessSampleSize(int32 size) override { return size == kSample32 ? kResultTrue : kResultFalse; }

  static FUnknown *gain(void *) { return (IAudioProcessor *)new Fixture(false); }
  static FUnknown *synthesizer(void *) { return (IAudioProcessor *)new Fixture(true); }

 private:
  bool synth;
  double value = 0.5;
  std::vector<float> line;
  int pos = 0;
  int notes[128] = {};
  double phase[128] = {};
};

class FixtureController : public EditController {
 public:
  explicit FixtureController(bool synth) : synth(synth) {}
  tresult PLUGIN_API initialize(FUnknown *context) override {
    tresult r = EditController::initialize(context);
    if (r == kResultOk) parameters.addParameter(synth ? STR16("Level") : STR16("Gain"), nullptr, 0, 0.5, ParameterInfo::kCanAutomate, synth ? 2 : 0);
    return r;
  }
  tresult PLUGIN_API setComponentState(IBStream *state) override {
    IBStreamer s(state, kLittleEndian);
    double v;
    if (s.readDouble(v)) setParamNormalized(synth ? 2 : 0, v);
    return kResultOk;
  }
  static FUnknown *gain(void *) { return (IEditController *)new FixtureController(false); }
  static FUnknown *synthesizer(void *) { return (IEditController *)new FixtureController(true); }

 private:
  bool synth;
};

BEGIN_FACTORY_DEF("OpenBand", "https://www.openband.it", "")
DEF_CLASS2(INLINE_UID_FROM_FUID(GainProc), PClassInfo::kManyInstances, kVstAudioEffectClass, "OB VST3 Gain", Vst::kDistributable, "Fx", "1.0.0", kVstVersionString, Fixture::gain)
DEF_CLASS2(INLINE_UID_FROM_FUID(GainCtrl), PClassInfo::kManyInstances, kVstComponentControllerClass, "OB VST3 Gain", 0, "", "1.0.0", kVstVersionString, FixtureController::gain)
DEF_CLASS2(INLINE_UID_FROM_FUID(SynthProc), PClassInfo::kManyInstances, kVstAudioEffectClass, "OB VST3 Synth", Vst::kDistributable, "Instrument|Synth", "1.0.0", kVstVersionString, Fixture::synthesizer)
DEF_CLASS2(INLINE_UID_FROM_FUID(SynthCtrl), PClassInfo::kManyInstances, kVstComponentControllerClass, "OB VST3 Synth", 0, "", "1.0.0", kVstVersionString, FixtureController::synthesizer)
END_FACTORY
