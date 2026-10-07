/*
 * Where the dashboard gets its numbers.
 *
 * - LiveSource: the page is served by server/traffic_server.py, so it polls
 *   /api/snapshot for real measurements.
 * - DemoSource: anywhere else (opened as a file, hosted preview), it falls back
 *   to the simulator. Add ?demo to the URL to force this.
 *
 * Both expose the same small interface to app.js:
 *   live, config, next(), spike(siteId), rush(), stop(), isSpiking(siteId), minutesPerSecond
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
    rush() { this.sim.rush(2.6, 15); }
    stop() { this.sim.stop(); }
    isSpiking(siteId) { return this.sim.isSpiking(siteId); }
  }

  class LiveSource {
    constructor(config) {
      this.live = true;
      this.config = config;
      this.minutesPerSecond = 1 / 60; // real time
      this.since = 0;
      this.lastSnap = null;
      this.tests = new Map(); // siteId -> end of the browser's request loop
    }

    async next() {
      const res = await fetch(`api/snapshot?since=${this.since}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const snap = await res.json();
      this.since = snap.seq;
      // A folder was added to or removed from sites/: fetch the new site list.
      if (snap.sitesVersion !== this.config.sitesVersion) {
        const cfg = await fetch("api/config", { cache: "no-store" });
        if (cfg.ok) {
          this.config = await cfg.json();
          snap.configChanged = true;
        }
      }
      this.lastSnap = snap;
      return snap;
    }

    get sites() {
      return this.config.servers.flatMap((s) => s.sites);
    }

    /**
     * Load test: the server floods the site with real HTTP requests from one
     * process per core, and this browser sends real requests too.
     */
    spike(siteId) {
      this.startTest([siteId]);
    }

    rush() {
      this.startTest(this.sites.map((s) => s.id));
    }

    startTest(ids, seconds = 15) {
      const query = `sites=${ids.map(encodeURIComponent).join(",")}&seconds=${seconds}`;
      fetch(`api/loadtest?${query}`, { method: "POST" }).catch(() => {});
      const until = Date.now() + seconds * 1000;
      const workersPerSite = Math.max(1, Math.floor(4 / ids.length));
      for (const id of ids) {
        const site = this.sites.find((s) => s.id === id);
        if (!site) continue;
        this.tests.set(id, until);
        for (let w = 0; w < workersPerSite; w++) this.requestLoop(site, w);
      }
    }

    async requestLoop(site, w) {
      for (let i = 0; (this.tests.get(site.id) || 0) > Date.now(); i++) {
        try {
          const sep = site.url.includes("?") ? "&" : "?";
          const res = await fetch(`${site.url}${sep}loadtest=${w}-${i}`, { cache: "no-store" });
          await res.arrayBuffer();
        } catch (_) {
          await sleep(250); // server unreachable or overloaded; back off a little
        }
      }
    }

    /** Stops the load test (one load test runs at a time, covering all its sites). */
    stop() {
      fetch("api/loadtest?seconds=0", { method: "POST" }).catch(() => {});
      this.tests.clear();
      if (this.lastSnap) for (const s of this.lastSnap.servers) if (s.loadTest) s.loadTest.sites = [];
    }

    isSpiking(siteId) {
      if ((this.tests.get(siteId) || 0) > Date.now()) return true;
      return !!this.lastSnap && this.lastSnap.servers.some((s) => s.loadTest && s.loadTest.sites.includes(siteId));
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
