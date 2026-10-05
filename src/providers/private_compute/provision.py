"""Provision only the product-owned Modal app named by the host's durable journal.

The host passes the bearer through stdin. This script never prints the token or
the Modal CLI transcript; only a bounded final endpoint receipt reaches Node.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from settings import from_env


def main():
    settings = from_env()
    payload = sys.stdin.read(2049)
    if len(payload) > 2048:
        raise RuntimeError('Invalid private deployment input.')
    token = json.loads(payload).get('token')
    if not isinstance(token, str) or len(token) < 32 or len(token) > 256:
        raise RuntimeError('Private inference bearer is invalid.')
    if not settings.estimate_gib()['fits']:
        raise RuntimeError('The pinned model does not fit the selected GPU.')

    import modal

    modal.Secret.objects.create(settings.app_name + '-auth', {'VLLM_API_KEY': token},
                                allow_existing=False)
    source = Path(__file__).resolve().parent
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        result = subprocess.run([sys.executable, '-B', '-m', 'modal', 'deploy', str(source / 'app.py')],
                                cwd=source, stdout=stdout, stderr=stderr,
                                env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, check=False)
        if result.returncode:
            raise RuntimeError('The isolated Modal deployment did not complete.')
        stdout.seek(0)
        transcript = stdout.read(1_000_001)
        if len(transcript) > 1_000_000:
            raise RuntimeError('The isolated Modal deployment output exceeded its limit.')
    endpoints = set(re.findall(rb'https://[A-Za-z0-9.-]+\.modal\.(?:run|direct)',
                               re.sub(rb'\s+', b'', transcript)))
    if len(endpoints) != 1:
        raise RuntimeError('The isolated Modal endpoint could not be identified.')
    print(json.dumps({'endpoint': endpoints.pop().decode('ascii')}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'error': 'Private inference deployment is unresolved.'}))
        sys.exit(1)
