import { ServerPool } from "/net/server-pool";
import { drawTable } from "/lib/box-drawing";
import { Batch } from "/hive/planner";

const FLAGS = [
    ["port", 1],
    ["verbose", false],
    ["test", false]
];

const SCRIPT_CAPABILITIES = [
    {script: "/hive/worker-hack.js", capabilities: ['hack'], dependencies: ["/hive/worker.js"]},
    {script: "/hive/worker-grow.js", capabilities: ['grow'], dependencies: ["/hive/worker.js"]},
    {script: "/hive/worker-weaken.js", capabilities: ['weaken'], dependencies: ["/hive/worker.js"]},
    {script: "/hive/worker.js", capabilities: ['hack', 'grow', 'weaken']}
];

/*

Overall process:
pool, manager, and workers launch in any order.
pool publishes itself on a port.
other scripts wait until they see something on that port.
workers then call pool.registerWorker(this)

*/

/** @param {NS} ns **/
export async function main(ns) {
    ns.disableLog("asleep");
    ns.disableLog("scan");
    ns.disableLog("scp");
    ns.disableLog("exec");
    ns.clearLog();

    const flags = ns.flags(FLAGS);

    const threadPool = new ThreadPool({ns, ...flags});
    eval("window").db = threadPool;
    
    if (flags.test) {
        setTimeout(async function(){
            const spec = [
                {threads: 10},
                {threads: 20},
                {threads: 30},
                {threads: 40},
                {threads: 50, startTime: Date.now() + 1000}
            ];
            await threadPool.getWorkers(spec);
            await ns.asleep(2000);
            await threadPool.getWorkers(spec);
        }, 100)
    }

    await threadPool.work();
}

export class ThreadPool {
    constructor({ns, port, verbose}) {    
        this.ns = ns;
        this.process = ns.getRunningScript();
        this.workers = {};
        this.nextWorkerID = 1;

        this.portNum = port;
        this.port = ns.getPortHandle(this.portNum);
        this.port.clear();
        this.port.write(this);

        ns.atExit(this.tearDown.bind(this));

        ns.print(`Started ThreadPool on port ${this.portNum}.`);
    }

    async work() {
        const {ns} = this;
        this.running = true;
        while(this.running) {
            ns.clearLog();
            ns.print(this.report());
            await ns.asleep(200);
        }
    }

    tearDown() {
        // When the pool process exits, signal all the workers to stop.
        for (const worker of Object.values(this.workers)) {
            worker.running = false;
        }
        this.port.clear();
    }

    async dispatchJobs(batch) {
        // Get workers (this can take some time due to launching and registering)
        const workers = await this.getWorkers(batch);
        if (!workers) {
            this.ns.tprint(`Failed to allocate workers for batch.`);
            return null;
        }
        // Update batch schedule after getting workers
        if (typeof(batch.ensureStartInFuture === 'function')) {
            batch.ensureStartInFuture(Date.now() + 100);
        }
        // Dispatch each job
        const results = [];
        for (const job of batch) {
            const result = await this.dispatchJob(job);
            results.push(result);
        }
        return results;
    }

    async dispatchJob(job) {
        if (job.threads <= 0) {
            return true;
        }
        job.threads ||= 1;
        const worker = await this.getWorker(job);
        return worker?.addJob(job);
    }

    async getWorkers(specs) {
        // Get a block of workers matching certain specs.
        // Returns an array of Worker objects if all specs could be satisfied.
        // Returns null if any spec could not be satisfied.
        const workers = {};
        for (const spec of specs) {
            if (spec.threads == 0) {
                continue;
            }
            const worker = await this.getWorker({...spec, exclude:workers});
            if (!worker) {
                return null;
            }
            workers[worker.id] = worker;
            // TODO: Lock this worker for this job (if the whole batch can be met)
            //     worker.nextFreeTime = startTime-1;
        }
        return workers;
    }

    async getWorker({threads, startTime, task, exclude}) {
        // Get a new or existing worker with the requested specs:
        // - has at least `threads` threads
        // - has capability to perform the function `task`,
        // - is available by `startTime`
        exclude ||= {};
        startTime ||= Date.now();
        const capabilities = task ? [task] : [];
        const matchingWorkers = Object.values(this.workers).filter((worker)=>(
            !exclude[worker.id] && 
            worker.running &&
            worker.nextFreeTime < startTime &&
            worker.process.threads >= threads &&
            worker.process.threads < threads*2 &&
            capabilities.every((task)=>task in worker.capabilities)
        )).sort((a,b)=>(
            a.threads - b.threads
        ));
        const worker = matchingWorkers[0];
        if (worker) {
            return worker;
        }
        else {
            return await this.spawnWorker(threads, capabilities);
        }
    }
    
    // Create a new worker with `threads` threads (ignores number of CPU cores)
    async spawnWorker(threads, capabilities) {
        const {ns, portNum} = this;
        threads = Math.ceil(threads);

        // Find a suitable script.
        const {script, dependencies} = getScriptWithCapabilities(capabilities);
        if (!script) {
            this.logWarn(`Failed to start worker with ${threads} threads: No script capable of ${JSON.stringify(capabilities)}.`);
            return null;
        }

        // Find a suitable server.
        const serverPool = new ServerPool({ns, scriptRam: script});
        const server = serverPool.smallestServerWithThreads(threads);
        if (!server) {
            this.logWarn(`Failed to start worker with ${threads} threads: Not enough RAM on any available server.`);
            return null;
        }
        // TODO: instead of rounding up the thread count, check if a larger worker will fit.
        // // Round up a process size to fill an entire server.
        // // worker.id = `${server.hostname}-${worker.id}`;
        // if ((server.availableThreads - threads < 4) || (threads > server.availableThreads * 3 / 4)) {
        //     threads = server.availableThreads;
        // }

        // Create the worker process.
        while (this.nextWorkerID in this.workers) {
            this.nextWorkerID++;
        }
        const workerID = this.nextWorkerID++;
        this.workers[workerID] = {
            id: workerID,
            running: false
        };
        const args = ["--port", portNum, "--id", workerID];
        const {pid} = await serverPool.deploy({server, script, threads, args, dependencies});
        if (!pid) {
            this.logWarn(`Failed to start worker ${workerID}.`);
            return null;
        }
        this.workers[workerID].process = {pid, threads};
        this.logInfo(`Started worker ${workerID} (PID ${pid}) with ${threads} threads on ${server.hostname}.`);

        // Wait for the worker process to register with us.
        while (!this.workers[workerID].running) {
            await ns.asleep(20);
        }
        return this.workers[workerID];
    }

    // Link this worker and pool to each other
    registerWorker(worker) {
        const {ns} = this;
        const launchedWorker = this.workers[worker.id];
        if (launchedWorker?.running) {
            // If multiple workers claim the same ID, stop the older one.
            launchedWorker.running = false;
        }
        if (launchedWorker?.process) {
            // Fill in process information if we already know the PID
            worker.process = ns.getRunningScript(launchedWorker.process.pid);
        }
        else {
            // Otherwise search for the process (it may have launched on page load)
            worker.process = this.findWorkerProcess(worker);
        }
        this.workers[worker.id] = worker;
    }

    findWorkerProcess(worker) {
        const {ns} = this;
        const scriptName = worker.ns.getScriptName();
        const args = worker.ns.args;
        const serverPool = new ServerPool({ns});
        for (const server of serverPool) {
            const process = this.ns.getRunningScript(scriptName, server.hostname, ...args);
            if (process) {
                return process;
            }
        }
        return null;
    }

    logWarn(...args) {
        this.ns.tprint(...args);
    }

    logInfo(...args) {
        if (this.verbose) {
            this.ns.tprint(...args);
        }
    }

    report() {
        const {ns} = this;
        const formatThreads = function(t){
            if (!t) {
                return '';
            }
            return ns.nFormat(t, "0a");
        }
        const now = Date.now();
        const columns = [
            {header: "Worker", field: "id"},
            {header: " Threads ", field: "threads", format: [formatThreads]},
            {header: "Task", field: "task", width: 6, align: "center"},
            {header: "Queue", field: "queue", align: "left", truncate: true},
            {header: "Elapsed ", field: "elapsedTime", format: drawTable.time},
            {header: "Remaining", field: "remainingTime", format: drawTable.time, formatArgs: [2]},
            {header: "Drift  ", field: "drift" }
        ];
        columns.title = `Thread Pool (Port ${this.portNum})`;
        const rows = Object.values(this.workers).map((worker)=>workerReport(worker, now));
        return drawTable(columns, rows);
    }
}

function getScriptWithCapabilities(caps) {
    for (const workerType of SCRIPT_CAPABILITIES) {
        if (caps.every((task)=>workerType.capabilities.includes(task))) {
            return workerType;
        }
    }
    return null;
}

function workerReport(worker, now) {
    now ||= Date.now();
    return {
        id: worker.id,
        threads: [worker.currentJob?.threads, worker.process?.threads],
        queue: (new Batch(...(worker.jobQueue || []))).summary(),
        task: worker.currentJob?.task,
        elapsedTime: worker.elapsedTime? worker.elapsedTime(now) : null,
        remainingTime: worker.remainingTime? worker.remainingTime(now) : null,
        drift: worker.drift ? worker.drift.toFixed(0) + ' ms' : ''
    };
}
