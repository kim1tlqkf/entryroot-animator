/* entry-vector-rig: CommonJS 모듈을 전역(window.oneEuroFilter)으로 잡히게 감쌈. 아래 원본(1eurofilter 1.3.0 dist/OneEuroFilter.js)은 그대로. */
(function (exports) {
"use strict";
/**
 * Author: Alix Giguey and Gery Casiez
 * Details: https://gery.casiez.net/1euro/
 *
 * Copyright 2019 Inria
 *
 * BSD License https://opensource.org/licenses/BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 *  1. Redistributions of source code must retain the above copyright notice, this list of conditions
 * and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions
 * and the following disclaimer in the documentation and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or
 * promote products derived from this software without specific prior written permission.

 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
 * INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OneEuroFilter = void 0;
class LowPassFilter {
    setAlpha(alpha) {
        if (alpha <= 0.0 || alpha > 1.0)
            console.log('alpha should be in (0.0., 1.0]');
        this.a = alpha;
    }
    constructor(alpha, initval = 0.0) {
        this.y = this.s = initval;
        this.a = alpha;
        this.setAlpha(alpha);
        this.initialized = false;
    }
    filter(value) {
        let result;
        if (this.initialized)
            result = this.a * value + (1.0 - this.a) * this.s;
        else {
            result = value;
            this.initialized = true;
        }
        this.y = value;
        this.s = result;
        return result;
    }
    filterWithAlpha(value, alpha) {
        this.setAlpha(alpha);
        return this.filter(value);
    }
    hasLastRawValue() {
        return this.initialized;
    }
    lastRawValue() {
        return this.y;
    }
    lastFilteredValue() {
        return this.s;
    }
    reset() {
        this.initialized = false;
    }
}
// -----------------------------------------------------------------
class OneEuroFilter {
    alpha(cutoff) {
        let te = 1.0 / this.freq;
        let tau = 1.0 / (2 * Math.PI * cutoff);
        return 1.0 / (1.0 + tau / te);
    }
    /**
     * Sets the frequency of the signal
     *
     * @param freq An estimate of the frequency in Hz of the signal (> 0), if timestamps are not available.
     */
    setFrequency(freq) {
        if (freq <= 0)
            console.log('freq should be >0');
        this.freq = freq;
    }
    /**
     * Sets the filter min cutoff frequency
     *
     * @param mincutoff Min cutoff frequency in Hz (> 0). Lower values allow to remove more jitter.
     */
    setMinCutoff(mincutoff) {
        if (mincutoff <= 0)
            console.log('mincutoff should be >0');
        this.mincutoff = mincutoff;
    }
    /**
     * Sets the Beta parameter
     *
     * @param beta Parameter to reduce latency (> 0).
     */
    setBeta(beta) {
        this.beta = beta;
    }
    /**
     * Sets the dcutoff parameter
     *
     * @param dcutoff Used to filter the derivates. 1 Hz by default. Change this parameter if you know what you are doing.
     */
    setDerivateCutoff(dcutoff) {
        if (dcutoff <= 0)
            console.log('dcutoff should be >0');
        this.dcutoff = dcutoff;
    }
    /**
     * Sets the parameters of the 1 euro filter.
     *
     * @param freq - An estimate of the frequency in Hz of the signal (> 0), if timestamps are not available.
     * @param mincutoff - Min cutoff frequency in Hz (> 0). Lower values allow to remove more jitter.
     * @param beta - Parameter to reduce latency (> 0).
     *
     */
    setParameters(freq, mincutoff, beta) {
        this.setFrequency(freq);
        this.setMinCutoff(mincutoff);
        this.setBeta(beta);
    }
    /**
     * Constructs a 1 euro filter.
     *
     * @param freq - An estimate of the frequency in Hz of the signal (> 0), if timestamps are not available.
     * @param mincutoff - Min cutoff frequency in Hz (> 0). Lower values allow to remove more jitter.
     * @param beta - Parameter to reduce latency (> 0).
     * @param dcutoff - Used to filter the derivates. 1 Hz by default. Change this parameter if you know what you are doing.
     *
     */
    constructor(freq, mincutoff = 1.0, beta = 0.0, dcutoff = 1.0) {
        this.freq = freq;
        this.mincutoff = mincutoff;
        this.beta = beta;
        this.dcutoff = dcutoff;
        this.setFrequency(freq);
        this.setMinCutoff(mincutoff);
        this.setBeta(beta);
        this.setDerivateCutoff(dcutoff);
        this.x = new LowPassFilter(this.alpha(mincutoff));
        this.dx = new LowPassFilter(this.alpha(dcutoff));
        this.lasttime = undefined;
    }
    /**
     * Resets the internal state of the filter.
     */
    reset() {
        this.x.reset();
        this.dx.reset();
        this.lasttime = undefined;
    }
    /**
     * Returns the filtered value.
     *
     * @param value - Noisy value to filter
     * @param timestamp - (optional) timestamp in seconds
     * @returns The filtered value
     *
     */
    filter(value, timestamp) {
        // update the sampling frequency based on timestamps
        if (this.lasttime != undefined &&
            timestamp != undefined &&
            timestamp > this.lasttime)
            this.freq = 1.0 / (timestamp - this.lasttime);
        this.lasttime = timestamp;
        // estimate the current variation per second
        let dvalue = this.x.hasLastRawValue()
            ? (value - this.x.lastFilteredValue()) * this.freq
            : 0.0;
        let edvalue = this.dx.filterWithAlpha(dvalue, this.alpha(this.dcutoff));
        // use it to update the cutoff frequency
        let cutoff = this.mincutoff + this.beta * Math.abs(edvalue);
        // filter the given value
        return this.x.filterWithAlpha(value, this.alpha(cutoff));
    }
}
exports.OneEuroFilter = OneEuroFilter;

})(globalThis.oneEuroFilter = {});
