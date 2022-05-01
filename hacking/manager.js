import { getThreadPool } from "/botnet/worker";
import { HackableServer, HackPlanner } from "/hacking/planner";
import {logHTML, render} from "/exploit/printHTML";

const FLAGS = [
    ["help", false],
    ["backendPort", 3],        // default port for ThreadPool
    ["tDelta", 100],           // milliseconds between effects
    ["maxTotalRam", 0],        // optional (will be read from backend)
    ["maxThreadsPerJob", 0],   // optional (will be read from backend)
    ["moneyPercent", 0.05],    // (will be overwritten by optimizer)
    ["secMargin", 0.5],        // (will be overwritten by optimizer)
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
        this.allBatches = [];
        this.t0 = Date.now();

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
        this.startAnimation();
        while (this.running && this.backend.running) {
            const target = this.targets[0];
            eval("window").target = target;
            await this.hackOneTargetOneTime(target);
            // TODO: re-select optimal target as conditions change

            // ns.clearLog();
            // ns.print(this.report());

            // this.report();
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
        const isPrepBatch = !server.isPrepared();

        // Plan a batch based on target state and parameters
        const batch = isPrepBatch ? server.planPrepBatch(params) : server.planHackingBatch(params);
        if (batch.length == 0) {
            ns.print("ERROR: batch was empty");
            await ns.asleep(1000);
            server.reload();
            return;
        }

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
        const result = await this.backend.dispatchJobs(batch, {allowPartial: isPrepBatch}); // TODO: use isPrepBatch to allow dispatchJobs to shift jobs farther into the future
        if (!result) {
            // If dispatch failed, rollback state
            ns.print(`WARNING: Failed to dispatch batch ${batchID}: ${batch.summary()} batch for ${server.hostname}. Skipping this batch.`);
            server.reload(prevServer);
            await ns.asleep(1000);
            return;
        }

        ns.print(`Dispatched batch ${batchID}: ${batch.moneySummary()} ${batch.summary()} batch for ${server.hostname}`);
        for (const job of batch) {
            server.expectedSecurity.push([job.endTime, job.result.hackDifficulty]);
        }
        // Update the schedule for this target, and block until the schedule is free.
        if (isPrepBatch) {
            server.nextStartTime = batch.lastEndTime() + params.tDelta;
        }
        else {
            server.nextFreeTime = batch.lastEndTime() + params.tDelta + batchCycle.timeBetweenStarts;
            server.nextStartTime = batch.earliestStartTime() - params.tDelta + batchCycle.timeBetweenStarts;
        }
        this.allBatches.push(batch);
        await ns.asleep(server.nextStartTime - Date.now()); // this should be timeBetweenStarts before the following batch's earliest start
    }

    shouldStart(job) {
        const {ns} = this;
        if (job.task != 'hack') {
            return true;
        }
        if (job.task == 'hack' && !this.running) {
            return false;
        }
        const actualServer = job.result.copy().reload();
        if (actualServer.hackDifficulty > job.result.prepDifficulty) {
            ns.print(`WARNING: Cancelling ${job.task} job: ${actualServer.hackDifficulty.toFixed(2)} > ${job.result.prepDifficulty.toFixed(2)} security.`);
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
            ns.print(`WARNING: desync detected after batch ${this.batchID}. Reloading server state and adjusting parameters.`);
            server.reload(actualServer);
            const newParams = server.mostProfitableParamsSync(this.params);
            this.plans[server.hostname] = server.planBatchCycle(newParams);
            server.reload();
            server.expectedSecurity = [[Date.now(), server.hackDifficulty]];
        }
        // console.log(`Finished batch ${batchID}. Expected security:`, job.result.hackDifficulty, "Actual:", job.result.copy().reload().hackDifficulty);
    }

    startAnimation() {
        const {ns} = this;
        ns.print("Visualization of hacking operations:");
        this.animationEl = render("<div>");
        logHTML(ns, this.animationEl);
        requestAnimationFrame(this.updateAnimation.bind(this));
    }

    updateAnimation() {
        if (!this.running) {
            return;
        }
        requestAnimationFrame(this.updateAnimation.bind(this));

        const {ns} = this;

        const now = Date.now();
        function convertTimeToX(t, t0=now, tWidth=15000, pxWidth=800) {
            return ((t - t0) * pxWidth / tWidth);
        }

        let template = `
        <svg version="1.1" xmlns="http://www.w3.org/2000/svg"
                width="800" height="600"
                viewBox="${convertTimeToX(now-10000)} 0 800 600"
        >
            <rect x="${convertTimeToX(now-10000)}" width="100%" height="100%" fill="#111"></rect>
        `;

        let secLayer = '';  // TODO: make this a <group>
        let jobLayer = '';

        const TASK_COLORS = {
            "hack": "cyan",
            "grow": "lightgreen",
            "weaken": "yellow"
        };
        const desyncColor = 'magenta';

        let safeSec = this.allBatches[0][0]?.result?.minDifficulty || 0;
        let prevSec = 0; // this.allBatches[0][0]?.result?.hackDifficulty || 0;
        let prevEnd = this.allBatches[0][0]?.startTime || this.t0;
        let i = 0;
        for (const batch of this.allBatches) {
            for (const job of batch) {
                i = (i + 1) % 150;
                const startTime = job.startTimeActual || job.startTime;
                const endTime = job.endTimeActual || job.endTime;
                const duration = job.durationActual || job.duration;
                if (endTime < now-13000) {
                    continue;
                }

                // shade the background based on secLevel
                let bgColor = '#111';
                if (prevSec > safeSec) {
                    bgColor = '#333';
                }
                secLayer += `
                    <rect x="${convertTimeToX(prevEnd)}" y="0" width="${convertTimeToX(job.endTime - prevEnd, 0)}" height="100%" fill="${bgColor}"/>
                `;
                prevSec = job.result.hackDifficulty;
                prevEnd = job.endTime;

                // draw the job bars
                let color = TASK_COLORS[job.task];
                if (job.cancelled) {
                    color = "red";
                }
                jobLayer += `
                    <rect x="${convertTimeToX(job.startTime)}" y="${i*4}" width="${convertTimeToX(job.duration, 0)}" height="2" fill="${color}"/>
                `;
                if (job.startTimeActual) {
                    jobLayer += `
                        <rect x="${convertTimeToX(Math.min(job.startTime, job.startTimeActual))}" y="${i*4}" width="${convertTimeToX(Math.abs(job.startTime - job.startTimeActual), 0)}" height="1" fill="${desyncColor}"/>
                    `;
                }
                if (job.endTimeActual) {
                    jobLayer += `
                        <rect x="${convertTimeToX(Math.min(job.endTime, job.endTimeActual))}" y="${i*4}" width="${convertTimeToX(Math.abs(job.endTime - job.endTimeActual), 0)}" height="1" fill="${desyncColor}"/>
                    `;
                }
            }
        }

        template += secLayer;
        template += jobLayer;

        // draw the cursor
        template += `
            <rect x="0" y="0" width="1" height="100%" fill="white" />
        `;

        template += legend;

        this.animationEl.innerHTML = template;
    }
}

/*

questions:

is it possible to adjust svg properties without re-instantiating elements?
    maybe set namespace better?

*/

const legend = `
<g id="Legend" stroke="none" fill="none" fill-rule="evenodd" transform="scale(.5, .5), translate(-1060, 4)">
    <rect id="Rectangle" stroke="#979797" x="0.5" y="0.5" width="213" height="261" fill="black"></rect>
    <g id="Group-1" transform="translate(22.000000, 13.000000)">
        <rect id="Rectangle" fill="cyan" x="0" y="10" width="22" height="22"></rect>
        <text id="Hack" font-family="Courier New" font-size="36" fill="#888">
            <tspan x="42.5" y="30">Hack</tspan>
        </text>
    </g>
    <g id="Group-2" transform="translate(22.000000, 51.333333)">
        <rect id="Rectangle-Copy" fill="lightgreen" x="0" y="10" width="22" height="22"></rect>
        <text id="Grow" font-family="Courier New" font-size="36" fill="#888">
            <tspan x="42.5" y="30">Grow</tspan>
        </text>
    </g>
    <g id="Group-3" transform="translate(22.000000, 89.666667)">
        <rect id="Rectangle-Copy-2" fill="yellow" x="0" y="10" width="22" height="22"></rect>
        <text id="Weaken" font-family="Courier New" font-size="36" fill="#888">
            <tspan x="42.5" y="30">Weaken</tspan>
        </text>
    </g>
    <g id="Group-4" transform="translate(22.000000, 128.000000)">
        <rect id="Rectangle-Copy-3" fill="magenta" x="0" y="10" width="22" height="22"></rect>
        <text id="Desync" font-family="Courier New" font-size="36" fill="#888">
            <tspan x="42.5" y="30">Desync</tspan>
        </text>
    </g>
    <g id="Group-5" transform="translate(22.000000, 169.000000)">
        <rect id="Rectangle-Copy-4" fill="#111" x="0" y="10" width="22" height="22"></rect>
        <text id="Safe" font-family="Courier New" font-size="36" fill="#888">
            <tspan x="42.5" y="30">Safe</tspan>
        </text>
    </g>
    <g id="Group-6" transform="translate(22.000000, 210.000000)">
        <rect id="Rectangle-Copy-5" fill="#333" x="0" y="10" width="22" height="22"></rect>
        <text id="Unsafe" font-family="Courier New" font-size="36" fill="#888">
            <tspan x="42.5" y="30">Unsafe</tspan>
        </text>
    </g>
</g>
`;
