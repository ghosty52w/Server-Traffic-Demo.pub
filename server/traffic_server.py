#!/usr/bin/env python3
"""
Real traffic server for the dashboard.

Hosts the sites listed in server/sites.json, records every request they get,
measures the machine it runs on, and serves the dashboard with live numbers.

    python3 server/traffic_server.py            # port 8080
    python3 server/traffic_server.py --port 9000

Then open http://<this-device's-ip>:8080/ from any device on the same network.
Only the Python standard library is used, so it runs as-is in Termux on Android,
on a Raspberry Pi, or on a PC.
"""
import argparse
import email.utils
import glob
import json
import mimetypes
import os
import shutil
import socket
import subprocess
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

DASHBOARD_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/styles.css": "styles.css",
    "/app.js": "app.js",
    "/live.js": "live.js",
    "/config.js": "config.js",
    "/simulator.js": "simulator.js",
}

RATE_WINDOW = 3.0  # seconds of requests averaged into "per second" numbers
VISITOR_WINDOW = 300.0  # an IP counts as "online" for 5 minutes after its last request
LOG_SIZE = 400


# ---------------------------------------------------------------- measuring the device

def read_proc_stat():
    """Whole-device CPU counters. Android blocks this for apps, so it may be None."""
    try:
        with open("/proc/stat") as f:
            parts = f.readline().split()
        values = [int(v) for v in parts[1:9]]
        return sum(values), values[3] + values[4]  # total, idle + iowait
    except (OSError, ValueError, IndexError):
        return None


def process_cpu_seconds():
    t = os.times()
    return t.user + t.system


def read_net_tx_bytes():
    """Bytes sent on all real interfaces, or None if the device hides it."""
    try:
        total = 0
        with open("/proc/net/dev") as f:
            for line in f.readlines()[2:]:
                name, data = line.split(":", 1)
                if name.strip() == "lo":
                    continue
                total += int(data.split()[8])
        return total
    except (OSError, ValueError, IndexError):
        return None


def read_meminfo():
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                key, value = line.split(":", 1)
                info[key] = int(value.split()[0])  # kB
        total = info["MemTotal"] / 1024
        available = info.get("MemAvailable", info.get("MemFree", 0)) / 1024
        return total, total - available
    except (OSError, ValueError, KeyError):
        return None


class TempReader:
    """Finds whichever temperature source this device allows us to read."""

    def __init__(self):
        self.kind = None  # "battery" or "cpu"
        self._read = None
        self._last = None
        self._last_at = 0.0
        self._detect()

    def _detect(self):
        for path in ("/sys/class/power_supply/battery/temp", "/sys/class/power_supply/BAT0/temp"):
            if self._file_value(path, battery=True) is not None:
                self.kind, self._read = "battery", lambda p=path: self._file_value(p, battery=True)
                return
        zones = glob.glob("/sys/class/thermal/thermal_zone*/temp")
        if any(self._file_value(z) is not None for z in zones):
            self.kind, self._read = "cpu", lambda: max(
                (v for v in (self._file_value(z) for z in zones) if v is not None), default=None)
            return
        if shutil.which("termux-battery-status"):  # needs the Termux:API app
            if self._termux_battery() is not None:
                self.kind, self._read = "battery", self._termux_battery

    @staticmethod
    def _file_value(path, battery=False):
        try:
            with open(path) as f:
                raw = float(f.read().strip())
        except (OSError, ValueError):
            return None
        value = raw / 10 if battery else (raw / 1000 if raw > 1000 else raw)
        return value if 5 <= value <= 120 else None

    @staticmethod
    def _termux_battery():
        try:
            out = subprocess.run(["termux-battery-status"], capture_output=True, text=True, timeout=8).stdout
            return float(json.loads(out)["temperature"])
        except Exception:
            return None

    def read(self):
        if not self._read:
            return None
        interval = 15 if self._read == self._termux_battery else 2
        if time.monotonic() - self._last_at >= interval:
            self._last = self._read()
            self._last_at = time.monotonic()
        return self._last


# ---------------------------------------------------------------- recording requests

class SiteStats:
    def __init__(self):
        self.events = deque()  # (time, bytes, ms, status, cpu_seconds)
        self.total = 0
        self.visitors = {}
        self.recent_ms = deque(maxlen=30)


class Metrics:
    def __init__(self, sites):
        self.lock = threading.Lock()
        self.stats = {s["id"]: SiteStats() for s in sites}
        self.log = deque(maxlen=LOG_SIZE)
        self.seq = 0
        self.bytes_sent = 0

    def record(self, site_id, ip, method, path, status, ms, nbytes, cpu):
        now = time.time()
        with self.lock:
            st = self.stats[site_id]
            st.events.append((now, nbytes, ms, status, cpu))
            st.total += 1
            st.visitors[ip] = now
            st.recent_ms.append(ms)
            self.bytes_sent += nbytes
            self.seq += 1
            self.log.append({
                "seq": self.seq, "t": now, "siteId": site_id, "ip": ip, "method": method,
                "path": path, "status": status, "ms": round(ms, 1), "bytes": nbytes,
            })

    def sites_now(self, cores):
        now = time.time()
        out = []
        with self.lock:
            for site_id, st in self.stats.items():
                while st.events and st.events[0][0] < now - RATE_WINDOW:
                    st.events.popleft()
                for ip, seen in list(st.visitors.items()):
                    if seen < now - VISITOR_WINDOW:
                        del st.visitors[ip]
                n = len(st.events)
                errors = sum(1 for e in st.events if e[3] >= 500)
                if n:
                    latency = sum(e[2] for e in st.events) / n
                elif st.recent_ms:
                    latency = sum(st.recent_ms) / len(st.recent_ms)
                else:
                    latency = 0
                out.append({
                    "id": site_id,
                    "rps": n / RATE_WINDOW,
                    "visitors": len(st.visitors),
                    "netMbps": sum(e[1] for e in st.events) * 8 / RATE_WINDOW / 1e6,
                    "cpu": sum(e[4] for e in st.events) / RATE_WINDOW / cores * 100,
                    "ramMB": None,  # sites share one process, so memory can't be split per site
                    "latencyMs": latency,
                    "errorRate": errors / n if n else 0,
                    "total": st.total,
                })
        return out

    def unique_visitors(self):
        with self.lock:
            return len(set().union(*(st.visitors.keys() for st in self.stats.values())))

    def requests_since(self, since, limit=60):
        now = time.time()
        with self.lock:
            rows = [r for r in self.log if r["seq"] > since][-limit:]
        out = []
        for r in rows:
            lt = time.localtime(r["t"])
            out.append(dict(
                r,
                clock=lt.tm_hour * 60 + lt.tm_min + (lt.tm_sec + r["t"] % 1) / 60,
                offset=min(1.0, max(0.0, r["t"] - (now - 1))),
            ))
        return out


class DeviceSampler(threading.Thread):
    """Samples CPU / memory / network / temperature once a second."""

    def __init__(self, metrics):
        super().__init__(daemon=True)
        self.metrics = metrics
        self.cores = os.cpu_count() or 1
        self.temp = TempReader()
        self.prev_t = time.monotonic()
        self.prev_stat = read_proc_stat()
        self.prev_proc = process_cpu_seconds()
        self.prev_tx = read_net_tx_bytes()
        self.prev_own = 0
        self.cpu_scope = "device" if self.prev_stat else "process"
        self.net_scope = "device" if self.prev_tx is not None else "process"
        mem = read_meminfo()
        self.ram_total = mem[0] if mem else None
        self.latest = {"cpu": 0, "ramMB": mem[1] if mem else None, "netMbps": 0, "temp": self.temp.read()}

    def run(self):
        while True:
            time.sleep(1)
            try:
                self.sample()
            except Exception as exc:  # keep sampling even if one read fails
                print("sampler:", exc)

    def sample(self):
        t = time.monotonic()
        dt = max(t - self.prev_t, 1e-3)
        self.prev_t = t

        if self.cpu_scope == "device":
            stat = read_proc_stat()
            if stat:
                d_total = stat[0] - self.prev_stat[0]
                d_idle = stat[1] - self.prev_stat[1]
                cpu = 100 * (1 - d_idle / d_total) if d_total > 0 else 0
                self.prev_stat = stat
            else:
                cpu = self.latest["cpu"]
        else:
            proc = process_cpu_seconds()
            cpu = (proc - self.prev_proc) / dt / self.cores * 100
            self.prev_proc = proc

        own = self.metrics.bytes_sent
        sent = own - self.prev_own  # what our sites sent
        self.prev_own = own
        if self.net_scope == "device":
            tx = read_net_tx_bytes()
            if tx is not None:
                # Whole-device traffic, but never less than our own (loopback isn't counted there).
                sent = max(sent, tx - self.prev_tx)
                self.prev_tx = tx

        mem = read_meminfo()
        self.latest = {
            "cpu": max(0.0, min(100.0, cpu)),
            "ramMB": mem[1] if mem else None,
            "netMbps": max(0, sent) * 8 / dt / 1e6,
            "temp": self.temp.read(),
        }


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "TrafficServer/1.0"
    protocol_version = "HTTP/1.1"
    app = None  # set in main()

    def log_message(self, *args):
        pass  # requests go to the dashboard instead of the terminal

    def do_GET(self):
        self.handle_request()

    def do_HEAD(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        cpu0 = time.thread_time()
        t0 = time.perf_counter()
        url = urlsplit(self.path)
        path = unquote(url.path)
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        site, rel = self.app.route(host, path)

        if site is None:
            if path.startswith("/api/"):
                return self.api(path, url.query)
            if path == "/favicon.ico":
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if path in DASHBOARD_FILES and self.command in ("GET", "HEAD"):
                return self.send_file(os.path.join(REPO, DASHBOARD_FILES[path]), cache=False)
            return self.send_text(404, "Not found")

        if rel is None:  # "/chess" -> "/chess/" so relative links work
            status, nbytes = self.send_redirect(path + "/" + (("?" + url.query) if url.query else ""))
        elif self.command not in ("GET", "HEAD"):
            status, nbytes = self.send_text(405, "Method not allowed")
        else:
            status, nbytes = self.serve_site(site, rel)

        shown = url.path + ("?" + url.query if url.query else "")
        self.app.metrics.record(
            site["id"], self.client_address[0], self.command, shown[:160], status,
            (time.perf_counter() - t0) * 1000, nbytes, time.thread_time() - cpu0,
        )

    # -- sites

    def serve_site(self, site, rel):
        root = site["_root"]
        full = os.path.realpath(os.path.join(root, rel.lstrip("/")))
        if full != root and not full.startswith(root + os.sep):
            return self.send_text(404, "Not found")
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            page = os.path.join(root, "404.html")
            body = open(page, "rb").read() if os.path.isfile(page) else b"<h1>Page not found</h1>"
            return self.send_bytes(404, body, "text/html; charset=utf-8")
        return self.send_file(full, cache=True)

    # -- API

    def api(self, path, query):
        app = self.app
        if path == "/api/config":
            return self.send_json(app.config_payload(self.headers.get("Host") or ""))
        if path == "/api/snapshot":
            try:
                since = int(parse_qs(query).get("since", ["0"])[0])
            except ValueError:
                since = 0
            return self.send_json(app.snapshot(since))
        return self.send_text(404, "Not found")

    # -- responses (each returns (status, body bytes sent))

    def send_file(self, full, cache):
        try:
            st = os.stat(full)
        except OSError:
            return self.send_text(404, "Not found")
        last_modified = email.utils.formatdate(st.st_mtime, usegmt=True)
        if cache and self.headers.get("If-Modified-Since") == last_modified:
            self.send_response(304)
            self.send_header("Last-Modified", last_modified)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return 304, 0
        with open(full, "rb") as f:
            body = f.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json", "image/svg+xml"):
            ctype += "; charset=utf-8"
        extra = {"Last-Modified": last_modified, "Cache-Control": "no-cache"} if cache else {"Cache-Control": "no-store"}
        return self.send_bytes(200, body, ctype, extra)

    def send_json(self, data):
        return self.send_bytes(200, json.dumps(data).encode(), "application/json", {"Cache-Control": "no-store"})

    def send_text(self, status, text):
        return self.send_bytes(status, text.encode(), "text/plain; charset=utf-8")

    def send_redirect(self, location):
        self.send_response(301)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()
        return 301, 0

    def send_bytes(self, status, body, ctype, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return status, len(body)
        return status, 0


class App:
    def __init__(self, conf_path, port):
        with open(conf_path) as f:
            conf = json.load(f)
        base = os.path.dirname(os.path.abspath(conf_path))
        self.server_conf = conf.get("server", {})
        self.sites = conf["sites"]
        for site in self.sites:
            site["_root"] = os.path.realpath(os.path.join(base, site["root"]))
            if not os.path.isdir(site["_root"]):
                raise SystemExit(f"Site folder not found for {site['id']}: {site['_root']}")
        self.domains = {s["domain"].lower(): s for s in self.sites if s.get("domain")}
        self.by_id = {s["id"]: s for s in self.sites}
        self.port = port
        self.metrics = Metrics(self.sites)
        self.sampler = DeviceSampler(self.metrics)
        self.sampler.start()

    def route(self, host, path):
        """Returns (site, path inside the site). path is None when a redirect to add '/' is needed."""
        if host in self.domains:
            return self.domains[host], path
        parts = path.split("/", 2)
        site = self.by_id.get(parts[1]) if len(parts) > 1 else None
        if not site:
            return None, None
        if len(parts) == 2:
            return site, None
        return site, "/" + parts[2]

    def config_payload(self, host_header):
        s = self.sampler
        temp_kind = s.temp.kind
        warn, crit = (40, 46) if temp_kind == "battery" else (75, 90)
        c = self.server_conf
        return {
            "live": True,
            "servers": [{
                "id": c.get("id", "server1"),
                "name": c.get("name", "Server 1"),
                "hardware": c.get("hardware", socket.gethostname()),
                "kind": c.get("kind", "pc"),
                "cores": s.cores,
                "ramMB": s.ram_total,
                "netMbps": c.get("netMbps", 100),
                "tempWarn": warn,
                "tempCrit": crit,
                "tempKind": temp_kind,
                "cpuScope": s.cpu_scope,
                "netScope": s.net_scope,
                "sites": [{
                    "id": site["id"],
                    "name": site.get("name", site["id"]),
                    "domain": site.get("domain") or f"{host_header}/{site['id']}/",
                    "url": f"/{site['id']}/",
                    "latencyMs": 15,
                } for site in self.sites],
            }],
        }

    def snapshot(self, since):
        s = self.sampler
        dev = s.latest
        sites = self.metrics.sites_now(s.cores)
        n = sum(x["rps"] for x in sites)
        errors = sum(x["rps"] * x["errorRate"] for x in sites)
        site_cpu = sum(x["cpu"] for x in sites)
        cpu = max(dev["cpu"], site_cpu)
        lt = time.localtime()
        net_cap = self.server_conf.get("netMbps", 100)
        return {
            "clockMinutes": lt.tm_hour * 60 + lt.tm_min + lt.tm_sec / 60,
            "seq": self.metrics.seq,
            "servers": [{
                "id": self.server_conf.get("id", "server1"),
                "cpu": cpu,
                "cpuDemand": cpu,
                "systemCpu": max(0.0, cpu - site_cpu),
                "ramMB": dev["ramMB"],
                "ram": dev["ramMB"] / s.ram_total * 100 if dev["ramMB"] is not None and s.ram_total else None,
                "netMbps": dev["netMbps"],
                "net": min(100.0, dev["netMbps"] / net_cap * 100),
                "temp": dev["temp"],
                "visitors": self.metrics.unique_visitors(),
                "errorRate": errors / n if n else 0,
                "sites": sites,
            }],
            "requests": self.metrics.requests_since(since),
        }


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent; this just picks the outgoing interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    parser = argparse.ArgumentParser(description="Host sites and show their real traffic on the dashboard.")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="0.0.0.0", help="address to listen on (default: all)")
    parser.add_argument("--config", default=os.path.join(HERE, "sites.json"))
    args = parser.parse_args()

    app = App(args.config, args.port)
    Handler.app = app
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True

    ip = lan_ip()
    s = app.sampler
    print(f"\n  Dashboard   http://{ip}:{args.port}/")
    for site in app.sites:
        print(f"  {site.get('name', site['id']):<11} http://{ip}:{args.port}/{site['id']}/")
    print(f"\n  CPU: {'whole device' if s.cpu_scope == 'device' else 'this server process (device CPU is hidden)'}"
          f" · network: {'whole device' if s.net_scope == 'device' else 'this server only'}"
          f" · temperature: {s.temp.kind or 'not available'}")
    print("  Press Ctrl+C to stop.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
