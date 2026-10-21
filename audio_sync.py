"""Song analysis for lip sync (0.11.0): where phrases start, and how far a take's
own singing is from the song.

Both read audio through ffmpeg and work with numpy only (no extra dependencies).

Phrase starts are estimated from the full mix. Lead vocals usually sit in the
centre of a stereo mix, so the centre channel (L + R) minus what's on the sides
(L - R), in the voice range (250-3500 Hz), follows the singing far better than
the plain loudness. A phrase starts where that rises after a pause.

Alignment compares the take's own audio (H3's performance of the song) with the
song around the take's place, by how their sound changes moment to moment (the
onset envelope), and finds the shift where they match best."""

from __future__ import annotations

import subprocess

import numpy as np

SR = 16000          # analysis sample rate
HOP = 160           # 10 ms
WIN = 512


def read_audio(path, ffmpeg, start=None, duration=None, channels=2):
    """float32 [channels, samples] at SR, via ffmpeg (start / duration in seconds)."""
    cmd = [ffmpeg, "-v", "error"]
    if start is not None:
        cmd += ["-ss", f"{max(0.0, float(start)):.4f}"]
    cmd += ["-i", path]
    if duration is not None:
        cmd += ["-t", f"{max(0.01, float(duration)):.4f}"]
    cmd += ["-vn", "-ac", str(channels), "-ar", str(SR), "-f", "s16le", "-"]
    res = subprocess.run(cmd, capture_output=True)
    if res.returncode != 0:
        raise RuntimeError("Reading the audio failed: " + res.stderr.decode("utf-8", "replace")[-400:])
    x = np.frombuffer(res.stdout, dtype="<i2").astype(np.float32) / 32768.0
    n = len(x) // channels
    return x[:n * channels].reshape(n, channels).T.copy()


def _frames(x):
    if len(x) < WIN:
        x = np.pad(x, (0, WIN - len(x)))
    n = 1 + (len(x) - WIN) // HOP
    idx = np.arange(WIN)[None, :] + HOP * np.arange(n)[:, None]
    return x[idx] * np.hanning(WIN)[None, :]


def _band_power(x, lo=250, hi=3500):
    spec = np.abs(np.fft.rfft(_frames(x), axis=1)) ** 2
    freqs = np.fft.rfftfreq(WIN, 1.0 / SR)
    band = (freqs >= lo) & (freqs <= hi)
    return spec[:, band].sum(axis=1)


def _smooth(v, n=5):
    if n <= 1 or len(v) < n:
        return v
    k = np.ones(n) / n
    return np.convolve(v, k, mode="same")


def vocal_curve(stereo):
    """The singing, roughly: centre minus sides in the voice range, in dB, one value per 10 ms."""
    left, right = stereo[0], stereo[1] if stereo.shape[0] > 1 else stereo[0]
    mid, side = (left + right) / 2, (left - right) / 2
    pm, ps = _band_power(mid), _band_power(side)
    v = np.maximum(pm - 1.5 * ps, 0.0)
    if ps.sum() < 1e-3 * pm.sum():            # (nearly) mono: no centre to separate
        v = pm
    return _smooth(10 * np.log10(v + 1e-10), 5)


def detect_phrases(path, ffmpeg, min_gap=0.5, sensitivity=0.5, min_len=0.12):
    """Seconds into the file where singing starts after at least `min_gap` s of quiet."""
    curve = vocal_curve(read_audio(path, ffmpeg))
    if len(curve) < 10:
        return []
    lo, hi = np.percentile(curve, 20), np.percentile(curve, 97)
    if hi - lo < 3:                            # flat: nothing that stands out
        return []
    sens = min(1.0, max(0.0, float(sensitivity)))
    thr = lo + (hi - lo) * (0.65 - 0.4 * sens)
    on = curve > thr
    gap, keep = max(1, int(round(min_gap * 100))), max(1, int(round(min_len * 100)))
    out, quiet = [], gap                       # the very start counts as after a pause
    i = 0
    while i < len(on):
        if on[i]:
            if quiet >= gap and i + keep <= len(on) - 5 and on[i:i + keep].mean() > 0.6:
                out.append(round((i * HOP / SR) * 24) / 24)
            j = i
            while j < len(on) and on[j]:
                j += 1
            quiet = 0
            i = j
            continue
        quiet += 1
        i += 1
    return out


def onset_envelope(mono):
    """How much the sound brightens from one 10 ms step to the next (spectral flux)."""
    spec = np.log1p(np.abs(np.fft.rfft(_frames(mono), axis=1)))
    flux = np.maximum(np.diff(spec, axis=0), 0).sum(axis=1)
    flux = np.concatenate([[0.0], flux])
    flux = flux - _smooth(flux, 31)
    return np.maximum(flux, 0)


def find_offset(take_audio, song_audio, song_lead, max_shift=3.0):
    """The shift (seconds) that best lines up the take's audio with the song.

    song_audio starts `song_lead` seconds before where the take currently sits.
    Returns (offset, confidence): offset > 0 means the take sings early (move it
    later by that much); confidence is the match strength over the next best."""
    a = onset_envelope(take_audio.mean(axis=0))
    b = onset_envelope(song_audio.mean(axis=0))
    if len(a) < 50 or len(b) < len(a) // 2:
        return None, 0.0
    a = (a - a.mean()) / (a.std() + 1e-9)
    b = (b - b.mean()) / (b.std() + 1e-9)
    lead = int(round(song_lead * 100))
    span = int(round(max_shift * 100))
    scores = {}
    for lag in range(-span, span + 1):
        s0 = lead + lag                       # song index lined up with take index 0
        lo, hi = max(0, -s0), min(len(a), len(b) - s0)
        if hi - lo < len(a) // 2:
            continue
        x, y = a[lo:hi], b[s0 + lo:s0 + hi]
        scores[lag] = float(np.dot(x, y) / len(x))
    if not scores:
        return None, 0.0
    best = max(scores, key=scores.get)
    others = [v for k, v in scores.items() if abs(k - best) > 15]
    second = max(others) if others else 0.0
    conf = scores[best] / (abs(second) + 1e-6) if scores[best] > 0 else 0.0
    # lag > 0: the take's moment 0 matches the song lag later -> it sings early
    return best / 100.0, conf


# ---------------------------------------------------------------------------
# 0.12.6: an exact-seeking copy of the song for playback in the Studio. Browsers
# jump into a compressed file (mp3 especially) by estimate, so after a click on the
# timeline the song could land a fraction of a second off; in a WAV the jump is exact.
# ---------------------------------------------------------------------------

EXACT_SEEK = (".wav", ".wave")


def needs_preview(path):
    return not str(path).lower().endswith(EXACT_SEEK)


def preview_name(path):
    """The cached WAV's file name: changes when the song file does."""
    import hashlib
    import os
    st = os.stat(path)
    h = hashlib.blake2b(f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime_ns}".encode(), digest_size=10)
    return h.hexdigest() + ".wav"


def make_preview(path, ffmpeg, folder):
    """The song as 16-bit PCM WAV in `folder` (made once); returns its path."""
    import os
    os.makedirs(folder, exist_ok=True)
    out = os.path.join(folder, preview_name(path))
    if os.path.isfile(out) and os.path.getsize(out) > 44:
        return out
    tmp = out + ".part.wav"
    res = subprocess.run([ffmpeg, "-v", "error", "-y", "-i", path, "-vn", "-c:a", "pcm_s16le", tmp],
                         capture_output=True)
    if res.returncode != 0 or not os.path.isfile(tmp):
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise RuntimeError("Converting the song failed: " + res.stderr.decode("utf-8", "replace")[-400:])
    os.replace(tmp, out)
    return out
