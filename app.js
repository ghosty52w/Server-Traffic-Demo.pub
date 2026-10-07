/*
 * Dashboard renderer. Reads a snapshot once per second — from the real server
 * or from the simulator (see live.js) — and animates request dots in between.
 */
(async function () {
  "use strict";

  const source = await window.pickTrafficSource();
  let config = source.config; // live mode replaces it when sites are added or removed
  const LIVE = source.live;

  const SVGNS = "http://www.w3.org/2000/svg";
  const HISTORY_LEN = 120; // points in each server's CPU chart
  const SPARK_LEN = 60; // points in each sparkline
  const LOG_ROWS = 14;
  const LOG_PER_TICK = 5;
  const MAX_PARTICLES = 500;
  const SPIKE_LABEL = ["⚡ Load test", "■ Stop"];

  const STATUS = [
    { label: "Healthy", glyph: "✓", note: "" },
    { label: "Busy", glyph: "!", note: "" },
    { label: "Strained", glyph: "!", note: "Close to its limit — pages are getting slower." },
    { label: "Overloaded", glyph: "✕", note: "CPU is maxed out — pages are slow to load." },
  ];

  /* ---------- small helpers ---------- */

  function build(el, attrs, kids) {
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "class") el.setAttribute("class", v);
        else if (k === "style") el.style.cssText = v;
        else if (k === "text") el.textContent = v;
        else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : v);
      }
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }
  const h = (tag, attrs, ...kids) => build(document.createElement(tag), attrs, kids);
  const s = (tag, attrs, ...kids) => build(document.createElementNS(SVGNS, tag), attrs, kids);
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);

  const na = (v) => v == null;
  const fmt = {
    rps: (v) => (v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString()),
    int: (v) => Math.round(v).toLocaleString(),
    compact: (v) =>
      na(v) ? "n/a" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e4 ? (v / 1e3).toFixed(1) + "K" : Math.round(v).toLocaleString(),
    mbps: (v) => (na(v) ? "n/a" : v < 1 ? Math.round(v * 1000) + " kb/s" : v < 100 ? v.toFixed(1) + " Mb/s" : Math.round(v) + " Mb/s"),
    mb: (v) => (na(v) ? "n/a" : v >= 1024 ? (v / 1024).toFixed(1) + " GB" : Math.round(v) + " MB"),
    ms: (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " s" : v < 10 ? v.toFixed(1) + " ms" : Math.round(v) + " ms"),
    pct: (v) => (na(v) ? "n/a" : v < 10 ? v.toFixed(1) : Math.round(v)) + "%",
    bytes: (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : b >= 1024 ? Math.round(b / 1024) + " KB" : b + " B"),
    link: (mbps) => (mbps >= 1000 ? mbps / 1000 + " Gb/s" : mbps + " Mb/s"),
    clock(minutes, withSeconds) {
      const m = ((minutes % 1440) + 1440) % 1440;
      const hh = String(Math.floor(m / 60)).padStart(2, "0");
      const mm = String(Math.floor(m % 60)).padStart(2, "0");
      if (!withSeconds) return `${hh}:${mm}`;
      const ss = String(Math.floor((m * 60) % 60)).padStart(2, "0");
      return `${hh}:${mm}:${ss}`;
    },
  };

  function level(v, warn, serious, crit) {
    return v >= crit ? 3 : v >= serious ? 2 : v >= warn ? 1 : 0;
  }

  // Health is decided here (not by the data source) so real metrics get the same rules.
  function healthOf(server, snap) {
    const m = {
      cpu: snap.errorRate > 0.01 ? 3 : level(snap.cpu, 65, 85, 97),
      ram: level(snap.ram, 75, 88, 95),
      net: level(snap.net, 70, 85, 95),
      temp: level(snap.temp, server.tempWarn, (server.tempWarn + server.tempCrit) / 2, server.tempCrit),
    };
    m.overall = Math.max(m.cpu, m.ram, m.net, m.temp);
    return m;
  }

  /* ---------- static data ---------- */

  let sites = [];
  let siteById = new Map();
  // Each site keeps its colour while it exists, so adding a site never repaints the others.
  const colorSlots = new Map();

  function indexSites() {
    const ids = new Set(config.servers.flatMap((srv) => srv.sites.map((x) => x.id)));
    for (const id of colorSlots.keys()) if (!ids.has(id)) colorSlots.delete(id);
    sites = [];
    for (const server of config.servers) {
      for (const site of server.sites) {
        site.serverId = server.id;
        if (!colorSlots.has(site.id)) {
          const used = new Set(colorSlots.values());
          let slot = 1;
          while (used.has(slot)) slot++;
          colorSlots.set(site.id, slot);
        }
        // Eight distinct colours; any extra sites share a neutral one rather than repeating a hue.
        const slot = colorSlots.get(site.id);
        site.color = slot <= 8 ? `var(--s${slot})` : "var(--s-other)";
        sites.push(site);
      }
    }
    siteById = new Map(sites.map((x) => [x.id, x]));
  }
  indexSites();

  // A server can report unique visitors itself (one device on three sites is one visitor).
  const visitorsOnline = () =>
    sum([...serverSnap.values()], (srv) => srv.visitors ?? sum(srv.sites, (x) => x.visitors));

  /* ---------- live state ---------- */

  let paused = false;
  let latest = null;
  const siteSnap = new Map();
  const serverSnap = new Map();
  const cpuHistory = new Map();
  const rpsHistory = new Map();
  const series = (map, key) => map.get(key) || map.set(key, []).get(key);
  const totalHistory = [];
  const errorWindow = [];
  let served = 0;
  let servedBase = null; // live: server's request total when the page opened

  function record(snap) {
    latest = snap;
    for (const srv of snap.servers) {
      serverSnap.set(srv.id, srv);
      const point = { clock: snap.clockMinutes, sys: srv.systemCpu, demand: srv.cpuDemand, sites: {} };
      for (const st of srv.sites) {
        siteSnap.set(st.id, st);
        point.sites[st.id] = st.cpu;
        push(series(rpsHistory, st.id), st.rps, SPARK_LEN);
      }
      push(series(cpuHistory, srv.id), point, HISTORY_LEN);
    }
    const all = snap.servers.flatMap((x) => x.sites);
    push(totalHistory, sum(all, (x) => x.rps), SPARK_LEN);
    push(errorWindow, sum(all, (x) => x.rps * x.errorRate), 60);
    if (LIVE) {
      const total = sum(all, (x) => x.total || 0);
      if (servedBase == null) servedBase = total;
      served = total - servedBase;
    } else {
      served += sum(all, (x) => x.rps * (1 - x.errorRate));
    }
  }

  function push(arr, v, max) {
    arr.push(v);
    if (arr.length > max) arr.shift();
  }

  /* ---------- tooltip ---------- */

  const tip = $("tooltip");
  let tipState = null;

  function showTip(fn, x, y) {
    tipState = { fn, x, y };
    renderTip();
  }
  function hideTip() {
    tipState = null;
    tip.hidden = true;
  }
  function renderTip() {
    if (!tipState) return;
    const c = tipState.fn();
    if (!c) return hideTip();
    tip.replaceChildren(
      h("div", { class: "tip-title", text: c.title }),
      c.sub ? h("div", { class: "tip-sub", text: c.sub }) : null,
      ...c.rows.map((r) =>
        h("div", { class: "tip-row" },
          h("span", { class: "tip-key", style: r.color ? `background:${r.color}` : "" }),
          h("strong", { text: r.value }),
          h("span", { text: r.label })
        )
      )
    );
    tip.hidden = false;
    placeTip();
  }
  function placeTip() {
    const { x, y } = tipState;
    const w = tip.offsetWidth, ht = tip.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > innerWidth - 8) left = x - 14 - w;
    if (top + ht > innerHeight - 8) top = y - 14 - ht;
    tip.style.left = clamp(left, 8, innerWidth - w - 8) + "px";
    tip.style.top = clamp(top, 8, innerHeight - ht - 8) + "px";
  }
  function bindTip(el, fn) {
    el.addEventListener("pointerenter", (e) => showTip(fn, e.clientX, e.clientY));
    el.addEventListener("pointermove", (e) => {
      if (!tipState) return;
      tipState.x = e.clientX;
      tipState.y = e.clientY;
      placeTip();
    });
    el.addEventListener("pointerleave", hideTip);
    el.addEventListener("focus", () => {
      const r = el.getBoundingClientRect();
      showTip(fn, r.left + r.width / 2, r.bottom);
    });
    el.addEventListener("blur", hideTip);
  }

  function siteTip(site) {
    return () => {
      const st = siteSnap.get(site.id);
      if (!st) return null;
      const rows = [
        { value: fmt.rps(st.rps), label: "requests / second" },
        { value: fmt.int(st.visitors), label: "visitors online" },
        { value: fmt.pct(st.cpu), label: "of the server's CPU" },
        LIVE
          ? { value: fmt.compact(st.total), label: "requests served in total" }
          : { value: fmt.mb(st.ramMB), label: "memory" },
        { value: fmt.mbps(st.netMbps), label: "bandwidth" },
        { value: fmt.ms(st.latencyMs), label: "response time" },
      ];
      if (st.errorRate > 0) rows.push({ value: fmt.pct(st.errorRate * 100), label: "requests failing", color: "var(--critical)" });
      return { title: site.name, sub: site.domain, rows };
    };
  }

  function serverTip(server) {
    return () => {
      const st = serverSnap.get(server.id);
      if (!st) return null;
      const health = healthOf(server, st);
      return {
        title: `${server.name} · ${STATUS[health.overall].label}`,
        sub: server.hardware,
        rows: [
          { value: fmt.pct(st.cpu), label: "CPU" },
          { value: na(st.ramMB) ? "n/a" : `${fmt.mb(st.ramMB)} / ${fmt.mb(server.ramMB)}`, label: "memory" },
          { value: fmt.mbps(st.netMbps), label: "network out" },
          { value: na(st.temp) ? "n/a" : `${Math.round(st.temp)} °C`, label: "temperature" },
          { value: fmt.rps(sum(st.sites, (x) => x.rps)), label: "requests / second" },
        ],
      };
    };
  }

  /* ---------- hardware icons ---------- */

  const ICONS = {
    pi: () => [
      s("rect", { x: 3, y: 5, width: 18, height: 14, rx: 2 }),
      s("rect", { x: 9, y: 9, width: 6, height: 6, rx: 1 }),
      s("path", { d: "M6 5V3M9 5V3M12 5V3M15 5V3M18 5V3" }),
    ],
    pc: () => [
      s("rect", { x: 6, y: 2.5, width: 12, height: 19, rx: 2 }),
      s("path", { d: "M9 6.5h6M9 9.5h6" }),
      s("circle", { cx: 12, cy: 16, r: 1.6 }),
    ],
    phone: () => [
      s("rect", { x: 7, y: 2.5, width: 10, height: 19, rx: 2 }),
      s("path", { d: "M10.5 18.5h3" }),
    ],
    laptop: () => [
      s("rect", { x: 5, y: 5, width: 14, height: 10, rx: 1.5 }),
      s("path", { d: "M2.5 18.5h19l-1.5-3.5h-16z" }),
    ],
  };
  const hwIcon = (kind) => s("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }, (ICONS[kind] || ICONS.pc)());

  /* ---------- flow diagram ---------- */

  let flow = buildFlow($("flow"));

  function buildFlow(svg) {
    const ROW = 46, GAP = 24, PAD = 22;
    const X = { vis: [12, 168], router: [248, 396], server: [484, 672], site: [758, 988] };

    let y = PAD;
    const siteY = {};
    const box = {};
    for (const server of config.servers) {
      const top = y;
      for (const site of server.sites) {
        siteY[site.id] = y + ROW / 2;
        y += ROW;
      }
      const ht = Math.max(84, y - top - 8);
      const cy = (top + y) / 2;
      box[server.id] = { top: cy - ht / 2, bottom: cy + ht / 2, cy };
      y += GAP;
    }
    const W = 1000;
    const H = Math.max(y - GAP + PAD, 200);
    const cy = H / 2;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

    const curve = (x1, y1, x2, y2) => {
      const mx = (x1 + x2) / 2;
      return [[x1, y1], [mx, y1], [mx, y2], [x2, y2]];
    };
    const path = (c) => `M${c[0]} C${c[1]} ${c[2]} ${c[3]}`;

    const gEdges = s("g");
    const gParticles = s("g");
    const gNodes = s("g");
    svg.replaceChildren(gEdges, gParticles, gNodes);

    const main = curve(X.vis[1], cy, X.router[0], cy);
    const edgeMain = s("path", { class: "edge", d: path(main) });
    gEdges.append(edgeMain);

    const serverCurves = {}, serverEdges = {}, siteCurves = {}, siteEdges = {};
    for (const server of config.servers) {
      const b = box[server.id];
      const c = curve(X.router[1], cy + (b.cy - cy) * 0.12, X.server[0], b.cy);
      serverCurves[server.id] = c;
      serverEdges[server.id] = gEdges.appendChild(s("path", { class: "edge", d: path(c) }));
      for (const site of server.sites) {
        const startY = b.cy + (siteY[site.id] - b.cy) * 0.55;
        const c2 = curve(X.server[1], startY, X.site[0], siteY[site.id]);
        siteCurves[site.id] = c2;
        siteEdges[site.id] = gEdges.appendChild(s("path", { class: "edge", d: path(c2) }));
      }
    }

    const rect = (x0, x1, top, bottom, rx = 12) =>
      s("rect", { class: "node", x: x0, y: top, width: x1 - x0, height: bottom - top, rx });

    // Visitors
    const visValue = s("text", { class: "node-value", x: X.vis[0] + 16, y: cy + 10 });
    const visSub = s("text", { class: "node-sub", x: X.vis[0] + 16, y: cy + 28, text: LIVE ? "real visitors" : "on the internet" });
    const visitorsG = s("g", { class: "node-g", tabindex: 0 },
      rect(X.vis[0], X.vis[1], cy - 46, cy + 46),
      s("g", { class: "node-icon", transform: `translate(${X.vis[1] - 36} ${cy - 34})` },
        s("circle", { cx: 8, cy: 6, r: 3.2 }),
        s("path", { d: "M2 18c0-3.5 2.7-6 6-6s6 2.5 6 6" }),
        s("circle", { cx: 16.5, cy: 7.5, r: 2.5 }),
        s("path", { d: "M15 12.4c3.2-.6 6 1.6 6 5.1" })
      ),
      s("text", { class: "node-title", x: X.vis[0] + 16, y: cy - 14, text: "Visitors" }),
      visValue, visSub
    );
    bindTip(visitorsG, () => ({
      title: "Visitors",
      sub: LIVE ? "Devices that requested a page in the last 5 minutes" : "People on the internet using your sites",
      rows: [
        { value: fmt.int(visitorsOnline()), label: "online now" },
        { value: fmt.rps(totalHistory.at(-1) || 0), label: "requests / second" },
      ],
    }));

    // Router
    const routerValue = s("text", { class: "node-value", x: X.router[0] + 16, y: cy + 10 });
    const routerG = s("g", { class: "node-g", tabindex: 0 },
      rect(X.router[0], X.router[1], cy - 46, cy + 46),
      s("g", { class: "node-icon", transform: `translate(${X.router[1] - 36} ${cy - 34})` },
        s("rect", { x: 2, y: 11, width: 20, height: 8, rx: 2 }),
        s("path", { d: "M7 11 5 4M17 11l2-7M6 15h.01M10 15h.01" })
      ),
      s("text", { class: "node-title", x: X.router[0] + 16, y: cy - 14, text: "Router" }),
      routerValue,
      s("text", { class: "node-sub", x: X.router[0] + 16, y: cy + 28, text: LIVE ? "home Wi-Fi" : "sends by domain" })
    );
    bindTip(routerG, () => ({
      title: LIVE ? "Router" : "Router · reverse proxy",
      sub: LIVE
        ? "Your Wi-Fi router passes each request on to the server"
        : "Looks at the domain name and forwards each request to the right server",
      rows: config.servers.map((srv) => ({
        value: fmt.rps(sum(serverSnap.get(srv.id)?.sites || [], (x) => x.rps)),
        label: `req/s → ${srv.name}`,
      })),
    }));
    gNodes.append(visitorsG, routerG);

    // Servers
    const serverNodes = {};
    for (const server of config.servers) {
      const b = box[server.id];
      const x0 = X.server[0], x1 = X.server[1];
      const value = s("text", { class: "node-value", x: x0 + 14, y: b.cy + 26 });
      const glyph = s("g", { transform: `translate(${x1 - 20} ${b.cy - 18})` },
        s("circle", { class: "glyph-bg", r: 8 }),
        s("text", { class: "glyph-text", y: 3.5, text: "✓" })
      );
      const g = s("g", { class: "node-g server-node", tabindex: 0, "data-level": 0 },
        rect(x0, x1, b.top, b.bottom),
        s("text", { class: "node-title", x: x0 + 14, y: b.cy - 12, text: server.name }),
        s("text", { class: "node-sub", x: x0 + 14, y: b.cy + 6, text: server.hardware }),
        value, glyph
      );
      bindTip(g, serverTip(server));
      gNodes.append(g);
      serverNodes[server.id] = { g, value, glyphText: glyph.lastChild };
    }

    // Sites
    const siteNodes = {};
    for (const site of sites) {
      const yy = siteY[site.id];
      const x0 = X.site[0], x1 = X.site[1];
      const num = s("text", { class: "node-num", x: x1 - 14, y: yy + 4.5, "text-anchor": "end" });
      const g = s("g", { class: "node-g site-node", tabindex: 0 },
        rect(x0, x1, yy - 17, yy + 17, 17),
        s("circle", { cx: x0 + 18, cy: yy, r: 5, style: `fill:${site.color}` }),
        s("text", { class: "node-title", x: x0 + 31, y: yy + 5, text: site.name, style: "font-size:13.5px" }),
        num
      );
      bindTip(g, siteTip(site));
      if (LIVE && site.url) {
        g.style.cursor = "pointer";
        g.addEventListener("click", () => window.open(site.url, "_blank", "noopener"));
      }
      gNodes.append(g);
      siteNodes[site.id] = { g, num };
    }

    return {
      gParticles, main, serverCurves, siteCurves,
      edgeMain, serverEdges, siteEdges,
      visValue, routerValue, serverNodes, siteNodes,
    };
  }

  const edgeWidth = (rps) => Math.min(24, 1.5 + 2.2 * Math.sqrt(Math.max(0, rps)));

  function updateFlow() {
    const total = totalHistory.at(-1) || 0;
    flow.edgeMain.style.strokeWidth = edgeWidth(total);
    flow.visValue.textContent = `${fmt.int(visitorsOnline())} online`;
    flow.routerValue.textContent = `${fmt.rps(total)} req/s`;

    for (const server of config.servers) {
      const st = serverSnap.get(server.id);
      const rps = sum(st.sites, (x) => x.rps);
      const health = healthOf(server, st);
      flow.serverEdges[server.id].style.strokeWidth = edgeWidth(rps);
      const n = flow.serverNodes[server.id];
      n.g.setAttribute("data-level", health.overall);
      n.glyphText.textContent = STATUS[health.overall].glyph;
      n.value.textContent = `CPU ${fmt.pct(st.cpu)} · ${fmt.rps(rps)} req/s`;
    }
    for (const site of sites) {
      const st = siteSnap.get(site.id);
      if (!st) continue;
      flow.siteEdges[site.id].style.strokeWidth = edgeWidth(st.rps);
      const n = flow.siteNodes[site.id];
      n.num.textContent = `${fmt.rps(st.rps)} req/s`;
      n.g.classList.toggle("spiking", source.isSpiking(site.id));
    }
  }

  /* ---------- particles ---------- */

  const particles = [];
  const pool = [];
  const spawnDebt = new Map();
  let dotScale = 1;
  const SCALES = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

  function updateDotScale() {
    const total = totalHistory.at(-1) || 0;
    // Aim for roughly 15–40 dots per second so the picture stays readable.
    let next = dotScale;
    if (total / dotScale > 40) next = SCALES.find((x) => total / x <= 30) || SCALES.at(-1);
    else {
      const smaller = SCALES.filter((x) => x < dotScale && total / x <= 20);
      if (smaller.length) next = smaller.at(-1);
    }
    if (next !== dotScale) {
      dotScale = next;
      $("dotScale").textContent = dotScale === 1 ? "1 dot = 1 request" : `1 dot = ${dotScale} requests`;
    }
  }

  function bez(c, t) {
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
    return [
      a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0],
      a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1],
    ];
  }

  function spawn(site, failed) {
    const el = pool.pop() || s("circle", { class: "particle", r: 4 });
    el.style.fill = site.color;
    el.style.opacity = 1;
    flow.gParticles.append(el);
    particles.push({ site, seg: 0, t: 0, failed, el, jitter: (Math.random() - 0.5) * 6 });
  }

  function stepParticles(dt) {
    if (!latest) return;
    for (const site of sites) {
      const st = siteSnap.get(site.id);
      if (!st) continue;
      let debt = (spawnDebt.get(site.id) || 0) + (st.rps * dt / dotScale) * (0.4 + Math.random() * 1.2);
      debt = Math.min(debt, 4);
      while (debt >= 1 && particles.length < MAX_PARTICLES) {
        debt -= 1;
        spawn(site, Math.random() < st.errorRate);
      }
      spawnDebt.set(site.id, debt);
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      const st = siteSnap.get(p.site.id) || p.site;
      // Last leg slows down when the server is slow to answer.
      const dur = p.seg === 0 ? 0.5 : p.seg === 1 ? 0.55 : p.seg === 2 ? 0.5 * clamp(st.latencyMs / p.site.latencyMs, 1, 6) : 0.7;
      p.t += dt / dur;
      if (p.t >= 1) {
        if (p.seg === 1 && p.failed) {
          p.seg = 3; // rejected: bounce back off the server
          p.t = 0;
          p.el.style.fill = "var(--critical)";
        } else if (p.seg >= 2) {
          p.el.remove();
          pool.push(p.el);
          particles.splice(i, 1);
          continue;
        } else {
          p.seg += 1;
          p.t -= 1;
        }
      }
      let pt;
      if (p.seg === 0) pt = bez(flow.main, p.t);
      else if (p.seg === 1) pt = bez(flow.serverCurves[p.site.serverId], p.t);
      else if (p.seg === 2) pt = bez(flow.siteCurves[p.site.id], p.t);
      else {
        pt = bez(flow.serverCurves[p.site.serverId], 1 - p.t * 0.7);
        p.el.style.opacity = 1 - p.t;
      }
      p.el.setAttribute("cx", pt[0].toFixed(1));
      p.el.setAttribute("cy", (pt[1] + p.jitter).toFixed(1));
    }
  }

  function clearParticles() {
    for (const p of particles) {
      p.el.remove();
      pool.push(p.el);
    }
    particles.length = 0;
  }

  /* ---------- server cards ---------- */

  const serverCards = new Map();
  const serversEl = $("servers");

  function buildCards() {
    serversEl.replaceChildren();
    serverCards.clear();
    for (const server of config.servers) serverCards.set(server.id, buildServerCard(server));
  }
  buildCards();

  function buildServerCard(server) {
    const pill = h("span", { class: "status-pill" },
      h("span", { class: "status-glyph", text: "✓" }),
      h("span", { text: "Healthy" })
    );

    const siteRows = new Map();
    const list = h("ul", { class: "sites" });
    for (const site of server.sites) {
      const stat = (label, withBar) => {
        const dd = h("dd");
        const bar = withBar ? h("i") : null;
        const wrap = h("div", null, h("dt", { text: label }), dd, withBar ? h("span", { class: "bar" }, bar) : null);
        return { wrap, dd, bar };
      };
      const cpu = stat("CPU", true), ram = stat(LIVE ? "Served" : "Memory", true), net = stat("Bandwidth", true),
        lat = stat("Response"), vis = stat("Visitors");
      const spark = s("svg", { class: "spark", "aria-hidden": "true" });
      const rps = h("strong", { text: "0" });
      const btn = h("button", {
        type: "button",
        class: "spike",
        title: LIVE
          ? `Flood ${site.name} with real requests for 15 s, sent from ${server.name} itself and this browser`
          : `Max out ${server.name}'s CPU and send ${site.name} 6× its traffic for 15 s`,
        text: SPIKE_LABEL[0],
        onclick: () => {
          if (source.isSpiking(site.id)) source.stop();
          else source.spike(site.id);
          updateServers();
          updateRushButton();
        },
      });
      const li = h("li", { class: "site", style: `--c:${site.color}` },
        h("span", { class: "dot" }),
        h("div", { class: "site-main" },
          LIVE && site.url
            ? h("a", { class: "site-name", href: site.url, target: "_blank", rel: "noopener", text: site.name })
            : h("div", { class: "site-name", text: site.name }),
          h("div", { class: "site-domain", text: site.domain })
        ),
        spark,
        h("div", { class: "site-rps" }, rps, h("span", { text: "req/s" })),
        btn,
        h("dl", { class: "site-stats" }, cpu.wrap, ram.wrap, net.wrap, lat.wrap, vis.wrap)
      );
      list.append(li);
      siteRows.set(site.id, { li, spark, rps, btn, cpu, ram, net, lat, vis });
    }
    if (!server.sites.length) {
      list.append(h("li", { class: "site-empty", text: "No sites yet. Put a folder in sites/ and it appears here." }));
    }

    const meter = (label) => {
      const value = h("span", { class: "meter-value" });
      const fill = h("div", { class: "meter-fill" });
      const note = h("div", { class: "meter-note" });
      const wrap = h("div", { class: "meter" },
        h("div", { class: "meter-top" }, h("span", { class: "meter-label", text: label }), value),
        h("div", { class: "meter-track" }, fill),
        note
      );
      return { wrap, value, fill, note };
    };
    const meters = { cpu: meter("CPU"), ram: meter("Memory"), net: meter("Network"), temp: meter("Temperature") };

    const alertGlyph = h("span", { class: "status-glyph" });
    const alertText = h("div");
    const alert = h("div", { class: "alert", hidden: true }, alertGlyph, alertText);

    const chartSvg = s("svg", { role: "img", "aria-label": `${server.name} CPU use by site over time` });
    const chartWrap = h("div", { class: "history" }, chartSvg);
    const legend = h("div", { class: "legend" },
      h("span", { style: "--c:var(--system)" }, h("i"), "System"),
      server.sites.map((site) => h("span", { style: `--c:${site.color}` }, h("i"), site.name))
    );

    const card = h("article", { class: "card server", "data-level": 0 },
      h("header", { class: "server-head" },
        h("div", { class: "hw-icon" }, hwIcon(server.kind)),
        h("div", { class: "server-title" },
          h("h2", { text: `${server.name} · ${server.hardware}` }),
          h("p", { text: [
            `${server.cores} cores`,
            na(server.ramMB) ? null : `${fmt.mb(server.ramMB)} RAM`,
            `${fmt.link(server.netMbps)} network`,
          ].filter(Boolean).join(" · ") })
        ),
        pill
      ),
      h("div", { class: "server-body" },
        h("div", { class: "server-col" },
          h("div", { class: "section-label" }, "Sites", h("span", { text: "requests / second · last 60 s" })),
          list
        ),
        h("div", { class: "server-col" },
          h("div", { class: "section-label" }, "How hard it's working", h("span", { text: "right now" })),
          h("div", { class: "meters" }, meters.cpu.wrap, meters.ram.wrap, meters.net.wrap, meters.temp.wrap),
          alert,
          h("div", { class: "section-label" }, "CPU used by each site", h("span", { class: "chart-range", text: "" })),
          h("div", null, chartWrap, legend)
        )
      )
    );
    if (config.servers.length === 1) card.classList.add("solo");
    serversEl.append(card);

    const ref = { card, pill, siteRows, meters, alert, alertGlyph, alertText, chartSvg, chartWrap, hover: null,
      range: card.querySelector(".chart-range") };
    bindHistory(server, ref);
    bindTip(pill, serverTip(server));
    return ref;
  }

  function setLevel(el, lvl) {
    el.setAttribute("data-level", lvl);
  }

  function updateServers() {
    for (const server of config.servers) {
      const ref = serverCards.get(server.id);
      const st = serverSnap.get(server.id);
      if (!st) continue;
      const health = healthOf(server, st);

      setLevel(ref.card, health.overall);
      ref.pill.firstChild.textContent = STATUS[health.overall].glyph;
      ref.pill.lastChild.textContent = STATUS[health.overall].label;

      for (const siteSt of st.sites) {
        const site = siteById.get(siteSt.id);
        const row = ref.siteRows.get(siteSt.id);
        if (!site || !row) continue; // site list is about to refresh
        row.rps.textContent = fmt.rps(siteSt.rps);
        row.cpu.dd.textContent = fmt.pct(siteSt.cpu);
        row.cpu.bar.style.width = clamp(siteSt.cpu, 0, 100) + "%";
        if (LIVE) {
          const serverTotal = Math.max(1, sum(st.sites, (x) => x.total || 0));
          row.ram.dd.textContent = fmt.compact(siteSt.total || 0);
          row.ram.bar.style.width = clamp(((siteSt.total || 0) / serverTotal) * 100, 0, 100) + "%";
        } else {
          row.ram.dd.textContent = fmt.mb(siteSt.ramMB);
          row.ram.bar.style.width = clamp((siteSt.ramMB / server.ramMB) * 100, 0, 100) + "%";
        }
        row.net.dd.textContent = fmt.mbps(siteSt.netMbps);
        row.net.bar.style.width = clamp((siteSt.netMbps / server.netMbps) * 100, 0, 100) + "%";
        row.lat.dd.textContent = fmt.ms(siteSt.latencyMs);
        row.vis.dd.textContent = fmt.int(siteSt.visitors);
        const spiking = source.isSpiking(site.id);
        row.li.classList.toggle("spiking", spiking);
        row.btn.textContent = SPIKE_LABEL[spiking ? 1 : 0];
        drawSpark(row.spark, series(rpsHistory, site.id), site.color);
      }

      const m = ref.meters;
      setLevel(m.cpu.wrap, health.cpu);
      m.cpu.fill.style.width = st.cpu + "%";
      m.cpu.value.replaceChildren(h("b", { text: fmt.pct(st.cpu) }));
      m.cpu.note.textContent = st.cpuDemand > 100
        ? `Needs ${Math.round(st.cpuDemand)}% — more than it has`
        : server.cpuScope === "process"
          ? `Used by the server program · ${server.cores} cores`
          : `${server.cores} cores`;

      setLevel(m.ram.wrap, health.ram);
      if (na(st.ramMB)) {
        m.ram.fill.style.width = "0%";
        m.ram.value.replaceChildren(h("b", { text: "n/a" }));
        m.ram.note.textContent = "This device doesn't share it";
      } else {
        m.ram.fill.style.width = st.ram + "%";
        m.ram.value.replaceChildren(h("b", { text: fmt.mb(st.ramMB) }), ` of ${fmt.mb(server.ramMB)}`);
        m.ram.note.textContent = `${fmt.pct(st.ram)} used`;
      }

      setLevel(m.net.wrap, health.net);
      m.net.fill.style.width = Math.max(st.net, 0.5) + "%";
      m.net.value.replaceChildren(h("b", { text: fmt.mbps(st.netMbps) }));
      m.net.note.textContent = `${fmt.pct(st.net)} of ${fmt.link(server.netMbps)}` +
        (server.netScope === "process" ? " · sent by the server program" : "");

      setLevel(m.temp.wrap, health.temp);
      if (na(st.temp)) {
        m.temp.fill.style.width = "0%";
        m.temp.value.replaceChildren(h("b", { text: "n/a" }));
        m.temp.note.textContent = "No sensor this program can read";
      } else {
        m.temp.fill.style.width = clamp(((st.temp - 20) / (server.tempCrit - 20)) * 100, 0, 100) + "%";
        m.temp.value.replaceChildren(h("b", { text: `${Math.round(st.temp)} °C` }));
        m.temp.note.textContent = server.tempKind === "battery"
          ? `Battery · gets hot above ${server.tempCrit} °C`
          : server.kind === "pi" ? `Slows itself down at ${server.tempCrit} °C` : `Limit ${server.tempCrit} °C`;
      }

      const testing = server.sites.some((x) => source.isSpiking(x.id));
      const test = st.loadTest;
      if (testing || (test && test.note)) {
        const lvl = Math.max(health.overall, testing ? 2 : 1);
        ref.alert.hidden = false;
        setLevel(ref.alertGlyph, lvl);
        ref.alertGlyph.textContent = STATUS[lvl].glyph;
        const left = test && test.remaining ? ` (${Math.ceil(test.remaining)} s left)` : "";
        ref.alertText.textContent = !testing
          ? test.note
          : LIVE
            ? `Load test running — ${fmt.int(sum(st.sites, (x) => x.rps))} real requests per second, ` +
              `sent from ${test && test.generators ? test.generators + " processes on the server" : "this browser"} ` +
              `and served on all ${server.cores} cores${left}.`
            : `Load test running — pushing all ${server.cores} CPU cores to the limit${left}.`;
      } else if (health.overall >= 2) {
        ref.alert.hidden = false;
        setLevel(ref.alertGlyph, health.overall);
        ref.alertGlyph.textContent = STATUS[health.overall].glyph;
        let text = STATUS[health.overall].note;
        if (st.errorRate > 0.01) {
          const top = st.sites.reduce((a, b) => (b.cpu > a.cpu ? b : a));
          text = `Can't keep up — ${fmt.pct(st.errorRate * 100)} of visitors get an error page. ${siteById.get(top.id)?.name || top.id} is using the most CPU.`;
        } else if (health.temp >= 2) {
          text = "Running hot — it may slow itself down to cool off.";
        } else if (health.ram >= 2) {
          text = "Running out of memory.";
        } else if (health.net >= 2) {
          text = "Network connection is nearly full.";
        }
        ref.alertText.textContent = text;
      } else {
        ref.alert.hidden = true;
      }

      drawHistory(server, ref);
    }
  }

  function drawSpark(svg, data, color) {
    const W = 76, H = 26;
    const max = Math.max(1, ...data) * 1.1;
    const n = SPARK_LEN;
    const off = n - data.length;
    const pts = data.map((v, i) => `${(((i + off) / (n - 1)) * W).toFixed(1)},${(H - (v / max) * H).toFixed(1)}`).join(" ");
    let line = svg.firstChild;
    if (!line) {
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      line = svg.appendChild(s("polyline", { fill: "none", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", style: `stroke:${color}` }));
    }
    line.setAttribute("points", pts);
  }

  /* ---------- CPU history chart ---------- */

  const CH = { h: 150, l: 42, r: 6, t: 10, b: 20 };

  function chartGeom(ref) {
    const w = Math.max(200, ref.chartWrap.clientWidth || 360);
    const iw = w - CH.l - CH.r;
    const ih = CH.h - CH.t - CH.b;
    return {
      w, iw, ih,
      x: (i, n) => CH.l + ((i + (HISTORY_LEN - n)) / (HISTORY_LEN - 1)) * iw,
      y: (v) => CH.t + ih - (clamp(v, 0, 100) / 100) * ih,
    };
  }

  function drawHistory(server, ref) {
    const data = series(cpuHistory, server.id);
    const n = data.length;
    if (!n) return;
    const g = chartGeom(ref);
    const svg = ref.chartSvg;
    svg.setAttribute("viewBox", `0 0 ${g.w} ${CH.h}`);

    const kids = [];
    for (const v of [0, 25, 50, 75, 100]) {
      kids.push(s("line", { class: v === 0 ? "base-line" : "grid-line", x1: CH.l, x2: g.w - CH.r, y1: g.y(v), y2: g.y(v) }));
      if (v % 50 === 0) kids.push(s("text", { class: "tick", x: CH.l - 6, y: g.y(v) + 4, "text-anchor": "end", text: v + "%" }));
    }

    const layers = [{ key: null, color: "var(--system)" }, ...server.sites.map((x) => ({ key: x.id, color: x.color }))];
    let base = new Array(n).fill(0);
    for (const layer of layers) {
      const top = data.map((p, i) => base[i] + ((layer.key ? p.sites[layer.key] : p.sys) || 0));
      let d = "M";
      for (let i = 0; i < n; i++) d += `${g.x(i, n).toFixed(1)},${g.y(top[i]).toFixed(1)}L`;
      for (let i = n - 1; i >= 0; i--) d += `${g.x(i, n).toFixed(1)},${g.y(base[i]).toFixed(1)}${i ? "L" : "Z"}`;
      kids.push(s("path", { class: "layer", d, style: `fill:${layer.color}` }));
      base = top;
    }

    // x-axis: clock at the oldest point and now
    if (g.x(0, n) < g.w - CH.r - 90) {
      kids.push(s("text", { class: "tick", x: g.x(0, n), y: CH.h - 4, text: fmt.clock(data[0].clock, LIVE) }));
    }
    kids.push(s("text", { class: "tick", x: g.w - CH.r, y: CH.h - 4, "text-anchor": "end", text: "now" }));

    if (ref.hover != null && ref.hover < n) {
      const x = g.x(ref.hover, n);
      kids.push(s("line", { class: "crosshair", x1: x, x2: x, y1: CH.t, y2: CH.t + g.ih }));
    }
    svg.replaceChildren(...kids);
    ref.range.textContent = `${fmt.clock(data[0].clock, LIVE)} – ${fmt.clock(data[n - 1].clock, LIVE)}${LIVE ? "" : " (simulated)"}`;
  }

  function bindHistory(server, ref) {
    const svg = ref.chartSvg;
    const indexAt = (clientX) => {
      const data = series(cpuHistory, server.id);
      const n = data.length;
      const g = chartGeom(ref);
      const rect = svg.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * g.w;
      const i = Math.round(((px - CH.l) / g.iw) * (HISTORY_LEN - 1)) - (HISTORY_LEN - n);
      return clamp(i, 0, n - 1);
    };
    const tipFn = () => {
      const data = series(cpuHistory, server.id);
      const p = data[ref.hover];
      if (!p) return null;
      const total = p.sys + sum(server.sites, (x) => p.sites[x.id] || 0);
      const rows = server.sites
        .slice()
        .reverse()
        .map((site) => ({ color: site.color, value: fmt.pct(p.sites[site.id] || 0), label: site.name }));
      rows.push({ color: "var(--system)", value: fmt.pct(p.sys), label: "System" });
      return {
        title: `${fmt.pct(total)} CPU`,
        sub: `${fmt.clock(p.clock, LIVE)}${LIVE ? "" : " (simulated)"}${p.demand > 100 ? " · overloaded" : ""}`,
        rows,
      };
    };
    const move = (e) => {
      ref.hover = indexAt(e.clientX);
      drawHistory(server, ref);
      if (tipState && tipState.fn === tipFn) {
        tipState.x = e.clientX;
        tipState.y = e.clientY;
        renderTip();
      } else showTip(tipFn, e.clientX, e.clientY);
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerdown", move);
    svg.addEventListener("pointerleave", () => {
      ref.hover = null;
      drawHistory(server, ref);
      hideTip();
    });
  }

  /* ---------- KPIs ---------- */

  function updateKpis() {
    const all = [...siteSnap.values()];
    const total = totalHistory.at(-1) || 0;
    $("kpiRps").textContent = fmt.rps(total);
    $("kpiVisitors").textContent = fmt.int(visitorsOnline());
    $("kpiNet").textContent = fmt.mbps(sum([...serverSnap.values()], (x) => x.netMbps));
    $("kpiServed").textContent = fmt.compact(served);

    const failed = sum(errorWindow, (x) => x);
    $("kpiErrors").textContent = fmt.int(failed);
    $("kpiErrors").parentElement.setAttribute("data-level", failed >= 1 ? 3 : 0);
    $("kpiErrorsSub").textContent = failed >= 1 ? "last 60 s · a server is overloaded" : "last 60 s · all good";

    const busiest = all.filter((x) => siteById.has(x.id)).reduce((a, b) => (!a || b.rps > a.rps ? b : a), null);
    $("kpiBusiest").textContent = busiest ? siteById.get(busiest.id).name : "–";
    $("kpiBusiestSub").textContent = busiest
      ? `${Math.round((busiest.rps / Math.max(total, 0.001)) * 100)}% of all requests`
      : "no sites yet";

    drawKpiSpark();
  }

  function drawKpiSpark() {
    const svg = $("kpiSpark");
    const W = Math.max(60, svg.clientWidth || 200), H = 48;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const max = Math.max(1, ...totalHistory) * 1.1;
    const off = SPARK_LEN - totalHistory.length;
    const pts = totalHistory.map((v, i) => [((i + off) / (SPARK_LEN - 1)) * W, H - 2 - (v / max) * (H - 6)]);
    const line = pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ");
    const area = `M${pts[0][0]},${H} L${line.replace(/ /g, " L")} L${pts.at(-1)[0]},${H} Z`;
    const end = pts.at(-1);
    svg.replaceChildren(
      s("path", { d: area, style: "fill:var(--accent);fill-opacity:.1" }),
      s("polyline", { points: line, fill: "none", "stroke-width": 2, "stroke-linejoin": "round", style: "stroke:var(--accent)" }),
      s("circle", { cx: end[0], cy: end[1], r: 4, "stroke-width": 2, style: "fill:var(--accent);stroke:var(--surface)" })
    );
  }

  /* ---------- request log ---------- */

  const logBody = $("logBody");
  const logFilter = $("logFilter");
  const logQueue = [];
  function fillLogFilter() {
    const current = logFilter.value;
    while (logFilter.options.length > 2) logFilter.remove(2);
    for (const site of sites) logFilter.append(h("option", { value: site.id, text: site.name }));
    logFilter.value = [...logFilter.options].some((o) => o.value === current) ? current : "all";
  }
  fillLogFilter();
  logFilter.addEventListener("change", () => {
    logQueue.length = 0;
    showLogPlaceholder();
  });

  function showLogPlaceholder() {
    logBody.replaceChildren(h("tr", { class: "log-empty" }, h("td", { colspan: 7, text: "Waiting for requests…" })));
  }
  showLogPlaceholder();

  const STATUS_TEXT = {
    200: "OK", 201: "Created", 301: "Redirect", 304: "Cached", 404: "Not found",
    405: "Not allowed", 500: "Error", 503: "Too busy",
  };

  function queueLog(snap) {
    const f = logFilter.value;
    let list = snap.requests.filter((r) => (f === "all" ? true : f === "errors" ? r.status >= 500 : r.siteId === f));
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    list = list.slice(0, LOG_PER_TICK);
    const now = performance.now();
    const tickStart = snap.clockMinutes - source.minutesPerSecond;
    for (const r of list) {
      r.due = now + r.offset * 1000;
      if (r.clock == null) r.clock = tickStart + r.offset * source.minutesPerSecond;
      logQueue.push(r);
    }
    logQueue.sort((a, b) => a.due - b.due);
  }

  function drainLog(now) {
    while (logQueue.length && logQueue[0].due <= now) addLogRow(logQueue.shift());
  }

  function addLogRow(r) {
    const site = siteById.get(r.siteId);
    if (!site) return; // its folder was removed
    const lvl = r.status >= 500 ? 3 : r.status >= 400 ? 1 : null;
    const statusCell = h("span", { class: "status-cell" },
      lvl != null ? h("span", { class: "status-glyph", "data-level": lvl, text: lvl === 3 ? "✕" : "!" }) : null,
      `${r.status} ${STATUS_TEXT[r.status] || ""}`
    );
    const tr = h("tr", { class: "fresh" + (r.status >= 500 ? " err" : "") },
      h("td", { text: fmt.clock(r.clock, true) }),
      h("td", { class: "mono", text: r.agent === "loadtest" ? "⚡ load test" : r.ip }),
      h("td", null, h("span", { class: "site-cell", style: `--c:${site.color}` }, h("i"), site.name)),
      h("td", { class: "mono path" }, h("span", { class: "method", text: r.method }), r.path),
      h("td", null, statusCell),
      h("td", { class: "num", text: fmt.ms(r.ms) }),
      h("td", { class: "num", text: fmt.bytes(r.bytes) })
    );
    const placeholder = logBody.querySelector(".log-empty");
    if (placeholder) placeholder.remove();
    logBody.prepend(tr);
    while (logBody.children.length > LOG_ROWS) logBody.lastChild.remove();
  }

  /* ---------- controls ---------- */

  const playPause = $("playPause");
  playPause.addEventListener("click", () => {
    paused = !paused;
    playPause.textContent = paused ? "Play" : "Pause";
    if (paused) logQueue.length = 0;
  });

  const anyTesting = () => sites.some((x) => source.isSpiking(x.id));
  function updateRushButton() {
    $("rush").textContent = anyTesting() ? "■ Stop load test" : "Load test all";
  }
  $("rush").addEventListener("click", () => {
    if (anyTesting()) source.stop();
    else source.rush();
    updateRushButton();
    if (latest) {
      updateFlow();
      updateServers();
    }
  });

  for (const btn of document.querySelectorAll(".seg button")) {
    btn.addEventListener("click", () => {
      source.minutesPerSecond = Number(btn.dataset.speed);
      for (const b of document.querySelectorAll(".seg button")) b.setAttribute("aria-pressed", String(b === btn));
    });
  }

  const THEME_KEY = "server-traffic-theme";
  function applyTheme(theme) {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    else document.documentElement.removeAttribute("data-theme");
  }
  try { applyTheme(localStorage.getItem(THEME_KEY)); } catch (_) { /* storage unavailable */ }
  $("theme").addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme")
      || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* storage unavailable */ }
  });

  /* ---------- loops ---------- */

  function render() {
    $("clock").textContent = fmt.clock(latest.clockMinutes);
    updateDotScale();
    updateKpis();
    updateFlow();
    updateServers();
    updateRushButton();
    renderTip();
  }

  // Live mode: a folder was added to or removed from sites/ — rebuild without reloading.
  function applyConfig(next) {
    config = next;
    indexSites();
    hideTip();
    clearParticles();
    flow = buildFlow($("flow"));
    buildCards();
    fillLogFilter();
    for (const id of [...siteSnap.keys()]) if (!siteById.has(id)) siteSnap.delete(id);
  }

  let inFlight = false;
  let failures = 0;
  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      const snap = await source.next();
      if (snap.configChanged) applyConfig(source.config);
      record(snap);
      queueLog(snap);
      render();
      if (failures) setConnection(true);
      failures = 0;
    } catch (err) {
      failures += 1;
      if (failures >= 2) setConnection(false);
    } finally {
      inFlight = false;
    }
  }

  function setConnection(ok) {
    $("modeLabel").textContent = ok ? "Live · real visitors" : "Live · can't reach the server, retrying…";
    document.body.classList.toggle("offline", !ok);
  }

  if (LIVE) {
    // Real data: no pretend controls, and the page explains where numbers come from.
    $("modeLabel").textContent = "Live · real visitors";
    document.body.classList.add("live");
    $("rush").title = "Flood every site with real requests for 15 s";
    $("kpiVisitorsSub").textContent = "devices seen in the last 5 min";
    $("flowHelp").textContent =
      "Each dot is a real request: a device on your network (or the internet) asking for a page. " +
      "Click a site to open it — your visit shows up here. Red dots are requests that failed.";
    $("footNote").textContent =
      `Live data from ${location.host}. Every folder in sites/ on the server is a site.`;
    await tick();
  } else {
    // Warm up so the charts open with two minutes of history ending at the start time.
    const sim = source.sim;
    const startMinutes = sim.clockMinutes;
    sim.clockMinutes = (startMinutes - HISTORY_LEN * sim.minutesPerSecond + 1440) % 1440;
    for (let i = 0; i < HISTORY_LEN; i++) record(sim.tick(1));
    served = 0;
    errorWindow.length = 0;
    render();
  }

  setInterval(() => {
    if (!paused) tick();
  }, 1000);

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!paused) {
      stepParticles(dt);
      drainLog(now);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  new ResizeObserver(() => {
    if (latest) for (const server of config.servers) drawHistory(server, serverCards.get(server.id));
  }).observe(serversEl);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearParticles();
  });
})();
