#!/usr/bin/env python3
"""
Real traffic server for the dashboard.

Hosts every folder in sites/ as a site (named after the folder), records every
request, measures the machine it runs on, and serves the dashboard with live
numbers. The dashboard itself is listed too, as the site "traffic". Add or remove
a folder and it shows up on (or leaves) the dashboard within a second.

    python3 server/traffic_server.py            # port 8080
    python3 server/traffic_server.py --port 9000

Requests are served by one process per CPU core, so real traffic can use the
whole machine. A load test floods the sites with real HTTP requests sent from
this machine itself.

Then open http://<this-device's-ip>:8080/ from any device on the same network.
Only the Python standard library is used, so it runs as-is in Termux on Android,
on a Raspberry Pi, or on a PC.
"""
import argparse
import email.utils
import errno
import glob
import http.client
import json
import mimetypes
import os
import re
import shutil
import signal
import socket
import subprocess
import threading
import time
import warnings
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urljoin, urlsplit

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

TRAFFIC_SITE = "traffic"  # the dashboard's own traffic is shown as this site
RESERVED_NAMES = {TRAFFIC_SITE, "api"}
RATE_WINDOW = 3.0  # seconds of requests averaged into "per second" numbers
VISITOR_WINDOW = 300.0  # an IP counts as "online" for 5 minutes after its last request
LOG_SIZE = 400
LOAD_TEST_MAX_SECONDS = 60
LOAD_TEST_AGENT = "traffic-loadtest"  # User-Agent of load test requests

# Load generators are forked from the threaded server; they only send HTTP requests and exit.
warnings.filterwarnings("ignore", category=DeprecationWarning, message=".*fork.*")


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


# ---------------------------------------------------------------- load test

def generate_requests(host, port, targets, deadline, parent_pid):
    """
    Loads the sites over real HTTP, like a browser would (page, then its CSS/JS/images),
    as fast as the server answers, until the deadline or until the server exits.
    """
    conn = None
    i = 0
    while time.time() < deadline:
        url, referer = targets[i % len(targets)]
        i += 1
        try:
            if conn is None:
                conn = http.client.HTTPConnection(host, port, timeout=10)
            conn.request("GET", url, headers={"User-Agent": LOAD_TEST_AGENT, "Referer": referer})
            conn.getresponse().read()
            if i % 100 == 0:  # reconnect now and then so every server process gets work
                conn.close()
                conn = None
        except (OSError, http.client.HTTPException):
            if conn:
                conn.close()
            conn = None
            time.sleep(0.05)
        if i % 200 == 0 and os.getppid() != parent_pid:
            break


CLK_TCK = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100


def read_pid_cpu_seconds(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            fields = f.read().rsplit(")", 1)[1].split()
        return (int(fields[11]) + int(fields[12])) / CLK_TCK  # utime + stime
    except (OSError, ValueError, IndexError):
        return None


class PidCpu:
    """CPU time used by a set of child processes since the previous call."""

    def __init__(self):
        self.prev = {}

    def since_last(self, pids, dt, assume_busy=False):
        total = 0.0
        seen = {}
        for pid in pids:
            t = read_pid_cpu_seconds(pid)
            if t is None:  # no /proc (macOS, Windows)
                total += dt if assume_busy else 0
                continue
            total += max(0.0, t - self.prev.get(pid, 0.0))
            seen[pid] = t
        self.prev = seen
        return total


class LoadTest:
    """
    Floods sites with real HTTP requests from this machine: two request-sending
    processes per CPU core. Sending and serving them (on every core) is what pushes
    the CPU to its limit, so the device really heats up.
    """

    def __init__(self, cores):
        self.cores = cores
        self.host = "127.0.0.1"
        self.port = None  # set when the server starts
        self.targets_for = None  # site ids -> [(url, referer)], set by App
        self.lock = threading.Lock()
        self.workers = []
        self.sites = []
        self.until = 0.0
        self.note = None
        self.note_at = 0.0
        self.cpu = PidCpu()
        self.generation = 0

    def active(self):
        return bool(self.workers) and time.time() < self.until

    def start(self, site_ids, seconds):
        seconds = max(1.0, min(float(LOAD_TEST_MAX_SECONDS), seconds))
        with self.lock:
            if self.workers:
                return  # one load test at a time
            self.sites = sorted(set(site_ids))
            self.note = None
            targets = self.targets_for(self.sites)
            if not targets:
                return
            self.until = time.time() + seconds
            # Two senders per core keep every core busy even while some wait on responses.
            self.workers = [self._spawn(targets, self.until) for _ in range(self.cores * 2)]
            self.generation += 1
            gen, workers = self.generation, list(self.workers)
        threading.Thread(target=self._reap, args=(gen, workers), daemon=True).start()

    def stop(self, note=None):
        with self.lock:
            workers = list(self.workers)
            self.until = 0.0
            if note:
                self.note, self.note_at = note, time.time()
        for w in workers:
            try:
                if isinstance(w, int):
                    os.kill(w, signal.SIGTERM)
                else:
                    w.terminate()
            except (OSError, AttributeError):
                pass

    def _spawn(self, targets, deadline):
        parent = os.getpid()
        if hasattr(os, "fork"):
            pid = os.fork()
            if pid == 0:
                try:
                    generate_requests(self.host, self.port, targets, deadline, parent)
                finally:
                    os._exit(0)
            return pid
        import multiprocessing  # Windows has no fork
        p = multiprocessing.Process(target=generate_requests, args=(self.host, self.port, targets, deadline, parent), daemon=True)
        p.start()
        return p

    def _reap(self, gen, workers):
        for w in workers:
            try:
                if isinstance(w, int):
                    os.waitpid(w, 0)
                else:
                    w.join()
            except OSError:
                pass
        with self.lock:
            if self.generation == gen:
                self.workers, self.sites = [], []

    def cpu_seconds_since_last(self, dt):
        """CPU time the request generators used since the previous call."""
        with self.lock:
            pids = [w if isinstance(w, int) else w.pid for w in self.workers]
        return self.cpu.since_last(pids, dt, assume_busy=time.time() < self.until)

    def status(self):
        now = time.time()
        with self.lock:
            running = bool(self.workers) and now < self.until
            return {
                "sites": list(self.sites) if running else [],
                "remaining": max(0.0, self.until - now) if running else 0,
                "generators": len(self.workers) if running else 0,
                "note": self.note if self.note and now - self.note_at < 60 else None,
            }


# ---------------------------------------------------------------- recording requests

class SiteStats:
    def __init__(self):
        self.events = deque()  # (time, bytes, ms, status, cpu_seconds)
        self.total = 0
        self.visitors = {}
        self.recent_ms = deque(maxlen=30)


class Metrics:
    def __init__(self):
        self.lock = threading.Lock()
        self.stats = {}  # site id -> SiteStats, created on first use
        self.log = deque(maxlen=LOG_SIZE)
        self.seq = 0
        self.bytes_sent = 0

    def record(self, site_id, ip, method, path, status, ms, nbytes, cpu, agent=None):
        now = time.time()
        with self.lock:
            st = self.stats.get(site_id) or self.stats.setdefault(site_id, SiteStats())
            st.events.append((now, nbytes, ms, status, cpu))
            st.total += 1
            if agent != "loadtest":  # load test requests aren't people
                st.visitors[ip] = now
            st.recent_ms.append(ms)
            self.bytes_sent += nbytes
            self.seq += 1
            self.log.append({
                "seq": self.seq, "t": now, "siteId": site_id, "ip": ip, "method": method,
                "path": path, "status": status, "ms": round(ms, 1), "bytes": nbytes, "agent": agent,
            })

    def sites_now(self, cores, site_ids):
        now = time.time()
        out = []
        with self.lock:
            for gone in set(self.stats) - set(site_ids):  # folder was removed
                del self.stats[gone]
            for site_id in site_ids:
                st = self.stats.get(site_id) or self.stats.setdefault(site_id, SiteStats())
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


# ---------------------------------------------------------------- sites folder

class SiteRegistry:
    """Every folder inside the sites directory is a site named after the folder."""

    def __init__(self, sites_dir):
        self.dir = os.path.realpath(sites_dir)
        os.makedirs(self.dir, exist_ok=True)
        self.lock = threading.Lock()
        self.version = None
        self._sites = []
        self._scanned = 0.0
        self.announce = None  # called with (added, removed) names

    def sites(self):
        """Current sites; the folder is re-read at most once a second."""
        with self.lock:
            if time.monotonic() - self._scanned >= 1.0:
                self._scan()
                self._scanned = time.monotonic()
            return self._sites

    def get(self, name):
        return next((s for s in self.sites() if s["id"] == name), None)

    def _scan(self):
        try:
            names = sorted(
                (e.name for e in os.scandir(self.dir)
                 if e.is_dir() and not e.name.startswith((".", "_"))
                 and e.name not in RESERVED_NAMES and "," not in e.name),
                key=str.lower,
            )
        except OSError:
            names = []
        version = "/".join(names)
        if version == self.version:
            return
        old = {s["id"] for s in self._sites}
        self._sites = [{"id": n, "name": n, "root": self._web_root(os.path.join(self.dir, n))} for n in names]
        if self.version is not None and self.announce:
            self.announce(sorted(set(names) - old), sorted(old - set(names)))
        self.version = version

    @staticmethod
    def _web_root(folder):
        """Use a built app's output folder when the site's own folder has no index.html."""
        for sub in ("", "dist", "build", "public", "www"):
            candidate = os.path.realpath(os.path.join(folder, sub))
            if os.path.isfile(os.path.join(candidate, "index.html")):
                return candidate
        return os.path.realpath(folder)


class DeviceSampler(threading.Thread):
    """Samples CPU / memory / network / temperature once a second."""

    def __init__(self, metrics, load_test, server_pids=()):
        super().__init__(daemon=True)
        self.metrics = metrics
        self.load_test = load_test
        self.server_pids = list(server_pids)  # worker processes serving requests
        self.server_cpu = PidCpu()
        self.cores = load_test.cores
        self.temp = TempReader()
        # Battery sensors run much cooler than CPU sensors, so they get lower limits.
        self.temp_warn, self.temp_crit = (40, 46) if self.temp.kind == "battery" else (75, 90)
        self.prev_t = time.monotonic()
        self.prev_stat = read_proc_stat()
        self.prev_proc = process_cpu_seconds()
        self.prev_tx = read_net_tx_bytes()
        self.prev_own = 0
        self.cpu_scope = "device" if self.prev_stat else "process"
        self.net_scope = "device" if self.prev_tx is not None else "process"
        mem = read_meminfo()
        self.ram_total = mem[0] if mem else None
        self.latest = {"cpu": 0, "loadgen": 0, "ramMB": mem[1] if mem else None, "netMbps": 0, "temp": self.temp.read()}

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
            # Device CPU is hidden: add up this program's processes instead.
            proc = process_cpu_seconds()
            busy = proc - self.prev_proc + self.server_cpu.since_last(self.server_pids, dt)
            cpu = busy / dt / self.cores * 100
            self.prev_proc = proc

        loadgen = self.load_test.cpu_seconds_since_last(dt) / dt / self.cores * 100
        if self.cpu_scope == "process":
            cpu += loadgen

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
        temp = self.temp.read()
        if temp is not None and temp >= self.temp_crit and self.load_test.active():
            self.load_test.stop(f"Load test stopped early: temperature reached {temp:.0f} °C.")
            print(f"Load test stopped: temperature {temp:.0f} °C")
        self.latest = {
            "cpu": max(0.0, min(100.0, cpu)),
            "loadgen": max(0.0, min(100.0, loadgen)),
            "ramMB": mem[1] if mem else None,
            "netMbps": max(0, sent) * 8 / dt / 1e6,
            "temp": temp,
        }


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "TrafficServer/1.0"
    protocol_version = "HTTP/1.1"
    app = None  # set in main()
    api_port = None  # in worker processes: the main process's internal API port

    def log_message(self, *args):
        pass  # requests go to the dashboard instead of the terminal

    def setup(self):
        super().setup()
        # Headers and body are written separately; without this, small responses
        # wait ~40 ms for a TCP acknowledgement (Nagle's algorithm).
        try:
            self.request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass

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
        site_id, status, nbytes = self.dispatch(url, path)
        shown = url.path + ("?" + url.query if url.query else "")
        agent = "loadtest" if self.headers.get("User-Agent") == LOAD_TEST_AGENT else None
        self.app.metrics.record(
            site_id, self.client_address[0], self.command, shown[:160], status,
            (time.perf_counter() - t0) * 1000, nbytes, time.thread_time() - cpu0, agent,
        )

    def dispatch(self, url, path):
        """Answers the request and returns (site it belongs to, status, body bytes)."""
        app = self.app
        if path.startswith("/api/"):
            return (TRAFFIC_SITE, *self.api(path, url.query))

        site, rel = app.route(path)
        if site is None:
            # Apps built for "/" ask for /assets/... instead of /<site>/assets/...;
            # the page that asked tells us which site it belongs to.
            ref = self.referring_site()
            if ref and path != "/" and self.site_file(ref, path):
                return (ref["id"], *self.serve_site(ref, path))
            if path == "/favicon.ico":
                return (TRAFFIC_SITE, *self.send_bytes(204, b"", "image/x-icon"))
            if path in DASHBOARD_FILES and self.command in ("GET", "HEAD"):
                return (TRAFFIC_SITE, *self.send_file(os.path.join(REPO, DASHBOARD_FILES[path]), cache=False))
            return (TRAFFIC_SITE, *self.send_text(404, "Not found"))

        if rel is None:  # "/chessr" -> "/chessr/" so relative links work
            return (site["id"], *self.send_redirect(url.path + "/" + (("?" + url.query) if url.query else "")))
        if self.command not in ("GET", "HEAD"):
            return (site["id"], *self.send_text(405, "Method not allowed"))
        return (site["id"], *self.serve_site(site, rel))

    # -- sites

    def referring_site(self):
        ref = self.headers.get("Referer")
        if not ref:
            return None
        site, _ = self.app.route(unquote(urlsplit(ref).path))
        return site

    @staticmethod
    def site_file(site, rel):
        """Absolute path of rel inside the site, or None if it escapes or doesn't exist."""
        root = site["root"]
        full = os.path.realpath(os.path.join(root, rel.lstrip("/")))
        if full != root and not full.startswith(root + os.sep):
            return None
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        return full if os.path.isfile(full) else None

    def serve_site(self, site, rel):
        full = self.site_file(site, rel)
        if full:
            return self.send_file(full, cache=True)
        root = site["root"]
        last = rel.rstrip("/").rsplit("/", 1)[-1]
        index = os.path.join(root, "index.html")
        if "." not in last and "text/html" in (self.headers.get("Accept") or "") and os.path.isfile(index):
            return self.send_file(index, cache=True)  # single-page app route like /chessr/lesson/3
        page = os.path.join(root, "404.html")
        body = open(page, "rb").read() if os.path.isfile(page) else b"<h1>Page not found</h1>"
        return self.send_bytes(404, body, "text/html; charset=utf-8")

    # -- API

    def api(self, path, query):
        if self.api_port:
            return self.relay_api()
        app = self.app
        if path == "/api/config":
            return self.send_json(app.config_payload(self.headers.get("Host") or ""))
        if path == "/api/loadtest":
            if self.command != "POST":
                return self.send_text(405, "Use POST")
            q = parse_qs(query)
            try:
                seconds = float(q.get("seconds", ["15"])[0])
            except ValueError:
                seconds = 15
            if seconds <= 0:
                app.load_test.stop()
            else:
                valid = app.site_ids()
                ids = [i for i in q.get("sites", [""])[0].split(",") if i in valid]
                if not ids:
                    return self.send_text(400, "Unknown site")
                app.load_test.start(ids, seconds)
            return self.send_json(app.load_test.status())
        if path == "/api/snapshot":
            try:
                since = int(parse_qs(query).get("since", ["0"])[0])
            except ValueError:
                since = 0
            return self.send_json(app.snapshot(since))
        return self.send_text(404, "Not found")

    def relay_api(self):
        """Worker processes pass API calls to the main process, which holds the numbers."""
        conn = http.client.HTTPConnection("127.0.0.1", self.api_port, timeout=10)
        try:
            conn.request(self.command, self.path, headers={"Host": self.headers.get("Host") or ""})
            res = conn.getresponse()
            body = res.read()
            return self.send_bytes(res.status, body, res.getheader("Content-Type") or "application/json",
                                   {"Cache-Control": "no-store"})
        except (OSError, http.client.HTTPException):
            return self.send_text(503, "Busy")
        finally:
            conn.close()

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


class InternalApiHandler(Handler):
    """The main process's API endpoint for worker processes (not counted as traffic itself)."""

    def handle_request(self):
        url = urlsplit(self.path)
        self.api(unquote(url.path), url.query)


class PipeRecorder:
    """Worker processes send each request record to the main process through a pipe."""

    def __init__(self, fd):
        self.fd = fd

    def record(self, *fields):
        line = json.dumps(fields).encode() + b"\n"  # well under PIPE_BUF, so writes don't interleave
        try:
            os.write(self.fd, line)
        except OSError:
            os._exit(0)  # main process is gone


def read_records(fd, metrics):
    with os.fdopen(fd, "rb", buffering=1 << 16) as f:
        for line in f:
            try:
                metrics.record(*json.loads(line))
            except (ValueError, TypeError):
                pass


def run_worker(app, server, record_fd, api_port):
    """Body of a request-serving worker process. Never returns."""
    app.metrics = PipeRecorder(record_fd)
    Handler.api_port = api_port
    parent = os.getppid()

    def watch_parent():
        while os.getppid() == parent:
            time.sleep(1)
        os._exit(0)

    threading.Thread(target=watch_parent, daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        os._exit(0)


class App:
    def __init__(self, conf_path, sites_dir):
        try:
            with open(conf_path) as f:
                self.server_conf = json.load(f)
        except FileNotFoundError:
            self.server_conf = {}
        self.cores = os.cpu_count() or 1
        self.registry = SiteRegistry(sites_dir)
        self.metrics = Metrics()
        self.load_test = LoadTest(self.cores)
        self.load_test.targets_for = self.load_test_targets
        self.sampler = None

    def start(self, host, port, server_pids=(), record_fd=None):
        """Starts background threads. Called after worker processes are forked."""
        self.load_test.host = "127.0.0.1" if host in ("", "0.0.0.0", "::") else host
        self.load_test.port = port
        self.sampler = DeviceSampler(self.metrics, self.load_test, server_pids)
        self.sampler.start()
        threading.Thread(target=self._watch_sites, daemon=True).start()
        if record_fd is not None:
            threading.Thread(target=read_records, args=(record_fd, self.metrics), daemon=True).start()

    def load_test_targets(self, site_ids):
        """Each site's page plus the files it links to, like a browser loading it."""
        targets = []
        for sid in site_ids:
            if sid == TRAFFIC_SITE:
                base, index = "/", os.path.join(REPO, "index.html")
            else:
                site = self.registry.get(sid)
                if not site:
                    continue
                base, index = f"/{quote(sid)}/", os.path.join(site["root"], "index.html")
            urls = [base]
            try:
                with open(index, encoding="utf-8", errors="ignore") as f:
                    html = f.read()
            except OSError:
                html = ""
            for ref in re.findall(r"""(?:src|href)\s*=\s*["']([^"'#?]+)""", html, re.I):
                if re.match(r"^([a-z][a-z0-9+.-]*:|//)", ref, re.I):
                    continue  # other websites, mailto:, data: ...
                url = urljoin(base, ref)
                if url not in urls:
                    urls.append(url)
            targets += [(quote(u, safe="/%:@&=+$,;~-._!*'()"), base) for u in urls[:30]]
        return targets

    def _watch_sites(self):
        while True:  # notices new/removed folders even when no dashboard is open
            self.registry.sites()
            time.sleep(1)

    def site_ids(self):
        return [TRAFFIC_SITE] + [s["id"] for s in self.registry.sites()]

    def route(self, path):
        """Returns (site, path inside the site). path is None when a redirect to add '/' is needed."""
        parts = path.split("/", 2)
        site = self.registry.get(parts[1]) if len(parts) > 1 and parts[1] else None
        if not site:
            return None, None
        if len(parts) == 2:
            return site, None
        return site, "/" + parts[2]

    def config_payload(self, host_header):
        s = self.sampler
        temp_kind = s.temp.kind
        warn, crit = s.temp_warn, s.temp_crit
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
                "sites": [
                    {"id": TRAFFIC_SITE, "name": TRAFFIC_SITE, "domain": f"{host_header}/",
                     "url": "/", "latencyMs": 15, "builtIn": True},
                ] + [{
                    "id": site["id"],
                    "name": site["name"],
                    "domain": f"{host_header}/{site['id']}/",
                    "url": f"/{quote(site['id'])}/",
                    "latencyMs": 15,
                } for site in self.registry.sites()],
            }],
            "sitesVersion": self.registry.version,
        }

    def snapshot(self, since):
        s = self.sampler
        dev = s.latest
        sites = self.metrics.sites_now(s.cores, self.site_ids())
        test = self.load_test.status()
        if test["sites"]:  # count the request generators' CPU against the sites being tested
            share = dev["loadgen"] / len(test["sites"])
            for x in sites:
                if x["id"] in test["sites"]:
                    x["cpu"] += share
        n = sum(x["rps"] for x in sites)
        errors = sum(x["rps"] * x["errorRate"] for x in sites)
        site_cpu = sum(x["cpu"] for x in sites)
        cpu = max(dev["cpu"], site_cpu)
        lt = time.localtime()
        net_cap = self.server_conf.get("netMbps", 100)
        return {
            "clockMinutes": lt.tm_hour * 60 + lt.tm_min + lt.tm_sec / 60,
            "seq": self.metrics.seq,
            "sitesVersion": self.registry.version,
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
                "loadTest": test,
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
    parser.add_argument("--config", default=os.path.join(HERE, "server.json"), help="server name and specs")
    parser.add_argument("--sites", default=os.path.join(REPO, "sites"), help="folder whose sub-folders are the sites")
    parser.add_argument("--workers", type=int, default=0, help="request-serving processes (default: one per core)")
    args = parser.parse_args()

    app = App(args.config, args.sites)
    Handler.app = app
    try:
        public = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as exc:
        if exc.errno in (errno.EADDRINUSE, getattr(errno, "WSAEADDRINUSE", -1)):
            raise SystemExit(
                f"\n  Port {args.port} is already in use. Either the server is already running\n"
                f"  (stop it with:  pkill -f '[t]raffic_server.py'), or another app uses this port\n"
                f"  (start on another one with:  python server/traffic_server.py --port {args.port + 1}).\n")
        raise
    public.daemon_threads = True
    workers = []

    if hasattr(os, "fork"):
        # Fork the serving processes before any threads start. They share the listening
        # socket, so the kernel spreads connections across every CPU core.
        internal = ThreadingHTTPServer(("127.0.0.1", 0), InternalApiHandler)
        internal.daemon_threads = True
        read_fd, write_fd = os.pipe()
        for _ in range(args.workers or app.cores):
            pid = os.fork()
            if pid == 0:
                os.close(read_fd)
                internal.socket.close()
                run_worker(app, public, write_fd, internal.server_address[1])
            workers.append(pid)
        os.close(write_fd)
        public.socket.close()  # only the workers accept site traffic
        app.start(args.host, args.port, workers, read_fd)
        threading.Thread(target=internal.serve_forever, daemon=True).start()
    else:
        app.start(args.host, args.port)  # Windows: a single process serves everything
        threading.Thread(target=public.serve_forever, daemon=True).start()

    base = f"http://{lan_ip()}:{args.port}"

    def announce(added, removed):
        for name in added:
            print(f"  + site added    {name:<14} {base}/{quote(name)}/")
        for name in removed:
            print(f"  - site removed  {name}")

    app.registry.announce = announce
    s = app.sampler
    print(f"\n  {TRAFFIC_SITE:<14} {base}/   (this dashboard)")
    for site in app.registry.sites():
        print(f"  {site['name']:<14} {base}/{quote(site['id'])}/")
    print(f"\n  Sites folder: {app.registry.dir}")
    print("  Every folder in it is a site named after the folder. Changes show up within a second.")
    print(f"\n  Serving with {len(workers) or 1} process(es) on {app.cores} cores"
          f" · CPU: {'whole device' if s.cpu_scope == 'device' else 'this program (device CPU is hidden)'}"
          f" · network: {'whole device' if s.net_scope == 'device' else 'this program only'}"
          f" · temperature: {s.temp.kind or 'not available'}")
    print("  Press Ctrl+C to stop.\n")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        app.load_test.stop()
        for pid in workers:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        print("\nStopped.")


if __name__ == "__main__":
    main()
