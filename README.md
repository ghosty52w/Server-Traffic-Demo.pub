# Server Traffic — demo dashboard

A live dashboard for a small self-hosted setup. You can see visitors' requests flowing to each site,
what each site uses, and how hard each server is working.

All traffic is **simulated** for now. The page is built so the fake data source can be swapped for
real metrics later.

```
Visitors ──► Router ──► Server 1 (Raspberry Pi 4) ──► Chess · School · Restaurant
                    ├─► Server 2 (Desktop PC)      ──► Checkers · Photo Gallery · Game API
                    └─► Server 3 (Old laptop)      ──► Blog · Minecraft Map
```

## Running it

Open `index.html` in a browser. It has no build step, no dependencies and no server.

To serve it on your network instead (for example from the Pi):

```sh
python3 -m http.server 8080
# then open http://<pi-address>:8080
```

## What's on the page

| Section | What it shows |
| --- | --- |
| **Totals** | Requests per second, visitors online, bandwidth out, requests served, failed requests, busiest site |
| **Live traffic** | Animated map: every dot is a request going visitor → router → server → site. Line thickness shows traffic. A request the server is too busy to answer turns red and bounces back. |
| **Server cards** | One per server. For each **site**: requests/s (with a 60 s sparkline), CPU, memory, bandwidth, response time and visitors. Under that, **how hard the server is working**: CPU, memory, network and temperature meters, plus a stacked chart of CPU used by each site. |
| **Request log** | A sample of individual requests (visitor IP, site, path, status, time taken, size). You can filter it by site or show errors only. |

Each server gets a status: **Healthy → Busy → Strained → Overloaded**, decided by CPU, memory, network,
temperature and failed requests (`healthOf()` in `app.js`).

### Things to try

- **⚡ Spike** on a site sends it 6× its normal traffic for 15 s, as if it went viral. Spike *Chess*
  and the Raspberry Pi overloads: CPU hits 100%, response times climb, red dots bounce and the log
  fills with `503 Too busy`. Spike *Checkers* and the desktop PC barely notices.
- **Rush hour** makes every site about 2.5× busier at once.
- **Clock speed** speeds up the simulated day. Traffic follows daily patterns: the restaurant gets
  busy at lunch and dinner, the school site during school hours, and the game sites in the evening.
- Hover over a node in the map, a status pill, or a CPU chart to see the exact numbers.
- The moon button switches between light and dark mode.

## Files

| File | Purpose |
| --- | --- |
| `config.js` | **Your servers and sites.** Edit this to add a server, rename a site, change specs. |
| `simulator.js` | Fake traffic generator. Outputs one snapshot per second. |
| `app.js` | Draws everything from those snapshots. It doesn't know the data is fake. |
| `styles.css` | Styles, light and dark themes. |

Up to 8 sites get their own colour. Any site after the 8th is drawn in a neutral grey.

## Using real data later

`app.js` only needs a **snapshot** every second in this shape (documented at the top of
`simulator.js`):

```js
{
  clockMinutes: 692,               // time of day in minutes
  servers: [{
    id: "pi",
    cpu: 48.2,                     // % of the whole machine
    cpuDemand: 48.2,               // same as cpu unless overloaded
    systemCpu: 4,                  // OS / background use
    ramMB: 1510, ram: 36.9,        // used MB and %
    netMbps: 21.4, net: 21.4,      // outbound Mb/s and % of link
    temp: 51.0,                    // °C
    errorRate: 0,                  // 0..1 share of requests failing
    sites: [{ id: "chess", rps: 6.3, visitors: 57, netMbps: 2.3,
              cpu: 15, ramMB: 298, latencyMs: 41, errorRate: 0 }]
  }],
  requests: [{ siteId, serverId, ip, method, path, status, ms, bytes, offset }]
}
```

Possible approaches for the real thing:

1. **Per-site traffic.** Run all sites behind one reverse proxy (nginx, Caddy or Traefik) that
   writes JSON access logs. A small script tails the log and counts requests/s, bytes and response
   time per `Host`.
2. **Per-server load.** On each machine, read CPU, memory, network and temperature from
   `/proc` and `/sys/class/thermal` (or use `node_exporter`/Prometheus).
3. **Per-site CPU and memory.** Run each site in its own Docker container and use
   `docker stats`, or use systemd service cgroups.
4. Expose the combined snapshot at `/api/snapshot`, or push it over a WebSocket. Then, in
   `app.js`, replace `sim.tick(1)` with the fetched snapshot.
