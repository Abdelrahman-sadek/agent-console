"""
Skillware runner: runs selected Skillware skills (real Python code) for Agent Console.

Private service on the console's Docker network. Endpoints:
  GET  /health
  GET  /skills               manifests of the enabled skills (id, description, parameters, rules)
  POST /run {skill, params, env?}  -> {ok, result} or {ok: false, error}

Every request except /health needs the header "authorization: Bearer $SKILLWARE_TOKEN".
Skills run one at a time per skill id is not required; each call has a time limit.
"""
import json
import os
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from skillware.core.loader import SkillLoader

SKILLS_ROOT = os.environ.get("SKILLS_ROOT", "/opt/skillware/skills")
TOKEN = os.environ.get("SKILLWARE_TOKEN", "")
TIMEOUT = int(os.environ.get("SKILL_TIMEOUT_SECONDS", "90"))
MAX_BODY = 2_000_000

# Skills that run fully here: no crypto wallets, no email sending, no missing local models.
ENABLED = [
    "security/prompt_injection_firewall",
    "security/deceptive_ui_guard",
    "compliance/tos_evaluator",
    "wellness/mental_coach",
    "data_engineering/semantic_web_proxy",
    "data_engineering/novelty_extractor",
    "optimization/context_optimizer",
    "optimization/prompt_rewriter",
    "monitoring/token_limiter",
    "monitoring/kpi_gate",
    "linguistics/korean_slang",
]
# Per-request keys the console may pass (only these, only to skills that declare them).
PASSABLE_ENV = {"GOOGLE_API_KEY", "GEMINI_API_KEY"}

_bundles = {}
_errors = {}
_env_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=4)


def load_all():
    for sid in ENABLED:
        try:
            _bundles[sid] = SkillLoader.load_skill(os.path.join(SKILLS_ROOT, sid))
        except Exception as e:  # keep the service up; report per skill
            _errors[sid] = f"{type(e).__name__}: {e}"


def describe(sid, bundle):
    m = bundle.get("manifest") or {}
    env = m.get("env_vars") or {}
    return {
        "id": sid,
        "title": (bundle.get("card") or {}).get("title") or sid.split("/")[-1].replace("_", " ").title(),
        "summary": m.get("short_description") or m.get("description") or "",
        "description": m.get("description") or "",
        "parameters": m.get("parameters") or {"type": "object", "properties": {}},
        "constitution": m.get("constitution") or "",
        "instructions": (bundle.get("instructions") or "")[:6000],
        "env": {k: bool((v or {}).get("required")) for k, v in env.items()},
        "version": m.get("version"),
    }


def run_skill(sid, params, env):
    bundle = _bundles[sid]
    skill = bundle["class"]()
    declared = set(((bundle.get("manifest") or {}).get("env_vars") or {}).keys())
    extra = {k: v for k, v in (env or {}).items() if k in PASSABLE_ENV and k in declared and isinstance(v, str) and v}
    if not extra:
        return skill.execute(params)
    # Keys are process-wide in these skills, so calls that need them run one at a time.
    with _env_lock:
        old = {k: os.environ.get(k) for k in extra}
        os.environ.update(extra)
        try:
            return skill.execute(params)
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


class Handler(BaseHTTPRequestHandler):
    server_version = "skillware-runner/1"

    def _send(self, code, body):
        data = json.dumps(body, default=str).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self):
        return bool(TOKEN) and self.headers.get("authorization") == f"Bearer {TOKEN}"

    def log_message(self, fmt, *args):  # quiet: one line per call, no bodies
        print(f"{self.command} {self.path} {args[1] if len(args) > 1 else ''}", flush=True)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "skills": len(_bundles), "failed": list(_errors)})
        if not self._authorized():
            return self._send(401, {"ok": False, "error": "unauthorized"})
        if self.path == "/skills":
            return self._send(200, {"skills": [describe(s, b) for s, b in _bundles.items()], "unavailable": _errors})
        return self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self._authorized():
            return self._send(401, {"ok": False, "error": "unauthorized"})
        if self.path != "/run":
            return self._send(404, {"ok": False, "error": "not found"})
        length = int(self.headers.get("content-length") or 0)
        if length > MAX_BODY:
            return self._send(413, {"ok": False, "error": "request too large"})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._send(400, {"ok": False, "error": "invalid JSON"})
        sid, params = body.get("skill"), body.get("params") or {}
        if sid not in _bundles:
            return self._send(404, {"ok": False, "error": f"skill not available: {sid}"})
        if not isinstance(params, dict):
            return self._send(400, {"ok": False, "error": "params must be an object"})
        future = _pool.submit(run_skill, sid, params, body.get("env"))
        try:
            result = future.result(timeout=TIMEOUT)
            return self._send(200, {"ok": True, "result": result})
        except FutureTimeout:
            return self._send(504, {"ok": False, "error": f"skill timed out after {TIMEOUT}s"})
        except Exception as e:
            traceback.print_exc()
            return self._send(200, {"ok": False, "error": f"{type(e).__name__}: {str(e)[:500]}"})


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("SKILLWARE_TOKEN must be set")
    load_all()
    print(f"skillware-runner: {len(_bundles)} skills loaded, failed: {_errors}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
