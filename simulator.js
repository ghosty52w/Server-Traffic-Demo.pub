/*
 * Fake traffic source.
 *
 * Produces one "snapshot" per tick in the same shape a real metrics backend
 * would send (see README → "Using real data"). Swap this file for something
 * that fetches the snapshot from your servers and the dashboard keeps working.
 *
 * Snapshot shape:
 * {
 *   clockMinutes,                // simulated time of day, 0..1440
 *   servers: [{
 *     id, cpu, cpuDemand, systemCpu, ramMB, ram, netMbps, net, temp, errorRate,
 *     sites: [{ id, rps, visitors, netMbps, cpu, ramMB, latencyMs, errorRate }]
 *   }],
 *   requests: [{ siteId, serverId, ip, method, path, status, ms, bytes, offset }]
 * }
 */
(function () {
  "use strict";

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function gauss() {
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function poisson(lambda) {
    if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss()));
    const limit = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= Math.random(); } while (p > limit);
    return k - 1;
  }

  function curveAt(curve, hour) {
    const i = Math.floor(hour) % 24;
    const f = hour - Math.floor(hour);
    return curve[i] * (1 - f) + curve[(i + 1) % 24] * f;
  }

  // Documentation-only IP ranges (RFC 5737), so no real address ever shows up.
  const IP_PREFIXES = ["203.0.113.", "198.51.100.", "192.0.2."];
  const returning = [];
  function visitorIp() {
    if (returning.length > 40 && Math.random() < 0.55) {
      return returning[Math.floor(Math.random() * returning.length)];
    }
    const ip = IP_PREFIXES[Math.floor(Math.random() * IP_PREFIXES.length)] + Math.floor(rand(2, 254));
    returning.push(ip);
    if (returning.length > 120) returning.shift();
    return ip;
  }

  class TrafficSimulator {
    constructor(config) {
      this.config = config;
      this.clockMinutes = (config.startHour || 12) * 60;
      this.minutesPerSecond = 1;
      this.elapsed = 0;
      this.sites = new Map();
      this.servers = new Map();

      for (const server of config.servers) {
        this.servers.set(server.id, { temp: server.tempIdle });
        for (const site of server.sites) {
          const start = site.baseRps * curveAt(site.curve, this.clockMinutes / 60);
          this.sites.set(site.id, {
            rps: start,
            noise: 1,
            burst: 1,
            boost: 1,
            boostTarget: 1,
            boostUntil: 0,
          });
        }
      }
    }

    /**
     * Load test: multiply one site's traffic for a while. Its server also burns
     * CPU until it is at 100%, like the real load test does.
     */
    spike(siteId, multiplier = 5, seconds = 15) {
      const s = this.sites.get(siteId);
      if (!s) return;
      s.boostTarget = multiplier;
      s.boostUntil = this.elapsed + seconds;
    }

    /** Load test every site, so every server is pushed to its limit. */
    rush(multiplier = 2.6, seconds = 15) {
      for (const id of this.sites.keys()) this.spike(id, multiplier, seconds);
    }

    /** End the load test on one site, or on all of them. */
    stop(siteId) {
      for (const [id, s] of this.sites) if (!siteId || id === siteId) s.boostUntil = 0;
    }

    isSpiking(siteId) {
      const s = this.sites.get(siteId);
      return !!s && this.elapsed < s.boostUntil;
    }

    tick(dt = 1) {
      this.elapsed += dt;
      this.clockMinutes = (this.clockMinutes + dt * this.minutesPerSecond) % 1440;
      const hour = this.clockMinutes / 60;
      const requests = [];

      const servers = this.config.servers.map((server) => {
        const srvState = this.servers.get(server.id);

        // 1. How much traffic does each site want right now?
        const demand = server.sites.map((site) => {
          const s = this.sites.get(site.id);
          const target = this.elapsed < s.boostUntil ? s.boostTarget : 1;
          s.boost += (target - s.boost) * 0.35;
          s.noise = clamp(s.noise + (1 - s.noise) * 0.08 + gauss() * 0.035, 0.7, 1.4);
          if (Math.random() < 0.012) s.burst = rand(1.3, 1.9); // small random bursts
          s.burst += (1 - s.burst) * 0.18;
          const want = site.baseRps * curveAt(site.curve, hour) * s.noise * s.burst * s.boost;
          s.rps += (want - s.rps) * 0.5;
          const cpu = (s.rps * site.cpuMsPerReq) / (server.cores * 10); // % of the whole server
          return { site, rps: s.rps, cpu };
        });

        // 2. A load test burns CPU on top of its traffic until the server is maxed out.
        let cpuDemand = server.idleCpu + demand.reduce((sum, d) => sum + d.cpu, 0);
        const testing = demand.filter((d) => this.elapsed < this.sites.get(d.site.id).boostUntil);
        if (testing.length && cpuDemand < 100) {
          const extra = (100 - cpuDemand) / testing.length;
          for (const d of testing) d.cpu += extra;
          cpuDemand = 100;
        }

        // 3. Can the server keep up?
        const overloaded = cpuDemand > 100;
        const served = overloaded ? 100 / cpuDemand : 1;
        const errorRate = overloaded ? 1 - served : 0;
        const u = Math.min(cpuDemand, 100) / 100;
        const slowdown = overloaded
          ? Math.min(30, 3.5 * Math.pow(cpuDemand / 100, 4))
          : 1 + 2.5 * Math.pow(u, 4);

        let ramMB = server.idleRamMB;
        let netMbps = 0;

        const sites = demand.map(({ site, rps, cpu }) => {
          const siteRam = site.ramBaseMB + rps * site.ramPerRpsMB * (overloaded ? 1.4 : 1);
          const siteNet = (rps * served * site.kbPerReq * 8) / 1000;
          ramMB += siteRam;
          netMbps += siteNet;

          const latencyMs = site.latencyMs * slowdown;
          this._sampleRequests(requests, server, site, rps * dt, latencyMs, errorRate);

          return {
            id: site.id,
            rps,
            visitors: Math.round(rps * site.visitorsPerRps),
            netMbps: siteNet,
            cpu: cpu * served,
            ramMB: siteRam,
            latencyMs,
            errorRate,
          };
        });

        ramMB = Math.min(ramMB, server.ramMB * 0.98);
        const cpu = Math.min(100, cpuDemand);
        const tempTarget = server.tempIdle + (server.tempMax - server.tempIdle) * (cpu / 100);
        srvState.temp += (tempTarget - srvState.temp) * 0.12;

        const ram = (ramMB / server.ramMB) * 100;
        const net = Math.min(100, (netMbps / server.netMbps) * 100);
        return {
          id: server.id,
          cpu,
          cpuDemand,
          systemCpu: server.idleCpu * served,
          ramMB,
          ram,
          netMbps,
          net,
          temp: srvState.temp,
          errorRate,
          sites,
        };
      });

      return { clockMinutes: this.clockMinutes, servers, requests };
    }

    // Generate a handful of individual requests for the live log.
    _sampleRequests(out, server, site, expected, latencyMs, errorRate) {
      const count = poisson(expected);
      const keep = Math.min(count, 3);
      for (let i = 0; i < keep; i++) {
        const [method, path] = site.paths[Math.floor(Math.random() * site.paths.length)].split(" ");
        let status = 200;
        const r = Math.random();
        if (r < errorRate) status = 503;
        else if (r < errorRate + 0.015) status = 404;
        else if (method === "GET" && r < errorRate + 0.1) status = 304;
        else if (method === "POST" && r < errorRate + 0.3) status = 201;

        const ms = status === 503
          ? Math.round(rand(2, 8) * 1000) // timed out waiting
          : Math.max(1, Math.round(latencyMs * Math.exp(gauss() * 0.35)));
        const bytes = status === 304 || status === 503
          ? Math.round(rand(150, 400))
          : Math.round(site.kbPerReq * 1024 * rand(0.3, 1.8));

        out.push({
          siteId: site.id,
          serverId: server.id,
          ip: visitorIp(),
          method,
          path,
          status,
          ms,
          bytes,
          offset: Math.random(),
        });
      }
    }
  }

  window.TrafficSimulator = TrafficSimulator;
})();
