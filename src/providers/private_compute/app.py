"""Private Qwen3.8-27B on one Modal GPU, served by vLLM itself.

vLLM answers /v1/chat/completions, /v1/responses and /v1/messages directly;
there is no translation layer here. Access is the bearer token in the
`<app>-auth` Modal secret, enforced by vLLM's --api-key.
"""
import modal

from settings import from_env

SETTINGS = from_env()
MINUTES = 60

image = (
    modal.Image.from_registry('nvidia/cuda:12.9.0-devel-ubuntu22.04', add_python='3.12')
    .entrypoint([])
    .uv_pip_install(f'vllm=={SETTINGS.vllm_version}')
    .env({'HF_XET_HIGH_PERFORMANCE': '1', 'VLLM_ALLOW_LONG_MAX_MODEL_LEN': '1',
          # Settings are frozen into the image so the container serves what was deployed.
          **{'O_INFER_' + key.upper(): str(value) for key, value in vars(SETTINGS).items()}})
    .add_local_python_source('settings', 'discovery')
)

app = modal.App(SETTINGS.app_name)
hf_cache = modal.Volume.from_name(SETTINGS.app_name + '-hf-cache', create_if_missing=True)
vllm_cache = modal.Volume.from_name(SETTINGS.app_name + '-vllm-cache', create_if_missing=True)
auth = modal.Secret.from_name(SETTINGS.app_name + '-auth', required_keys=['VLLM_API_KEY'])


@app.function(image=image, gpu=SETTINGS.gpu, cpu=8, memory=65536, secrets=[auth],
              volumes={'/root/.cache/huggingface': hf_cache, '/root/.cache/vllm': vllm_cache},
              scaledown_window=SETTINGS.scaledown_minutes * MINUTES,
              min_containers=0, max_containers=1,
              timeout=30 * MINUTES)
@modal.concurrent(max_inputs=SETTINGS.max_num_seqs)
# A web_server endpoint holds requests while a cold container starts (a Flash
# `@app.server` endpoint answered 503 immediately, which clients report as an error).
# Modal's own auth stays off; vLLM checks the bearer token (VLLM_API_KEY).
@modal.web_server(port=SETTINGS.port, startup_timeout=30 * MINUTES)
def inference():
    import os
    import subprocess
    if len(os.environ['VLLM_API_KEY']) < 32:
        raise RuntimeError('INFERENCE_AUTH_NOT_CONFIGURED')
    # /root holds settings.py and discovery.py; vLLM imports the middleware by name.
    subprocess.Popen(SETTINGS.vllm_command(), env={**os.environ, 'PYTHONPATH': '/root'})
