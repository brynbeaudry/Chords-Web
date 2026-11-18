"""Compute evaluate.py's feature cache in parallel (optional speed-up)."""
import sys, os
from multiprocessing import Pool
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evaluate as ev
from data import subjects


def job(a):
    kind, args = a
    if kind == 's':
        ev.features_for(*args)
    else:
        ev.null_features(*args)


if __name__ == '__main__':
    jobs = [('s', (s, ch)) for s in subjects() for ch in ev.ALL_CH]
    jobs += [('s', (s, ch, 50.0)) for s in subjects() for ch in ev.OCC]
    jobs += [('n', (k, e)) for k in range(4) for e in (1.0, 1.5, 2.0)]
    jobs += [('n', (k, 1.5, m)) for k in range(2) for m in (50.0, 200.0)]
    with Pool(int(sys.argv[1]) if len(sys.argv) > 1 else 6) as p:
        for i, _ in enumerate(p.imap_unordered(job, jobs)):
            pass
    print('done', len(jobs))
