# Server Traffic — demo dashboard

A live dashboard for a small self-hosted setup. You can see visitors' requests flowing to each site,
what each site uses, and how hard each server is working.

It runs in two modes:

- **Live:** `server/traffic_server.py` hosts your sites, records every real request and measures the
  machine. The dashboard it serves shows real traffic.
- **Demo:** open `index.html` anywhere else and it uses simulated traffic (three made-up servers).
  Add `?demo` to a live URL to force the demo.

```
Visitors ──► Router ──► Server 1 (Raspberry Pi 4) ──► Chess · School · Restaurant
                    ├─► Server 2 (Desktop PC)      ──► Checkers · Photo Gallery · Game API
                    └─► Server 3 (Old laptop)      ──► Blog · Minecraft Map
```

## Run it for real on an Android phone (Termux)

1. Install **Termux** from F-Droid or GitHub (the Play Store version is outdated). Open it, or SSH into
   it (`ssh -p 8022 <phone-ip>`), then run:

   ```sh
   pkg update && pkg install -y python git
   git clone -b claude/traffic-dashboard-demo-kbd1za https://github.com/ghosty52w/Server-Traffic-Demo.pub.git
   cd Server-Traffic-Demo.pub
   termux-wake-lock          # stops Android pausing Termux when the screen turns off
   python server/traffic_server.py
   ```

2. It prints the addresses, for example:

   ```
     Dashboard   http://192.168.1.119:8080/
     Chess       http://192.168.1.119:8080/chess/
     School      http://192.168.1.119:8080/school/
     Restaurant  http://192.168.1.119:8080/restaurant/
   ```

3. Open the dashboard on any device on the same Wi-Fi. Then open a site on another device, or click
   a site in the dashboard: each page load shows up as dots, numbers and log rows within about a second.
   **⚡ Load test** makes your browser send real requests to a site for 15 seconds.

To keep it running after you close the SSH session:

```sh
nohup python server/traffic_server.py > traffic.log 2>&1 &
```

Optional: install the **Termux:API** app and `pkg install termux-api` to get the battery temperature.

The same command works on a Raspberry Pi or PC (`python3 server/traffic_server.py`). There it can
also read whole-machine CPU, memory, network and temperature.

### Your own sites

Sites are folders of static files listed in `server/sites.json`:

```json
{ "id": "chess", "name": "Chess", "root": "../sites/chess" }
```

Each site is served at `/<id>/`. If you give a site a `"domain"` and point that domain at the phone,
requests for that domain are served at its root too. Up to 8 sites get their own colour.

### What's real and what Android hides

| Number | Where it comes from |
| --- | --- |
| Requests/s, response time, errors, bandwidth per site | Every request the server handles |
| CPU per site | CPU time spent handling that site's requests |
| Visitors | Unique IP addresses seen in the last 5 minutes |
| Server CPU | Whole device if `/proc/stat` is readable. Android blocks that for apps, so on a phone it's the CPU used by the server program. |
| Memory | `/proc/meminfo`, shown as "n/a" if blocked. Sites share one program, so memory isn't split per site; the site rows show total requests served instead. |
| Network | Whole device if readable, otherwise bytes sent by the server program |
| Temperature | Battery or CPU sensor if readable, or Termux:API. Otherwise "n/a". |

The startup message says which of these your device allows.

## Demo mode

Open `index.html` directly in a browser. There's no build step and nothing to install.

## What's on the page

| Section | What it shows |
| --- | --- |
| **Totals** | Requests per second, visitors online, bandwidth out, requests served, failed requests, busiest site |
| **Live traffic** | Animated map: every dot is a request going visitor → router → server → site. Line thickness shows traffic. A request the server is too busy to answer turns red and bounces back. |
| **Server cards** | One per server. For each **site**: requests/s (with a 60 s sparkline), CPU, memory, bandwidth, response time and visitors. Under that, **how hard the server is working**: CPU, memory, network and temperature meters, plus a stacked chart of CPU used by each site. |
| **Request log** | A sample of individual requests (visitor IP, site, path, status, time taken, size). You can filter it by site or show errors only. |

Each server gets a status: **Healthy → Busy → Strained → Overloaded**, decided by CPU, memory, network,
temperature and failed requests (`healthOf()` in `app.js`).

### Things to try (demo mode)

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
| `server/traffic_server.py` | **Live mode.** Hosts the sites, records requests, measures the device, serves the dashboard and `/api/snapshot`. Python standard library only. |
| `server/sites.json` | The live server's name and its sites |
| `sites/` | Three small example sites (chess, school, restaurant) |
| `live.js` | Picks live or demo data and runs load tests |
| `config.js` | Servers and sites for **demo mode** |
| `simulator.js` | Fake traffic generator for demo mode. Outputs one snapshot per second. |
| `app.js` | Draws everything from the snapshots, whichever mode they come from |
| `styles.css` | Styles, light and dark themes. |

## Snapshot format

Both modes produce the same snapshot once a second (`GET /api/snapshot?since=<seq>` in live mode).
Anything that sends this shape can drive the dashboard:

```js
{
  clockMinutes: 692,               // time of day in minutes
  seq: 1234,                       // id of the newest request in the log
  servers: [{
    id: "phone",
    cpu: 12.5, cpuDemand: 12.5,    // % of the whole machine
    systemCpu: 3,                  // CPU not spent on site requests
    ramMB: 1510, ram: 36.9,        // used MB and %, or null
    netMbps: 2.4, net: 2.4,        // outbound Mb/s and % of link
    temp: 31.0,                    // °C, or null
    visitors: 3,                   // unique visitors across all sites
    errorRate: 0,                  // 0..1 share of requests failing
    sites: [{ id: "chess", rps: 6.3, visitors: 2, netMbps: 0.3, cpu: 1.2,
              ramMB: null, latencyMs: 2.1, errorRate: 0, total: 812 }]
  }],
  requests: [{ siteId, ip, method, path, status, ms, bytes, clock, offset }]
}
```

To show several machines (phone + Pi + PC) on one dashboard, run the server on each one and merge
their snapshots. That's the natural next step.
