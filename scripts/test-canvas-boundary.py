#!/usr/bin/env python3
"""Replay canvas commands against real STUDIO servers backed by disposable databases.

Requires TEST_DATABASE_URL, ffprobe, Node and Go. Only connects to test listeners
created by this script; no paid generation. See docs/acceptance/canvas-boundary.md.
"""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import runpy
import subprocess
import time

root = Path(__file__).resolve().parents[1]
api = root / 'apps/api-go'
parser = argparse.ArgumentParser()
parser.add_argument('cases', nargs='?', type=Path, help='captured frontend requests (JSONL)')
parser.add_argument('--out', required=True, type=Path, help='new directory for the full evidence')
parser.add_argument('--jobs', type=int, default=4, choices=range(1, 17))
mode = parser.add_mutually_exclusive_group()
mode.add_argument('--timeline', action='store_true', help='run operations in order on a single canvas')
mode.add_argument('--live', action='store_true', help='drive both multi-step graphs to synthetic result writeback')
args = parser.parse_args()
if not os.environ.get('TEST_DATABASE_URL'):
    parser.error('a disposable TEST_DATABASE_URL is required')
if args.live == bool(args.cases):
    parser.error('provide either cases.jsonl or --live')

out = args.out.resolve()
out.mkdir(exist_ok=False, parents=True)
write_media = runpy.run_path(str(root / 'tools/canvas-router-audit/media.py'))['write']
subprocess.run(['go', 'test', '-tags=canvas_boundary_audit', '-c', '-o', str(out/'studio.test'), './internal/bootstrap'], cwd=api, check=True)
entry = 'live-topology' if args.live else 'drive-boundary'
subprocess.run([str(root/'node_modules/.bin/esbuild'), f'tools/canvas-router-audit/{entry}.ts',
                '--bundle', '--platform=node', '--format=esm', '--outfile='+str(out/'drive.mjs')], cwd=root, check=True)
rows = [] if args.live else [json.loads(line) for line in args.cases.read_text().splitlines() if line.strip()]
if not rows and not args.live:
    parser.error('no captured commands in input file')
jobs = 1 if args.timeline or args.live else min(args.jobs, len(rows))


def work(index):
    d = out / str(index)
    d.mkdir()
    write_media(root, d)
    env = dict(os.environ, STUDIO_CANVAS_BOUNDARY_DIR=str(d), STUDIO_CANVAS_FIXTURE_DIR=str(d))
    cases = rows[index::jobs]
    cases_file = d/'rows.jsonl'
    cases_file.write_text(''.join(json.dumps(row)+'\n' for row in cases))
    with (d/'server.log').open('w') as log:
        server = subprocess.Popen([str(out/'studio.test'), '-test.run=^TestCanvasAuditHTTPBoundary$', '-test.v', '-test.timeout=45m'],
                                  cwd=api/'internal/bootstrap', env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(900):
                if (d/'origin').exists():
                    break
                if server.poll() is not None:
                    raise RuntimeError(f'STUDIO server failed; see {log.name}')
                time.sleep(0.1)
            else:
                raise RuntimeError(f'STUDIO server not ready; see {log.name}')
            with (d/'driver.log').open('w') as driver_log:
                base = ['node', str(out/'drive.mjs')]
                if args.live:
                    results = []
                    for complex_graph, name in [('0', 'live-topology'), ('1', 'complex-topology')]:
                        subprocess.run(base, env=dict(env, STUDIO_CANVAS_COMPLEX=complex_graph), stdout=driver_log, stderr=subprocess.STDOUT, check=True)
                        events = json.loads((d/(name+'.json')).read_text())['events']
                        results.extend(dict(event, submitted=event['ready'], operationRef=event.get('historyAfter') if event['ready'] else None) for event in events)
                else:
                    kind = 'timeline' if args.timeline else 'cases'
                    # The driver records each rejected row and keeps running. Aggregate all shard failures below.
                    command = subprocess.run([*base, str(d), str(cases_file), kind], stdout=driver_log, stderr=subprocess.STDOUT)
                    results = json.loads((d/(cases_file.name+'.'+kind+'.results.json')).read_text())
                    if command.returncode and not any(r.get('error') for r in results):
                        raise RuntimeError(f'driver failed without a diagnostic; see {driver_log.name}')
        finally:
            (d/'finished').touch()
            try:
                server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                server.terminate()
                server.wait()
    if server.returncode:
        raise RuntimeError(f'STUDIO server failed; see {d}/server.log')
    return results, json.loads((d/'invocations.json').read_text())


with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
    parts = list(pool.map(work, range(jobs)))
results = [r for part, _ in parts for r in part]
wire = [r for _, part in parts for r in part]
(out/'results.json').write_text(json.dumps(results, ensure_ascii=False))
(out/'invocations.json').write_text(json.dumps(wire))
write_media(root, out)
accepted = [r['operationRef'] for r in results if r.get('submitted')]
delivered = [r['operationRef'] for r in wire]
summary = dict(rows=28 if args.live else len(rows), checked=len(results), requests=len(wire), correct=len(accepted),
               blocked=sum(r.get('submitted') is False for r in results), errors=sum(bool(r.get('error')) for r in results))
(out/'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
print(json.dumps(summary), flush=True)
if (summary['errors'] or len(results) != summary['rows'] or len(set(accepted)) != len(accepted)
        or sorted(accepted) != sorted(delivered)):
    raise SystemExit(1)
