#include "controllers/MotionController.h"

#include <Arduino.h>
#include <math.h>

#include "Config.h"
#include "Settings.h"

namespace {
const int kNnlsSweeps = 12;
const float kActivityThreshold = 30.0f;  // z 350, jasně nad šumem v klidu
}

void MotionController::reset() {
  for (int i = 0; i < 6; i++) filt_[i] = 0.0f;
  for (int k = 0; k < 12; k++) act_[k] = 0.0f;
  lastExclusive_ = -1;
  motionActive_ = false;
}

float MotionController::clampf(float v, float lo, float hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

float MotionController::lowpass(float prev, float x, float dt, float tau) {
  if (tau <= 0.0f) return x;
  const float a = dt / (tau + dt);
  return prev + a * (x - prev);
}

// Splits the sensor delta into non-negative amounts of the 12 learned
// direction fingerprints (coordinate-descent NNLS, warm-started from the last
// frame). Separate +/- fingerprints let each direction be asymmetric.
void MotionController::decompose(const float d[9], const Profile& p) {
  float r[9];
  for (int j = 0; j < 9; j++) {
    r[j] = d[j];
    for (int k = 0; k < 12; k++) r[j] -= act_[k] * p.tpl[k][j];
  }
  for (int s = 0; s < kNnlsSweeps; s++) {
    for (int k = 0; k < 12; k++) {
      const float* t = p.tpl[k];
      float tt = 0.0f, tr = 0.0f;
      for (int j = 0; j < 9; j++) {
        tt += t[j] * t[j];
        tr += t[j] * r[j];
      }
      if (tt < 1e-9f) continue;
      float a = act_[k] + tr / tt;
      if (a < 0.0f) a = 0.0f;
      const float delta = a - act_[k];
      if (delta == 0.0f) continue;
      act_[k] = a;
      for (int j = 0; j < 9; j++) r[j] -= delta * t[j];
    }
  }
}

void MotionController::compute(const float raw[9], const float* baseline, float dt,
                               float out[6]) {
  const Profile& p = settings.cur();

  float d[9];
  for (int j = 0; j < 9; j++) d[j] = raw[j] - baseline[j];
  decompose(d, p);

  // Per-direction sensitivity and locks, then dead zone per axis.
  float y[6];
  float maxAbs = 0.0f;
  float freeSq = 0.0f;   // společná síla os, které se smí kombinovat
  int single = -1;       // nejsilnější výhradní osa
  for (int i = 0; i < 6; i++) {
    const int kp = i * 2, km = i * 2 + 1;
    const float plus = (p.lockMask & (1u << kp)) ? 0.0f : act_[kp] * p.dsens[kp];
    const float minus = (p.lockMask & (1u << km)) ? 0.0f : act_[km] * p.dsens[km];
    float v = (plus - minus) * Config::AXIS_LIMIT * p.sens;
    if (fabsf(v) < p.dead[i]) v = 0.0f;
    y[i] = v;
    if (fabsf(v) > maxAbs) maxAbs = fabsf(v);
    if (p.mix[i] == MIX_SINGLE) {
      if (v != 0.0f && (single < 0 || fabsf(v) > fabsf(y[single]))) single = i;
    } else {
      freeSq += v * v;
    }
  }

  // Axis mixing:
  //   Free   - always passes, combines with other free axes
  //   Damp   - fades out when much weaker than the strongest axis
  //   Single - exclusive (e.g. twist): wins only when clearly stronger than all free axes
  //            TOGETHER, then every other axis is zeroed; otherwise it is zeroed itself.
  // Volné osy se porovnávají jako celek (délka vektoru): při náklonu „do kříže“ (dopředu-doleva,
  // krouživý pohyb) je každá zvlášť slabší a otáčení by jinak vyhrávalo -> přeskakování.
  // Výhradní osa vyhraje až s 30% rezervou a vítězí, dokud ji volné osy nepřerostou o 25 %.
  const float freeNorm = sqrtf(freeSq);
  int winner = -1;
  if (lastExclusive_ >= 0 && p.mix[lastExclusive_] == MIX_SINGLE && y[lastExclusive_] != 0.0f &&
      fabsf(y[lastExclusive_]) * 1.25f >= freeNorm) {
    winner = lastExclusive_;
  } else if (single >= 0 && fabsf(y[single]) > 1.3f * freeNorm) {
    winner = single;
  }
  lastExclusive_ = winner;
  if (winner >= 0) {
    for (int i = 0; i < 6; i++) if (i != winner) y[i] = 0.0f;
  } else if (maxAbs > 0.0f) {
    for (int i = 0; i < 6; i++) {
      const float ratio = fabsf(y[i]) / maxAbs;
      if (p.mix[i] == MIX_SINGLE) y[i] = 0.0f;
      else if (p.mix[i] == MIX_DAMP) y[i] *= clampf((ratio - 0.25f) / 0.35f, 0.0f, 1.0f);
    }
  }

  motionActive_ = false;
  for (int i = 0; i < 6; i++) {
    if (y[i] == 0.0f) {
      filt_[i] = 0.0f;
    } else {
      filt_[i] = lowpass(filt_[i], y[i], dt, Config::SMOOTH_TAU_S);
    }
    out[i] = clampf(filt_[i], -Config::AXIS_LIMIT, Config::AXIS_LIMIT);
    // Aktivita (pro spánek a „knoflík použit“) až od skutečného pohybu: šum v klidu
    // občas projde mrtvou zónou jako záškub 4–6 a vynuloval by odpočet do spánku.
    if (fabsf(out[i]) > kActivityThreshold) motionActive_ = true;
  }
}

bool MotionController::hasMotionActivity() const { return motionActive_; }
