const FLAGS = [
    ["port", 1],
    ["id"]
];

/** @param {NS} ns **/
export async function main(ns) {
    // List the functions this worker is capable of, for static RAM calculation.
    const capabilities = {
        "hack": ns.hack,
        "grow": ns.grow,
        "weaken": ns.weaken
    }
    const worker = new Worker(ns, capabilities);
    await worker.work();
}

export class Worker {
    constructor(ns, capabilities={}) {
        ns.disableLog("asleep");

        const flags = ns.flags(FLAGS);

        this.id = flags.id;
        this.portNum = flags.port;
        this.tDelta = 100;
        this.ns = ns;
        this.scriptName = ns.getScriptName();
        this.capabilities = capabilities;
        this.nextFreeTime = Date.now();
        this.jobQueue = [];
        this.currentJob = {
            startTime: Date.now()
        };
        this.running = false;

        ns.atExit(this.tearDown.bind(this));
    }

    async work() {
        let {ns} = this;
        // Register with the thread pool.
        this.pool = await getThreadPool(ns, this.portNum);
        if (!this.pool) {
            ns.tprint(`Worker unable to find ThreadPool on port ${this.portNum}. Exiting.`);
            return;
        }
        this.pool.registerWorker(this);
        ns.print(`Worker ${this.id} registered with thread pool. Starting work.`);
        // Block until something sets running to false
        this.running = true;
        while (this.running) {
            await ns.asleep(1000);
            // Terminate a worker that has not been used in a while.
            if (!this.currentJob.task && this.elapsedTime() > 5*60*1000) {
                this.running = false;
            }
            // TODO: terminate if the queue is empty and the average workload is less than half of the max workload
        }
        console.log(`Worker ${this.id} stopping.`);
    }

    tearDown() {
        // When this worker exits for any reason, remove it from the pool database.
        if (this.pool) {
            delete this.pool.workers[this.id];
        }
    }

    addJob(job) {
        const {ns} = this;
        const now = Date.now();

        // Validate job parameters.
        job.args ||= [];
        if (!job.startTime) {
            job.startTime = now;
        }
        if (job.startTime < Math.max(now, this.nextFreeTime)) {
            const drift = job.startTime - Math.max(now, this.nextFreeTime);
            console.log(`Worker ${this.id} declined job: ${job.task} ${JSON.stringify(job.args)} (${drift.toFixed(0)} ms)`);
            return false;
        }
        if (!job.endTime && job.duration) {
            job.endTime = job.startTime + job.duration
        }

        // Schedule the job to run.
        this.jobQueue.push(job);
        this.nextFreeTime = job.endTime + this.tDelta;
        setTimeout(()=>{
            this.runNextJob()
        }, job.startTime - now);
        console.log(`Worker ${this.id} accepted job: ${job.task} ${JSON.stringify(job.args)} (${(job.startTime - now).toFixed(0)} ms)`);
        return true;
    }

    async runNextJob() {
        if (this.currentJob.task) {
            this.pool.ns.tprint(`ERROR: Worker ${this.id} tried to start ${this.jobQueue[0]?.task} before finishing ${this.currentJob.task}`);
        }
        // Take the next job from the queue.
        const job = this.jobQueue.shift();
        this.currentJob = job;

        // Run the job and record timing information.
        job.startTimeActual = Date.now();
        this.drift = job.startTimeActual - job.startTime;
        this.ns.print(`Starting job: ${job.task} ${JSON.stringify(job.args)} (${this.drift.toFixed(0)} ms)`);
        await this.capabilities[job.task](...job.args);
        job.endTimeActual = Date.now();
        this.drift = job.endTimeActual - job.endTime;
        this.ns.print(`Completed job: ${job.task} ${JSON.stringify(job.args)} (${this.drift.toFixed(0)} ms)`);

        // Run an 'onFinish' callback if provided.
        if (typeof(job.onFinish) === 'function') {
            job.onFinish(job);
        }

        // Mark this worker as idle.
        this.currentJob = {
            startTime: Date.now()
        };
    }

    elapsedTime(now) {
        now ||= Date.now();
        if (this.currentJob.startTime) {
            return now - this.currentJob.startTime;
        }
        else {
            return null;
        }
    }

    remainingTime(now) {
        now ||= Date.now();
        let endTime;
        if (this.currentJob.endTime) {
            endTime = this.currentJob.endTime;
        }
        else if (this.jobQueue.length > 0) {
            endTime = this.jobQueue[0].startTime;
        }
        if (endTime) {
            return endTime - now;
        }
        else {
            return null;
        }
    }
}

export async function getThreadPool(ns, portNum) {
    const port = ns.getPortHandle(portNum);
    let tries = 50;
    while (port.empty() && tries-- > 0) {
        await ns.asleep(50);
    }
    if (port.empty()) {
        return null;
    }
    return port.peek();
}
