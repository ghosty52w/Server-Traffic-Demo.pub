/*
 * Where the dashboard gets its numbers.
 *
 * - LiveSource: the page is served by server/traffic_server.py, so it polls
 *   /api/snapshot for real measurements.
 * - DemoSource: anywhere else (opened as a file, hosted preview), it falls back
 *   to the simulator. Add ?demo to the URL to force this.
 *
 * Both expose the same small interface to app.js:
 *   live, config, next(), spike(siteId), rush(), isSpiking(siteId), minutesPerSecond
 */
(function () {
  "use strict";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class DemoSource {
    constructor(config) {
      this.live = false;
      this.config = config;
      this.sim = new window.TrafficSimulator(config);
    }
    get minutesPerSecond() { return this.sim.minutesPerSecond; }
    set minutesPerSecond(v) { this.sim.minutesPerSecond = v; }
    async next() { return this.sim.tick(1); }
    spike(siteId) { this.sim.spike(siteId, 6, 15); }
    rush() { this.sim.rush(2.6, 20); }
    isSpiking(siteId) { return this.sim.isSpiking(siteId); }
  }

  class LiveSource {
    constructor(config) {
      this.live = true;
      this.config = config;
      this.minutesPerSecond = 1 / 60; // real time
      this.since = 0;
      this.tests = new Map(); // siteId -> load test end time
    }

    async next() {
      const res = await fetch(`api/snapshot?since=${this.since}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const snap = await res.json();
      this.since = snap.seq;
      return snap;
    }

    /** Real load test: this browser sends requests to the site for a while. */
    spike(siteId, seconds = 15, workers = 4) {
      const site = this.config.servers.flatMap((s) => s.sites).find((s) => s.id === siteId);
      if (!site || this.isSpiking(siteId)) return;
      const until = Date.now() + seconds * 1000;
      this.tests.set(siteId, until);
      const pages = [site.url, `${site.url}style.css`, `${site.url}logo.svg`];
      const run = async (w) => {
        for (let i = 0; Date.now() < until; i++) {
          try {
            const res = await fetch(`${pages[i % pages.length]}?loadtest=${w}-${i}`, { cache: "no-store" });
            await res.arrayBuffer();
          } catch (_) {
            await sleep(250); // server unreachable or overloaded; back off a little
          }
        }
      };
      for (let w = 0; w < workers; w++) run(w);
    }

    rush() {
      for (const site of this.config.servers.flatMap((s) => s.sites)) this.spike(site.id, 15, 2);
    }

    isSpiking(siteId) {
      return (this.tests.get(siteId) || 0) > Date.now();
    }
  }

  window.pickTrafficSource = async function () {
    const forceDemo = new URLSearchParams(location.search).has("demo");
    if (!forceDemo && location.protocol.startsWith("http")) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2500);
        const res = await fetch("api/config", { cache: "no-store", signal: ctrl.signal });
        clearTimeout(timer);
        if (res.ok && (res.headers.get("content-type") || "").includes("json")) {
          const cfg = await res.json();
          if (cfg && cfg.live) return new LiveSource(cfg);
        }
      } catch (_) {
        /* not served by traffic_server.py — use the demo */
      }
    }
    return new DemoSource(window.TRAFFIC_CONFIG);
  };
})();
