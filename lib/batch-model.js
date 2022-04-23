/**
 * Job
 * @typedef {Object} Job
 * @property {string} task - the netscript function to call
 * @property {string[]} args - the arguments to the function
 * @property {number} threads - number of threads
 * @property {number} duration - duration of this task in milliseconds
 * @property {number} startTime
 * @property {number} endTime
 * @property {Object} change - expected changes of this operation
 */

/**
 * Batch
 * @typedef {Array} Batch - array of jobs with methods for calculating useful metrics
 * 
 * Jobs are ordered by their endTime and there is a clear firstEndTime and lastEndTime,
 * but the earliestStartTime also depends on other timing factors.
 */
 export class Batch extends Array {

    summary() {
        const tasks = this.map((job)=>(job.task || '-').substr(0,1).toUpperCase());
        return tasks.join('');
    }

    longSummary() {
        const tasks = this.map((job)=>(
            job.task || '-').substr(0,1).toLowerCase() + job.threads
        );
        return tasks.join(' ');
    }

    peakThreads() {
        return this.reduce((total, job)=>(
            total + job.threads
        ), 0);
    }

    avgThreads(tDelta) {
        const threadMSeconds = this.reduce((total,job)=>(
            total + job.threads * job.duration
        ), 0);
        return threadMSeconds / this.totalDuration(tDelta);
    }

    maxThreads() {
        return this.reduce((total, job)=>(
            Math.max(total, job.threads)
        ), 0);
    }

    peakRam() {
        return this.reduce((total, job)=>(
            total + job.threads * (TASK_RAM[job.task] || TASK_RAM['*'])
        ), 0);
    }

    avgRam(tDelta) {
        const gbMSeconds = this.reduce((total,job)=>{
            const gb = TASK_RAM[job.task] || 2.0;
            return total + job.threads * gb * job.duration
        }, 0);
        return gbMSeconds / this.totalDuration(tDelta);
    }

    /**
     * @returns {number} The total amount of money gained by the player if all hack operations are successful.
     */
     moneyTaken() {
        return this.reduce((total, job)=>(
            total + (job.change?.playerMoney || 0)
        ), 0);
    }

    /**
     * @returns {number} The effective percent of money hacked by the largest hacking job.
     */
    actualMoneyPercent() {
        const minMoneyMult = this.reduce((total, job)=>(
            Math.min(total, job.change.moneyMult)
        ), 1);
        const moneyPercent = 1 - minMoneyMult;
        return moneyPercent;
    }

    moneySummary() {
        const moneyPercent = this.actualMoneyPercent();
        return `${moneyPercent<0.09999 ? ' ' : ''}${(moneyPercent*100).toFixed(1)}%`;
    }

    activeDuration(tDelta=100) {
        return this.length * tDelta;
    }

    maxDuration() {
        return this.reduce((longest, job)=>(
            Math.max(longest, job.duration)
        ), 0);
    }

    /**
     * @returns {number} Total milliseconds from the start of the earliest job until after the end of the last job
     */
     totalDuration(tDelta=100) {
        if (this.length == 0) {
            return 0;
        }
        if (!this.firstEndTime()) {
            this.setFirstEndTime(1, tDelta);
        }
        return this.lastEndTime() + tDelta - this.earliestStartTime();
        // return this.maxDuration() + this.activeDuration(tDelta);
    }

    /**
     * @returns {number} endTime of the first job, or null
     */
    firstEndTime() {
        return this[0]?.endTime;
    }

    /**
     * @returns {number} endTime of the last job, or null
     */
     lastEndTime() {
        return this[this.length-1]?.endTime;
    }

    /**
     * @returns {number} The earliest startTime of any job, or Infinity if none have a startTime, or null if no jobs
     */
    earliestStartTime() {
        if (this.length == 0) {
            return null;
        }
        const earliest = this.reduce((e, job)=>(
            Math.min(e, job.startTime)
        ), Infinity);
        return earliest;
    }

    /**
     * Modify all `startTime` and `endTime` values so that the first `endTime` is `firstEndTime`.
     * @param {number} firstEndTime 
     * @param {number} tDelta 
     */
    setFirstEndTime(firstEndTime, tDelta=100) {
        let endTime = firstEndTime;
        for (const job of this) {
            job.endTime = endTime;
            endTime += tDelta;
            job.startTime = job.endTime - job.duration;
        }
    }

    /**
     * Modify all `startTime` and `endTime` values so that the earliest `startTime` is `startTime`.
     * @param {number} startTime
     * @param {number} tDelta
     */
     setStartTime(startTime, tDelta=100) {
        if (this.length > 0) {
            if (!this[0].startTime) {
                this.setFirstEndTime(startTime + this[0].duration, tDelta);
            }
            const earliestStart = this.earliestStartTime();
            if (earliestStart < startTime) {
                this.adjustSchedule(startTime - earliestStart);
            }
        }
    }

    adjustSchedule(offset) {
        if (offset) {
            for (const job of this) {
                job.startTime += offset;
                job.endTime += offset;
            }
        }
    }

    /**
     * Adjust all `startTime` and `endTime` values to be in the future.
     * @param {number} now - current timestamp
     * @param {number} tDelta - milliseconds between endTimes
     */
    ensureStartInFuture(now, tDelta) {
        now ||= Date.now();
        if (!(this.earliestStartTime() > now)) {
            this.setStartTime(now+1, tDelta);
        }
    }

    maxBatchesAtOnce(maxTotalRam, tDelta=100, reserveRam=false) {
        const totalDuration = this.totalDuration(tDelta);
        const activeDuration = this.activeDuration(tDelta);
        const maxBatchesPerCycle = Math.floor(totalDuration / activeDuration);
        const ramUsed = reserveRam ? this.peakRam() : this.avgRam(tDelta);

        const maxBatchesInRam = Math.floor(maxTotalRam / ramUsed);

        return Math.min(maxBatchesPerCycle, maxBatchesInRam);
    }

    minTimeBetweenBatches(maxTotalRam, tDelta=100) {
        const totalDuration = this.totalDuration(tDelta);
        const numBatchesAtOnce = this.maxBatchesAtOnce(maxTotalRam, tDelta);
        return (totalDuration / numBatchesAtOnce);
    }

    convertToScripts(params={batchID:0, repeatPeriod:0}) {
        const scripts = new Batch(this.length);
        for (const [index, originalJob] of this.entries()) {
            const job = {...originalJob};
            job.script = '/hacking/do.js'; // multi-purpose hack/grow/weaken script
            job.args = [job.task];
            const options = originalJob.args[2];
            if (options.stock) {
                job.args.push('--stock');
            }
            if (params.reserveRam && job.startTime) {
                job.args.push('--startTime', job.startTime);
                delete job.startTime;
            }
            if (params.repeatPeriod) {
                job.args.push('--repeatPeriod', params.repeatPeriod);
            }
            job.args.push(`batch-${params.batchID}.${index+1}`);
            job.allowSplit = true; // TODO: test whether this can be disabled by scheduling into future
            scripts[index] = job;
        }
        return scripts;
    }
}

const TASK_RAM = {
    null: 1.6,
    'hack': 1.7,
    'grow': 1.75,
    'weaken': 1.75,
    '*': 2.0
};