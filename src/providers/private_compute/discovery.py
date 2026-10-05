"""Model-catalogue metadata for client auto-discovery.

vLLM reports a model's size as `max_model_len`. FLUJO (and OpenRouter-style
clients) read `context_length`, `max_completion_tokens`, `supported_parameters`
and `architecture`. This vLLM `--middleware` adds those fields to
GET /v1/models; every other request passes through untouched and unbuffered.
"""
import json

SUPPORTED_PARAMETERS = ['max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'top_k',
                        'min_p', 'seed', 'stop', 'frequency_penalty', 'presence_penalty',
                        'repetition_penalty', 'logit_bias', 'logprobs', 'top_logprobs',
                        'response_format', 'structured_outputs', 'tools', 'tool_choice',
                        'reasoning', 'include_reasoning']


def enrich(catalogue, input_modalities=('text', 'image')):
    """Add discovery fields to an OpenAI model list. Existing fields are kept."""
    for model in catalogue.get('data', []):
        limit = model.get('max_model_len')
        if not isinstance(limit, int):
            continue
        model.setdefault('name', model.get('id'))
        model.setdefault('context_length', limit)
        model.setdefault('max_completion_tokens', limit)
        model.setdefault('top_provider', {'context_length': limit, 'max_completion_tokens': limit})
        model.setdefault('supported_parameters', list(SUPPORTED_PARAMETERS))
        model.setdefault('architecture', {'input_modalities': list(input_modalities),
                                          'output_modalities': ['text']})
    return catalogue


async def models_metadata(request, call_next):
    response = await call_next(request)
    if request.method != 'GET' or request.url.path.rstrip('/') != '/v1/models' or response.status_code != 200:
        return response
    from starlette.responses import Response
    raw = b''.join([chunk async for chunk in response.body_iterator])
    try:
        raw = json.dumps(enrich(json.loads(raw))).encode()
    except ValueError:
        pass
    headers = {k: v for k, v in response.headers.items() if k.lower() != 'content-length'}
    return Response(raw, status_code=200, headers=headers, media_type='application/json')
