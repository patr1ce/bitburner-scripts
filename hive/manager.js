import { getThreadPool } from "/hive/worker";
import { ServerModel } from "/hive/planner";

/*

-> create a dashboard showing target information
    - number of jobs dispatched
    - number of jobs pending?
    - cycle duration
    - latestEndTime
    - latestStartTime

Then the general process for a target is:
    sleep until nextStartTime-ε
    plan a batch:
        if money is high: hack
        while sec is high: weaken
        while money is low: grow
        while sec is high: weaken
    (This can result in the typical prep WGW and typical batch HWGW, but also HGHGHGW)
*/



const t0_by_target = {};
const next_start_by_target = {};

const FLAGS = [
    ["help", false],
    ["port", 1],
    ["moneyPercent", 0.05],
    ["tDelta", 200]
];

/** @param {NS} ns **/
export async function main(ns) {
    ns.disableLog("asleep");
    ns.clearLog();

    const flags = ns.flags(FLAGS);
    const {moneyPercent, tDelta} = flags;
    const targets = flags._;
    const target = targets[0];

    delete t0_by_target[target];

    if (flags.help || targets.length == 0) {
        ns.tprint("manage hacking a target");
        return;
    }

    const threadPool = await getThreadPool(ns, flags.port);

    const batch = planHWGW({ns, target, moneyPercent, tDelta})

    await threadPool.dispatchJobs(batch);

    ns.print("batch:", JSON.stringify(batch, null, 2));
    ns.tail();
}


export function planHWGW(params) {
    const {ns, target, moneyPercent, tDelta} = params;

    const batch = [];

    if (t0_by_target[target] === undefined) {
        const w0Job = planWeaken(params);
        batch.push(w0Job);
        t0_by_target[target] = Date.now() + w0Job.duration;
    }
    const t0 = t0_by_target[target];

    // given an initial hack percentage and thread pool,
    // maintain a virtual server object,
    // and keep adding viable WGW jobs until it reaches equilibrium. (same as prep)
    // to check if a step is viable, need to know the max threads available in the pool,
    // or maintain an exclusion list.

    const hJob  = planHack({  ...params, endTime: t0 + 1*tDelta, security:0 });
    const w1Job = planWeaken({...params, endTime: t0 + 2*tDelta, security:hJob.security*1.1 });
    const gJob  = planGrow({  ...params, endTime: t0 + 3*tDelta, security:0, moneyPercent: hJob.moneyMult*0.95});
    const w2Job = planWeaken({...params, endTime: t0 + 4*tDelta, security:gJob.security*1.1 });

    batch.push(hJob, w1Job, gJob, w2Job);

    for (const job of batch) {
        job.args.push({threads: job.threads});
        // TODO: set {stock: true} for grow jobs if we hold a long position
        //       set {stock: true} for hack jobs if we hold a short position
    }

    t0_by_target[target] = w2Job.endTime + tDelta;
    next_start_by_target[target] = w1Job.startTime + 5 * tDelta;
    const threadsUsed = hJob.threads + w1Job.threads + gJob.threads + w2Job.threads;

    return batch;
}
