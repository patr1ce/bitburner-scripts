import { getThreadPool } from "/botnet/worker";
import { HackableServer, HackPlanner } from "/hacking/planner";

const FLAGS = [
    ["help", false],
    ["backendPort", 3],        // default port for ThreadPool
    ["tDelta", 100],           // milliseconds between effects
    ["maxTotalRam", 0],        // optional (will be read from backend)
    ["maxThreadsPerJob", 0],   // optional (will be read from backend)
    ["moneyPercent", 0.05],    // (will be overwritten by optimizer)
    ["hackMargin", 0.25],      // (will be overwritten by optimizer)
    ["prepMargin", 0.5],       // (will be overwritten by optimizer)
    ["naiveSplit", false],     // not currently used
    ["reserveRam", true],      // weather to calculate batch RAM requirement based on peak amount
    ["cores", 1],              // not currently used
];

export function autocomplete(data, args) {
    data.flags(FLAGS);
    return data.servers;
}

/*

TODO: create a dashboard showing target information
    - number of jobs dispatched
    - number of jobs pending?
    - cycle duration
    - latestEndTime
    - latestStartTime

TODO: support multiple targets.
Measure total ram in the server pool
while some ram is not reserved:
- select the target with most $/sec/GB
- reserve enough ram to completely exploit that target
- if any ram remains, proceed to the next target

*/

/** @param {NS} ns **/
export async function main(ns) {
    ns.disableLog('scan');
    ns.disableLog('asleep');
    ns.clearLog();
    const flags = ns.flags(FLAGS);
    if (flags.help) {
        ns.tprint("Manage hacking a server.")
        return;
    }
    delete flags.help;

    const backend = await getThreadPool(ns, flags.backendPort);
    delete flags.backendPort;

    flags.maxTotalRam ||= backend.getMaxTotalRam();
    flags.maxThreadsPerJob ||= backend.getMaxThreadsPerJob();

    const targets = flags._;
    delete flags._;

    const manager = new HackingManager(ns, backend, targets, flags)
    await manager.work();
}

export class HackingManager {
    constructor(ns, backend, targets=[], params={}) {
        this.ns = ns;
        this.backend = backend;
        this.params = params;
        this.batchID = 0;

        this.targets = [];
        this.plans = {};
        const planner = new HackPlanner(ns, params);
        for (const plan of planner.mostProfitableServers(params, targets)) {
            const target = plan.server;
            target.expectedSecurity = [[Date.now(), target.hackDifficulty]];
            this.targets.push(target);
            this.plans[target.hostname] = plan;
        }
        ns.atExit(this.tearDown.bind(this));
    }

    tearDown() {
        this.running = false;
    }

    async work() {
        const {ns, targets} = this;

        this.running = true;
        while (this.running && this.backend.running) {
            const target = this.targets[0];
            eval("window").target = target;
            await this.hackOneTargetOneTime(target);
            // TODO: re-select optimal target as conditions change

            // ns.clearLog();
            // ns.print(this.report());
        }
    }

    async hackOneTargetOneTime(server) {
        const {ns} = this;
        const batchCycle = this.plans[server.hostname];
        const params = batchCycle.params;
        const now = Date.now() + params.tDelta;
        const prevServer = server.copy();
        const batchID = this.batchID++;

        // TODO: slice target.expectedSecurity to only items after now

        // Decide whether prep is needed.
        // TODO: use params to set 'secMargin' input to this function.
        const isPrepBatch = !server.isPrepared();

        // Plan a batch based on target state and parameters
        const batch = isPrepBatch ? server.planPrepBatch(params) : server.planHackingBatch(params);

        // Schedule the batch
        if (!server.nextFreeTime) {
            batch.setStartTime(now);
            server.nextFreeTime = now + batch.totalDuration(params.tDelta) - batch.activeDuration(params.tDelta);
        }
        batch.setFirstEndTime(server.nextFreeTime, params.tDelta);
        batch.ensureStartInFuture(now, params.tDelta);
        batch.scheduleForSafeWindows(params.tDelta, server.expectedSecurity)

        // Add callbacks to check for desync
        for (const job of batch) {
            job.shouldStart = this.shouldStart.bind(this);
        }
        batch[batch.length-1].didFinish = this.didFinish.bind(this);

        // Dispatch the batch
        const result = await this.backend.dispatchJobs(batch, isPrepBatch); // TODO: use isPrepBatch to allow dispatchJobs to shift jobs farther into the future
        if (result) {
            ns.print(`Dispatched batch ${batchID}: ${batch.moneySummary()} ${batch.summary()} batch for ${server.hostname}`);
            for (const job of batch) {
                server.expectedSecurity.push([job.endTime, job.result.hackDifficulty]);
            }
        }
        else {
            // If dispatch failed, rollback state
            ns.print(`Failed to dispatch batch ${batchID}: ${batch.summary()} batch for ${server.hostname}. Skipping this batch.`);
            server.reload(prevServer);
            // TODO: check whether params.maxThreadsPerJob still fits in backend
        }

        // Update the schedule for this target, and block until the schedule is free.
        if (isPrepBatch) {
            server.nextStartTime = batch.lastEndTime() + params.tDelta;
        }
        else {
            server.nextFreeTime = batch.lastEndTime() + params.tDelta + batchCycle.timeBetweenStarts;
            server.nextStartTime = batch.earliestStartTime() - params.tDelta + batchCycle.timeBetweenStarts;
        }
        await ns.asleep(server.nextStartTime - Date.now()); // this should be timeBetweenStarts before the following batch's earliest start
    }

    shouldStart(job) {
        const {ns} = this;
        if (!this.running) {
            return (job.task != 'hack');
        }
        const actualServer = job.result.copy().reload();
        if (job.task === 'hack' && actualServer.hackDifficulty > job.result.prepDifficulty) {
            ns.print(`WARNING: Cancelling ${job.task} job: ${actualServer.hackDifficulty.toFixed(1)} > ${job.result.prepDifficulty.toFixed(1)} security.`);
            return false;
        }
        return true;
    }

    didFinish(job) {
        const {ns} = this;
        const server = this.targets.find((s)=>s.hostname === job.result.hostname);
        if (!this.running || !server) {
            return;
        }
        const expectedServer = job.result;
        const actualServer = job.result.copy().reload();
        if (actualServer.hackDifficulty > expectedServer.hackDifficulty) {
            ns.print(`WARNING: desync detected after batch ${batchID}. Reloading server state and adjusting parameters.`);
            server.reload(actualServer);
            const newParams = server.mostProfitableParamsSync(this.params);
            this.plans[server.hostname] = server.planBatchCycle(newParams);
            server.reload();
            server.expectedSecurity = [[Date.now(), server.hackDifficulty]];
        }
        // console.log(`Finished batch ${batchID}. Expected security:`, job.result.hackDifficulty, "Actual:", job.result.copy().reload().hackDifficulty);
    }

    report() {
        const server = this.targets[0];
        return JSON.stringify(server.expectedSecurity, null, 2);
        // a server should have a list of upcoming event times
        // filter upcoming events by time >= now
        // list time 
    }
}
