#!/usr/bin/env bash
set -euo pipefail
python3 - <<'CANARY'
import json
import os
from pathlib import Path
import subprocess
import tempfile

try:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / 'docker-compose.yml').write_bytes(Path('docker-compose.yml').read_bytes())
        (root / '.env').write_text('')
        # Disposable inputs only; caller overrides and production .env stay unread.
        env = {k: v for k, v in os.environ.items() if k in ['PATH', 'HOME', 'DOCKER_CONFIG']}
        env.update({'POSTGRES_PASSWORD': 'fixture-only', 'REDIS_PASSWORD': 'fixture-only'})
        for override, expected in [(None, 'http://model-connector:3900'),
                                   ('https://health.example.org', 'https://health.example.org')]:
            selected = dict(env)
            if override is not None:
                selected['MODEL_CONNECTOR_HEALTH_URL'] = override
            result = subprocess.run(['docker', 'compose', '--project-directory', str(root),
                                     '-f', str(root / 'docker-compose.yml'), 'config', '--format', 'json'],
                                    env=selected, capture_output=True, text=True, timeout=30)
            assert result.returncode == 0
            app = json.loads(result.stdout)['services']['assistant']
            assert app['environment']['MODEL_CONNECTOR_HEALTH_URL'] == expected
            assert app['environment']['MODEL_CONNECTOR_BASE_URL'] == 'http://connector.arcanada.one:3900'
            assert 'default' in app['networks']
    print('PASS native Compose health default, HTTPS override and execution route')
except Exception:
    raise SystemExit('REFUSED native Compose health route contract') from None
CANARY
