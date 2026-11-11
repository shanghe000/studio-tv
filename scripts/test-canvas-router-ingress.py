#!/usr/bin/env python3
"""Replay 5 STUDIO model captures via real signed HTTP, disposable PG, worker and provider adapters."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--router', type=Path, default=root.parent / 'studio-model-router')
opts = parser.parse_args()
for key in ('STUDIO_CANVAS_ROUTER_REQUESTS', 'STUDIO_CANVAS_MEDIA_DIR', 'TEST_DATABASE_URL'):
    if not os.environ.get(key):
        parser.error('missing '+key)
router = opts.router.resolve()
templates = root / 'tools/canvas-router-audit'
with tempfile.TemporaryDirectory() as tmp:
    files = {}
    for name in ('ingress', 'shared', 'ingress_backends'):
        source = (templates / (name + '.inc')).read_text()
        if name == 'shared':
            source = 'package httpapi\n' + source
        path = Path(tmp) / ('studiotv_canvas_' + name + '_test.go')
        path.write_text(source)
        files[str(router / 'internal/adapters/httpapi' / path.name)] = str(path)
    # The official adapter pins provider hosts; substitute only its http.Transport
    # using an overlay-only Go method so no real official request can be sent.
    helper = Path(tmp) / 'studiotv_canvas_test_transport.go'
    helper.write_text((templates / 'official_http_transport.inc').read_text())
    files[str(router / 'internal/adapters/officialvideo' / helper.name)] = str(helper)
    cfg = Path(tmp) / 'overlay.json'
    cfg.write_text(json.dumps({'Replace': files}))
    subprocess.run(['go','test','-mod=vendor','-count=1','-overlay',str(cfg),'-v','-run','^TestCanvasAuditIngress$','./internal/adapters/httpapi'],cwd=router,check=True)
