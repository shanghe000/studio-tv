"""Validate the independent infrastructure protocol and copied artifacts."""
from copy import deepcopy
import json
from pathlib import Path
import unittest

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from openapi_spec_validator import validate
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[2]
SPEC = json.loads((ROOT / 'contracts/models-router.json').read_text())
URI = 'https://studio.example.invalid/models-router.json'
REGISTRY = Registry().with_resource(URI, Resource(SPEC, DRAFT202012))


def errors(name, value):
    return list(Draft202012Validator(
        {'$ref': URI + '#/components/schemas/' + name},
        registry=REGISTRY, format_checker=FormatChecker()).iter_errors(value))


class ModelsRouterContractTests(unittest.TestCase):
    def test_openapi_and_artifacts(self):
        validate(SPEC)
        self.assertEqual(SPEC, yaml.safe_load((ROOT / 'contracts/models-router.yaml').read_text()))
        # The independent repository is not required to build the STUDIO artifact.
        router = ROOT.parent / 'studio-model-router/contracts/models-router.json'
        if router.exists():
            self.assertEqual(SPEC, json.loads(router.read_text()))

    def test_explicit_implemented_and_reserved_boundary(self):
        operations = [(path, method, op) for path, item in SPEC['paths'].items()
                      for method, op in item.items() if method in {'get', 'post', 'delete', 'patch'}]
        self.assertEqual(11, len(operations))
        self.assertEqual(11, len({op['operationId'] for _, _, op in operations}))
        implemented = {(method, path) for path, method, op in operations
                       if op['x-implementation-status'] == 'IMPLEMENTED'}
        self.assertEqual(implemented, {('get', '/healthz'), ('get', '/readyz'),
                                     ('post', '/v1/sessions'), ('get', '/v1/sessions/{sessionRef}'),
                                     ('get', '/v1/capabilities'),
                                     ('post', '/v1/invocations'), ('get', '/v1/invocations/{invocationRef}'),
                                     ('get', '/v1/invocations/{invocationRef}/events'),
                                     ('post', '/v1/invocations/{invocationRef}/cancel'),
                                     ('get', '/v1/artifacts/{artifactRef}/content')})
        self.assertEqual({('post', '/v1/invocations/{invocationRef}/tool-results')},
                         {(method, path) for path, method, op in operations if op['x-implementation-status']=='RESERVED'})
        for path, _, op in operations:
            if op['x-implementation-status'] == 'RESERVED':
                self.assertIn('501', op['responses'], path)

    def test_usage_preserves_unknowns_and_non_token_units(self):
        value = {'scope': 'INVOCATION', 'source': 'REPORTED', 'coverage': 'PRIMARY_THREAD',
                 'inputTokens': 42, 'cachedInputTokens': 0, 'cacheWriteInputTokens': None,
                 'outputTokens': None, 'reasoningOutputTokens': None, 'totalTokens': None,
                 'status': 'PARTIAL', 'observedAt': '2026-10-05T00:00:00Z',
                 'units': [{'unit': 'VIDEO_SECOND', 'quantity': '5.5', 'source': 'REPORTED'}]}
        self.assertFalse(errors('Usage', value))
        for change in ({'inputTokens': -1}, {'scope': 'ACCOUNT'}, {'coverage': 'ALL_USERS'},
                       {'units': [{'unit': 'VIDEO_SECOND', 'quantity': 5.5, 'source': 'REPORTED'}]}):
            bad = deepcopy(value)
            bad.update(change)
            self.assertTrue(errors('Usage', bad))

    def test_context_and_cost_are_separate_nullable_measurements(self):
        context = {'windowTokens': None, 'usedTokens': None, 'remainingTokensEstimate': None,
                   'reservedOutputTokens': None, 'measurement': 'UNAVAILABLE',
                   'compactionCount': None, 'observedAt': None}
        billing = {'mode': 'UNKNOWN', 'currency': None, 'actualAmount': None,
                   'estimatedAmount': None, 'pricingRevision': None}
        self.assertFalse(errors('ContextUsage', context))
        self.assertFalse(errors('Billing', billing))
        billed = dict(billing, mode='ESTIMATED', currency='USD', estimatedAmount='0.000123456789',
                      pricingRevision='2026-10-example')
        self.assertFalse(errors('Billing', billed))
        self.assertTrue(errors('Billing', dict(billed, estimatedAmount=0.000123456789)))
        self.assertTrue(errors('ContextUsage', dict(context, remainingTokensEstimate=-1)))

    def test_session_hides_native_runtime_identity(self):
        value = {'sessionRef': 'sess_' + 'A' * 32, 'conversationRef': 'conv_1', 'state': 'OPEN',
                 'createdAt': '2026-10-05T00:00:00Z', 'updatedAt': '2026-10-05T00:00:00Z',
                 'contextCheckpoint': None, 'runtimeMetadata': None}
        self.assertFalse(errors('Session', value))
        self.assertTrue(errors('Session', dict(value, nativeThreadId='private-thread')))
        self.assertTrue(errors('Session', dict(value, ownerId='browser-user')))

    def test_model_requests_allow_independent_generation_and_scoped_media(self):
        image = {'schemaVersion': '1', 'operationRef': 'attempt_image',
                 'capability': {'ref': 'image.generate', 'version': '1'},
                 'input': [{'type': 'TEXT', 'text': '简洁的图形轮廓'}],
                 'attachments': [], 'parameters': {'width': 1024, 'height': 1024},
                 'parameterSchemaVersion': '1'}
        self.assertFalse(errors('InvocationRequest', image))
        self.assertFalse(errors('InvocationRequest', dict(image, sessionRef=None)))
        chat = dict(image, capability={'ref': 'chat.general', 'version': '1'},
                    sessionRef='sess_' + 'A' * 32,
                    correlation={'conversationRef': 'conv_1'}, parameters={})
        self.assertFalse(errors('InvocationRequest', chat))
        video = dict(image, operationRef='attempt_video',
                     capability={'ref': 'video.from-image', 'version': '1'},
                     input=[{'type': 'TEXT', 'text': '镜头缓慢推进'},
                            {'type': 'MEDIA', 'attachmentRef': 'first_frame'}],
                     attachments=[{'ref': 'first_frame', 'sourceRef': 'asset_1',
                                   'kind': 'IMAGE', 'sourceVersion': '1', 'sha256': 'a' * 64,
                                   'readGrantRef': 'grant_1'}],
                     parameters={'durationSeconds': 5, 'fps': 24}, sessionRef=None)
        self.assertFalse(errors('InvocationRequest', video))
        for key in ('clientApp', 'subjectRef', 'nativeThreadId', 'backendEndpoint'):
            self.assertTrue(errors('InvocationRequest', dict(video, **{key: 'untrusted'})))
        for field in ('readGrantRef', 'sourceVersion', 'sha256'):
            bad = deepcopy(video)
            del bad['attachments'][0][field]
            self.assertTrue(errors('InvocationRequest', bad), field)
        for field in ('url', 'path'):
            bad = deepcopy(video)
            bad['attachments'][0][field] = 'untrusted'
            self.assertTrue(errors('InvocationRequest', bad), field)

    def test_session_mode_consistency_and_legacy_capabilities(self):
        capability = {'capabilityRef': 'image.generate', 'version': '1',
                      'kind': 'TEXT_TO_IMAGE', 'executionKind': 'MODEL',
                      'parameterSchemaVersion': '1', 'parameterSchema': {'type': 'object'},
                      'inputKinds': ['TEXT'], 'outputKinds': ['IMAGE'],
                      'supportsSession': False, 'supportsStream': False, 'supportsCancel': False,
                      'available': False, 'reason': 'UNCONFIGURED'}
        self.assertFalse(errors('Capability', capability))
        self.assertFalse(errors('Capability', dict(capability, sessionMode='NONE')))
        for mode in ('OPTIONAL', 'REQUIRED'):
            self.assertFalse(errors('Capability', dict(capability, sessionMode=mode, supportsSession=True)))
            self.assertTrue(errors('Capability', dict(capability, sessionMode=mode)))
        self.assertTrue(errors('Capability', dict(capability, sessionMode='NONE', supportsSession=True)))
        self.assertTrue(errors('Capability', dict(capability, sessionMode='FOREVER')))

    def test_multimodal_results_preserve_unknown_progress_and_context(self):
        artifact = {'artifactRef': 'artifact_1', 'outputRef': 'output_1', 'kind': 'IMAGE',
                    'mediaType': 'image/png', 'sizeBytes': 500, 'sha256': 'b' * 64,
                    'expiresAt': None}
        value = {'invocationRef': 'invocation_1', 'operationRef': 'attempt_1', 'sessionRef': None,
                 'state': 'SUCCEEDED', 'progress': None, 'normalizedError': None,
                 'outputParts': [{'outputRef': 'output_1', 'type': 'ARTIFACT', 'artifactRef': 'artifact_1'}],
                 'artifacts': [artifact], 'execution': None, 'usage': None, 'context': None,
                 'billing': None, 'createdAt': '2026-10-05T00:00:00Z',
                 'updatedAt': '2026-10-05T00:00:01Z'}
        self.assertFalse(errors('Invocation', value))
        video = deepcopy(value)
        video['artifacts'][0].update(kind='VIDEO', mediaType='video/mp4')
        self.assertFalse(errors('Invocation', video))
        for change in ({'progress': 2}, {'context': {'remainingTokensEstimate': 0}},
                       {'artifacts': None}, {'outputParts': None}, {'backendJobId': 'private'}):
            self.assertTrue(errors('Invocation', dict(value, **change)))
        self.assertTrue(errors('Artifact', dict(artifact, kind='UNKNOWN')))
        self.assertTrue(errors('Artifact', dict(artifact, url='https://provider.test/output.png')))

    def test_progress_events_bind_type_to_data(self):
        event = {'sequence': 1, 'invocationRef': 'invocation_1', 'type': 'progress.updated',
                 'schemaVersion': '1', 'observedAt': '2026-10-05T00:00:00Z',
                 'data': {'progress': None}}
        self.assertFalse(errors('Event', event))
        self.assertFalse(errors('Event', dict(event, data={'progress': 0.25})))
        self.assertTrue(errors('Event', dict(event, data={'progress': -0.1})))
        self.assertTrue(errors('Event', dict(event, data={'outputRef': 'output_1', 'delta': 'hello'})))
        self.assertTrue(errors('Event', dict(event, type='text.delta')))

    def test_all_schema_examples_are_valid(self):
        examples_checked = 0
        for name, schema in SPEC['components']['schemas'].items():
            for example in schema.get('examples', []):
                self.assertFalse(errors(name, example), name)
                examples_checked += 1
        self.assertGreaterEqual(examples_checked, 7)

    def test_example_parameters_use_capability_specific_schemas(self):
        schemas = SPEC['components']['schemas']
        capabilities = {(c['capabilityRef'], c['version']): c
                        for c in schemas['Capability']['examples']}
        for request in schemas['InvocationRequest']['examples']:
            key = (request['capability']['ref'], request['capability']['version'])
            capability = capabilities[key]
            self.assertEqual(request['parameterSchemaVersion'], capability['parameterSchemaVersion'])
            parameter_schema = capability['parameterSchema']
            Draft202012Validator.check_schema(parameter_schema)
            validator = Draft202012Validator(parameter_schema)
            self.assertFalse(list(validator.iter_errors(request['parameters'])), key)
            unbounded = dict(request['parameters'], extra_body={'nativeOption': True})
            self.assertTrue(list(validator.iter_errors(unbounded)), key)


if __name__ == '__main__':
    unittest.main()
