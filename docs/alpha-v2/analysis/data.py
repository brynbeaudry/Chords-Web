"""Loading the open eyes-closed / eyes-open dataset and synthetic test signals.

Dataset: Cattan, Rodrigues & Congedo, "EEG Alpha Waves dataset", GIPSA-lab 2017,
Zenodo doi:10.5281/zenodo.2348892, CC-BY-4.0. 20 adults, 16 wet electrodes, g.USBamp,
512 Hz, no digital filter, right-earlobe reference. Ten 10 s blocks alternating eyes
closed (condition 1, column 18) and eyes open (condition 2, column 19).
"""
import os
import numpy as np
import scipy.io as sio
from scipy.signal import resample_poly, butter, sosfiltfilt

CHANNELS = ['Fp1', 'Fp2', 'FC5', 'FC6', 'Fz', 'T7', 'Cz', 'T8',
            'P7', 'P3', 'Pz', 'P4', 'P8', 'O1', 'Oz', 'O2']
DATA_DIR = os.environ.get('ALPHA_DATA', os.path.join(os.path.dirname(__file__), 'data'))
URL = 'https://zenodo.org/api/records/2348892/files/subject_{:02d}.mat/content'


def subjects():
    return sorted(int(f[8:10]) for f in os.listdir(DATA_DIR) if f.startswith('subject_'))


def load(subject, fs_out=500):
    """Return (uv [n_samples x 16] at fs_out, ec_onsets_s, eo_onsets_s)."""
    m = sio.loadmat(os.path.join(DATA_DIR, f'subject_{subject:02d}.mat'))['SIGNAL']
    t = m[:, 0]
    ec = t[m[:, 17] != 0]
    eo = t[m[:, 18] != 0]
    x = m[:, 1:17].astype(float)
    # Front-end model: the NPG amplifier is AC-coupled, so remove electrode DC offset
    # (0.3 Hz, zero-phase) before the gain stage. This does not touch the 1-45 Hz content.
    sos = butter(2, 0.3, 'highpass', fs=512, output='sos')
    x = sosfiltfilt(sos, x, axis=0)
    x = resample_poly(x, fs_out, 512, axis=0)          # 512 -> 500 Hz, the NPG Lite rate
    return x, ec, eo


def block_labels(n, ec, eo, fs=500, settle=1.0, length=10.0):
    """Per-sample truth: +1 eyes closed, -1 eyes open, 0 = transition / outside blocks.
    The first `settle` seconds after each instruction are excluded (eyes moving, alpha
    building or blocking)."""
    y = np.zeros(n, int)
    for o in ec:
        y[int((o + settle) * fs):int((o + length) * fs)] = 1
    for o in eo:
        y[int((o + settle) * fs):int((o + length) * fs)] = -1
    return y


def pink_noise(n, rng, fs=500, exponent=1.0):
    """1/f^exponent noise (power spectrum), unit variance."""
    f = np.fft.rfftfreq(n, 1 / fs)
    spec = rng.normal(size=len(f)) + 1j * rng.normal(size=len(f))
    spec[1:] /= f[1:] ** (exponent / 2)
    spec[0] = 0
    x = np.fft.irfft(spec, n)
    return x / x.std()


def blink(fs=500, amp_uv=150.0, dur_s=0.35):
    """A monophasic eye-blink deflection (raised-cosine), as seen frontally."""
    t = np.arange(int(dur_s * fs)) / fs
    return amp_uv * 0.5 * (1 - np.cos(2 * np.pi * t / dur_s))
