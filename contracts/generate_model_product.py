#!/usr/bin/env python3
"""Generate the implemented STUDIO model-discovery extension using only stdlib."""
import json
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parent
router = json.loads((ROOT / 'models-router.json').read_text())


def obj(properties, required=None):
    return {'type': 'object', 'additionalProperties': False,
            'properties': properties, 'required': required if required is not None else list(properties)}


def ref(name):
    return {'$ref': '#/components/schemas/' + name}


string = {'type': 'string'}
kind = {'type': 'string', 'pattern': '^[A-Z][A-Z0-9_]{0,63}$'}
strings = {'type': 'array', 'items': string}
schemas = {
    'Capability': deepcopy(router['components']['schemas']['Capability']),
    'Requirement': obj({'id': string, 'title': string, 'kind': kind,
                        'priority': {'enum': ['P0', 'P1', 'P2']},
                        'inputKinds': strings, 'outputKinds': strings, 'features': strings}),
    'ErrorDetail': obj({'field': string, 'code': string, 'message': string}),
    'Error': obj({'code': string, 'message': string, 'requestId': string,
                  'retryable': {'type': 'boolean'}, 'details': {'type': 'array', 'items': ref('ErrorDetail')}}),
}
if 'ModelDescriptor' in router['components']['schemas']:
    schemas['ModelDescriptor'] = deepcopy(router['components']['schemas']['ModelDescriptor'])


def envelope(data):
    return obj({'code': {'const': 0}, 'message': string, 'requestId': string, 'data': data})


schemas['RequirementResponse'] = envelope(obj({
    'items': {'type': 'array', 'items': ref('Requirement')}, 'schemaVersion': {'const': '1'}}))
schemas['CapabilityResponse'] = envelope(obj({
    'items': {'type': 'array', 'items': ref('Capability')},
    'nextCursor': {'type': ['string', 'null']}, 'schemaVersion': {'const': '1'}}))


def response(description, schema):
    return {'description': description, 'content': {'application/json': {'schema': ref(schema)}}}


def operation(operation_id, summary, result, parameters=None):
    return {'operationId': operation_id, 'summary': summary,
            'x-implementation-status': 'IMPLEMENTED', 'x-required-capability': 'tv.access',
            'security': [{'SessionBearer': []}], 'parameters': parameters or [],
            'responses': {'200': response('Actual data. Product requirements do not imply available models.', result),
                          '400': response('Invalid/duplicate/unknown query', 'Error'),
                          '401': response('Verified Feishu session required', 'Error'),
                          '403': response('Live tool access denied', 'Error'),
                          '501': response('MODEL_ROUTER_NOT_CONFIGURED on capability discovery when no adapter is configured', 'Error'),
                          '503': response('Actual Router catalog unavailable, no fallback', 'Error')}}


spec = {
    'openapi': '3.1.0', 'jsonSchemaDialect': 'https://json-schema.org/draft/2020-12/schema',
    'info': {'title': 'Studio TV model discovery', 'version': '1.1.0',
             'description': 'Implemented read-only product intent and actual Router catalog. No pricing, wallet, model execution or example-model registration. Actor comes only from verified local identity.'},
    'servers': [{'url': '/api/v2'}],
    'paths': {
        '/model-requirements': {'get': operation('productModelRequirements', 'STUDIO feature capability requirements, not a model catalog', 'RequirementResponse')},
        '/model-capabilities': {'get': operation('productModelCapabilities', 'Actual capabilities from configured Models Router', 'CapabilityResponse', [
            {'name': 'kind', 'in': 'query', 'schema': kind},
            {'name': 'limit', 'in': 'query', 'schema': {'type': 'integer', 'minimum': 1, 'maximum': 100, 'default': 100}},
            {'name': 'cursor', 'in': 'query', 'schema': {'type': 'string', 'maxLength': 2000}, 'description': 'Opaque Router cursor. Current empty Router catalog supports only empty cursor.'},
        ])},
    },
    'components': {'securitySchemes': {'SessionBearer': {'type': 'http', 'scheme': 'bearer'}}, 'schemas': schemas},
}
data = json.dumps(spec, ensure_ascii=False, indent=2) + '\n'
for suffix in ('json', 'yaml'):
    (ROOT / ('model-product-extension.' + suffix)).write_text(data)
