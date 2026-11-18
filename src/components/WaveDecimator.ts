// 500 -> 125 Hz for the waveform sent to TouchDesigner (contract v2, plan §4.4):
// averages each group of `factor` samples and hands out `perBatch` decimated samples per
// detector hop (4 x 16 = 64 input samples = 128 ms), with the running index `n` of the
// first sample of each batch in the 125 Hz stream.

export interface WaveBatch {
    n: number;        // index of w[0] in the decimated stream
    w: number[];      // perBatch samples
}

export class WaveDecimator {
    private readonly factor: number;
    private readonly perBatch: number;
    private acc = 0;
    private accCount = 0;
    private batch: number[] = [];
    private next = 0;   // index of the first sample of the next batch

    constructor(factor = 4, perBatch = 16) {
        this.factor = factor;
        this.perBatch = perBatch;
    }

    /** Push one input sample; returns a batch every factor * perBatch samples, else null. */
    push(x: number): WaveBatch | null {
        this.acc += x;
        if (++this.accCount < this.factor) return null;
        this.batch.push(this.acc / this.factor);
        this.acc = 0;
        this.accCount = 0;
        if (this.batch.length < this.perBatch) return null;
        const out = { n: this.next, w: this.batch };
        this.next += this.perBatch;
        this.batch = [];
        return out;
    }

    reset(): void {
        this.acc = 0;
        this.accCount = 0;
        this.batch = [];
        this.next = 0;
    }
}
