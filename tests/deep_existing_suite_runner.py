#!/usr/bin/env python3
"""Run the existing browser suites against a fresh in-memory real-handler fixture per suite."""
from __future__ import annotations
import os, pathlib, socket, subprocess, sys, time
from urllib.request import urlopen

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path(os.environ.get('DEEP_SUITE_EVIDENCE', str(ROOT / '.evidence' / 'deep-existing-suite')))
SUITES = [
    'financial_workspace_e2e.py', 'manager_actions_e2e.py', 'manager_design_e2e.py',
    'app_update_e2e.py', 'profile_flow_e2e.py', 'password_flow_e2e.py', 'mobile_download_e2e.py',
]

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); return s.getsockname()[1]

def run_one(suite: str):
    OUT.mkdir(parents=True, exist_ok=True)
    stem = suite.removesuffix('.py')
    log = OUT / f'{stem}.log'
    evidence = OUT / stem
    evidence.mkdir(parents=True, exist_ok=True)
    port = free_port(); base = f'http://localhost:{port}'
    synthetic = {
        'PANGSUMA_LOCAL_URL': base,
        'PROFILE_REVIEW_DIR': str(evidence),
        'BOOTSTRAP_TOKEN': 'deep-local-bootstrap-token-012345678901234567890',
        'PASSWORD_PEPPER': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        'LOCAL_MANAGER_PASSWORD': 'Deep-local-manager-password-2026!',
        'PASSKEY_AUTH_ENABLED': 'false', 'WEBAUTHN_PROFILE': 'test',
        'WEBAUTHN_ORIGIN': base, 'WEBAUTHN_RP_ID': 'localhost',
        'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUNBUFFERED': '1',
    }
    server_env = os.environ.copy(); server_env.update(synthetic); server_env['DEEP_LOCAL_PORT'] = str(port); server_env['DEEP_LOCAL_ORIGIN'] = base
    server_cmd = ['node', '--loader', './tests/wasm-module-loader.mjs', './tests/deep_local_api_server.mjs']
    server = subprocess.Popen(server_cmd, cwd=ROOT, env=server_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    lines = []
    ready = False
    deadline = time.time() + 30
    while time.time() < deadline:
        line = server.stdout.readline()
        if line:
            lines.append(line)
            if 'DEEP_LOCAL_READY' in line: ready = True; break
        elif server.poll() is not None: break
    if not ready:
        rest = server.stdout.read() if server.stdout else ''
        lines.append(rest)
        log.write_text(''.join(lines), encoding='utf-8')
        if server.poll() is None: server.kill(); server.wait()
        return 125
    test_env = os.environ.copy(); test_env.update(synthetic)
    cmd = [sys.executable, '-B', str(ROOT / 'tests' / suite)]
    try:
        proc = subprocess.run(cmd, cwd=ROOT, env=test_env, capture_output=True, text=True, timeout=300)
        output = ''.join(lines) + '\n--- TEST STDOUT ---\n' + proc.stdout + '\n--- TEST STDERR ---\n' + proc.stderr
        log.write_text(output, encoding='utf-8')
        return proc.returncode
    except subprocess.TimeoutExpired as exc:
        output = ''.join(lines) + '\n--- TEST TIMEOUT ---\n' + (exc.stdout.decode(errors='replace') if isinstance(exc.stdout, bytes) else exc.stdout or '') + '\n' + (exc.stderr.decode(errors='replace') if isinstance(exc.stderr, bytes) else exc.stderr or '')
        log.write_text(output, encoding='utf-8')
        return 124
    finally:
        if server.poll() is None:
            server.terminate()
            try: server.wait(timeout=5)
            except subprocess.TimeoutExpired: server.kill(); server.wait()

def main():
    results = []
    for suite in (sys.argv[1:] or SUITES):
        code = run_one(suite); results.append((suite, code)); print(f'{suite}: {"PASS" if code == 0 else "FAIL"} (exit={code})', flush=True)
    (OUT / 'summary.txt').write_text('\n'.join(f'{s}: {"PASS" if c == 0 else "FAIL"} exit={c}' for s,c in results) + '\n', encoding='utf-8')
    raise SystemExit(0 if all(code == 0 for _, code in results) else 1)
if __name__ == '__main__': main()
