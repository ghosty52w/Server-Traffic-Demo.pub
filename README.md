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
   git clone -b claude/traffic-dashboard-demo-kbd1za https://github.com/ghosty52w/Server-Traffic-Demo.pub.git traffic
   cd traffic
   termux-wake-lock          # stops Android pausing Termux when the screen turns off
   python server/traffic_server.py
   ```

2. Put your sites in `traffic/sites/`, one folder per site (see below). For example, from your computer:

   ```sh
   scp -P 8022 -r ~/path/to/chess-trainer 192.168.1.119:traffic/sites/chessr
   ```

3. The server prints the addresses, for example:

   ```
     traffic        http://192.168.1.119:8080/   (this dashboard)
     chessr         http://192.168.1.119:8080/chessr/
   ```

   Open the dashboard on any device on the same Wi-Fi. Each page load on any site shows up as dots,
   numbers and log rows within about a second.

To keep it running after you close the SSH session:

```sh
nohup python server/traffic_server.py > traffic.log 2>&1 &
```

Optional: install the **Termux:API** app and `pkg install termux-api` to get the battery temperature.

The same command works on a Raspberry Pi or PC (`python3 server/traffic_server.py`). There it can
also read whole-machine CPU, memory, network and temperature.

### Sites = folders

Every folder in `sites/` is a site, named after the folder:

| Folder | Shown as | Address |
| --- | --- | --- |
| `sites/chessr/` | chessr | `http://<phone-ip>:8080/chessr/` |
| *(the dashboard itself)* | traffic | `http://<phone-ip>:8080/` |

- Add, rename or delete a folder while the server runs and the dashboard updates within a second,
  with no restart or reload. The terminal prints `+ site added` / `- site removed`.
- If a folder has no `index.html` but has a built app in `dist/`, `build/`, `public/` or `www/`, that
  folder is served. Apps built to load files from `/assets/...` and apps with their own page routes
  (like `/chessr/lesson/3`) work too.
- Sites are static files (HTML, CSS, JavaScript, images). An app that needs its own backend server
  (Node, Flask, a database) has to be built to static files first.
- **traffic** is the dashboard's own traffic: page loads plus the once-a-second data polling from each
  open dashboard.
- The server's name and specs are in `server/server.json`. Up to 8 sites get their own colour.

### Load test

**⚡ Load test** on a site (or **Load test all**) pushes the server to its CPU limit for 15 seconds:

- The server starts one CPU-burning worker process per core, so every core runs at 100%.
- At the same time your browser keeps requesting the site, so you can see how slow it gets under full load.
- Click **■ Stop** to end it early. It also stops by itself after 15 s (60 s at most), when the server
  is stopped, or when the temperature reaches the limit shown on the Temperature meter (if the device
  has a readable sensor).

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

- **⚡ Load test** on a site maxes out its server's CPU and sends the site 6× its normal traffic for
  15 s. On the Raspberry Pi the extra traffic is more than it can handle: response times climb, red
  dots bounce and the log fills with `503 Too busy`.
- **Load test all** does the same to every site, so all three servers hit 100% CPU.
- **Clock speed** speeds up the simulated day. Traffic follows daily patterns: the restaurant gets
  busy at lunch and dinner, the school site during school hours, and the game sites in the evening.
- Hover over a node in the map, a status pill, or a CPU chart to see the exact numbers.
- The moon button switches between light and dark mode.

## Files

| File | Purpose |
| --- | --- |
| `server/traffic_server.py` | **Live mode.** Hosts the sites, records requests, measures the device, serves the dashboard and `/api/snapshot`. Python standard library only. |
| `server/server.json` | The live server's name and specs |
| `sites/` | **Your sites**: every folder in here is hosted and shown on the dashboard |
| `live.js` | Picks live or demo data, starts and stops load tests, picks up site changes |
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
