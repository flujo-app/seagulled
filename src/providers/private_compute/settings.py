"""Deployment settings and the vLLM command line. No Modal import: unit-testable."""
import json
import os
import re
from dataclasses import dataclass

# Qwen3.8-27B: 16 of 64 layers are full attention (4 KV heads x 256 dims);
# the 48 Gated DeltaNet layers keep a constant-size state.
NATIVE_CONTEXT = 262_144
MAX_YARN_CONTEXT = 1_000_000
KV_BYTES_PER_TOKEN_BF16 = 16 * 2 * 4 * 256 * 2
GPU_MEMORY_GIB = {'L40S': 48, 'A100-80GB': 80, 'H100': 80, 'H200': 141, 'B200': 180}
KV_DTYPES = ('auto', 'bf16', 'fp8')


@dataclass(frozen=True)
class Settings:
    app_name: str = 'seagulled-unconfigured'
    model: str = 'Qwen/Qwen3.8-27B-FP8'
    revision: str = '017b9c7af6b5689d5dd426a76e0bc077eb5ca20a'
    served_name: str = 'qwen3.8-27b'
    weights_gib: float = 30.9
    gpu: str = 'H100'
    max_model_len: int = 600_000
    kv_cache_dtype: str = 'auto'
    gpu_memory_utilization: float = 0.95
    enable_thinking: bool = False
    tool_call_parser: str = 'qwen3_xml'
    reasoning_parser: str = 'qwen3'
    max_num_seqs: int = 512
    scaledown_minutes: int = 1
    vllm_version: str = '0.30.0'
    port: int = 8000

    def __post_init__(self):
        if self.gpu not in GPU_MEMORY_GIB:
            raise ValueError(f'unknown gpu {self.gpu!r}; expected one of {sorted(GPU_MEMORY_GIB)}')
        if not 1024 <= self.max_model_len <= MAX_YARN_CONTEXT:
            raise ValueError(f'max_model_len must be within 1024..{MAX_YARN_CONTEXT}')
        if self.kv_cache_dtype not in KV_DTYPES:
            raise ValueError(f'kv_cache_dtype must be one of {KV_DTYPES}')
        if not 0.5 <= self.gpu_memory_utilization <= 0.98:
            raise ValueError('gpu_memory_utilization must be within 0.5..0.98')
        if not 1 <= self.scaledown_minutes <= 20:
            raise ValueError('scaledown_minutes must be within 1..20 (Modal limit)')

    @property
    def yarn_factor(self):
        """Smallest documented RoPE scale covering max_model_len; None at native length."""
        if self.max_model_len <= NATIVE_CONTEXT:
            return None
        return 2.0 if self.max_model_len <= 2 * NATIVE_CONTEXT else 4.0

    def estimate_gib(self):
        """Calculated single-request memory need. An estimate, not a measurement."""
        per_token = KV_BYTES_PER_TOKEN_BF16 / (2 if self.kv_cache_dtype == 'fp8' else 1)
        kv = self.max_model_len * per_token / 2**30
        usable = GPU_MEMORY_GIB[self.gpu] * self.gpu_memory_utilization
        return {'weights': self.weights_gib, 'kv_cache': round(kv, 1),
                'total': round(self.weights_gib + kv, 1), 'usable': round(usable, 1),
                'fits': self.weights_gib + kv <= usable}

    def vllm_command(self):
        command = ['vllm', 'serve', self.model, '--revision', self.revision,
                   '--served-model-name', self.served_name,
                   '--host', '0.0.0.0', '--port', str(self.port),
                   '--max-model-len', str(self.max_model_len),
                   '--gpu-memory-utilization', str(self.gpu_memory_utilization),
                   '--kv-cache-dtype', self.kv_cache_dtype,
                   # Each sequence reserves one DeltaNet state block; vLLM's default of
                   # 1024 does not fit beside a long-context cache.
                   '--max-num-seqs', str(self.max_num_seqs),
                   '--enable-prefix-caching', '--middleware', 'discovery.models_metadata',
                   '--enable-auto-tool-choice', '--tool-call-parser', self.tool_call_parser,
                   '--reasoning-parser', self.reasoning_parser,
                   '--default-chat-template-kwargs',
                   json.dumps({'enable_thinking': self.enable_thinking})]
        if self.yarn_factor:
            # Long-context override from the Qwen3.8-27B model card.
            rope = {'mrope_interleaved': True, 'mrope_section': [11, 11, 10], 'rope_type': 'yarn',
                    'rope_theta': 10000000, 'partial_rotary_factor': 0.25,
                    'factor': self.yarn_factor, 'original_max_position_embeddings': NATIVE_CONTEXT}
            command += ['--hf-overrides', json.dumps({'text_config': {'rope_parameters': rope}})]
        return command


def from_env(env=None):
    """Only a product-owned name may select a deployment target."""
    env = os.environ if env is None else env
    name = env.get('SEAGULLED_PRIVATE_APP_NAME', '')
    if not re.fullmatch(r'seagulled-qwen-[a-f0-9]{12}', name):
        raise ValueError('A unique Seagulled-owned app name is required.')
    return Settings(app_name=name)
