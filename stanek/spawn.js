import { ServerPool } from "net/server-pool.js";

export function autocomplete(data) {
    return data.servers;
}

/** @param {NS} ns **/
export async function main(ns) {
    const fragments = ns.stanek.activeFragments();
    if (fragments.length == 0) {
        ns.tprint("No fragments to charge. Exiting.");
        return;
    }
    const xy = [];
    for (const fragment of fragments) {
        if (fragment.limit == 1) {
            xy.push(fragment.x);
            xy.push(fragment.y);
        }
    }

    const host = ns.args[0];
    const reservedRam = ns.args[1] || 0;
    const script = "/stanek/charge-x-y.js";
    const args = xy;

    await new ServerPool(ns, script, 2).runMaxThreads({host, script, args, reservedRam});
}
