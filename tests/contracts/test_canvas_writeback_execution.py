"""Offline contract checks for the opt-in basic-node server writeback receipt."""
import copy
import json
from pathlib import Path
import unittest

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[2]
SPEC = json.loads((ROOT / 'contracts/execution-extension.json').read_text())
URI = 'https://contracts.studio.invalid/execution'
REGISTRY = Registry().with_resource(URI, Resource(SPEC, DRAFT202012))
CANVAS = SPEC['paths']['/api/v2/canvas-runs']['post']['requestBody']['content']['application/json']['schema']


def errors(schema, value):
    return list(Draft202012Validator(schema, registry=REGISTRY).iter_errors(value))


def schema(name):
    return {'$ref': URI + '#/components/schemas/' + name}


def task():
    return {'id': 'tsk_a', 'projectId': 'project_a', 'kind': 'CANVAS',
            'targetType': 'NODE', 'targetId': 'node_a', 'name': 'Canvas',
            'state': 'QUEUED', 'revision': 1, 'plans': [
                {'nodeId': 'node_a', 'executionId': 'execution_a',
                 'state': 'QUEUED', 'capabilityRef': 'fixture',
                 'capabilityVersion': '1', 'parameters': {}, 'outputs': [],
                 'testMode': True}], 'testMode': True,
            'createdAt': '2026-10-06T00:00:00Z',
            'updatedAt': '2026-10-06T00:00:00Z'}


class CanvasWritebackExecution(unittest.TestCase):
    def test_expected_revision_is_optional_and_only_opts_in_node_execution(self):
        request = {'projectId': 'project_a', 'targetType': 'NODE',
                   'targetId': 'node_a', 'graph': {'nodes': [
                       {'id': 'node_a', 'type': 'rh-text', 'data': {}}],
                       'edges': []}}
        self.assertFalse(errors(CANVAS, request))
        self.assertFalse(errors(CANVAS, {**request, 'expectedRevision': 8}))
        for value in [0, -1, '8', 1.5, 9223372036854775808]:
            with self.subTest(value=value):
                self.assertTrue(errors(CANVAS, {**request, 'expectedRevision': value}))
        for target in ['GROUP', 'CANVAS']:
            legacy = {**request, 'targetType': target}
            self.assertFalse(errors(CANVAS, legacy))
            self.assertTrue(errors(CANVAS, {**legacy, 'expectedRevision': 8}))
        self.assertTrue(errors(CANVAS, {**request, 'targetId': '', 'expectedRevision': 8}))

    def test_request_cannot_supply_private_binding_or_public_server_authority(self):
        request = {'projectId': 'project_a', 'targetType': 'NODE',
                   'targetId': 'node_a', 'graph': {'nodes': [], 'edges': []},
                   'expectedRevision': 1}
        for key, value in [('canvasManaged', True), ('canvasBinding', {'applicationState': 'APPLIED'}),
                           ('inputGuard', 'private'), ('nodeVersion', 1), ('ownerId', 'other')]:
            with self.subTest(key=key):
                self.assertTrue(errors(CANVAS, {**request, key: value}))
        properties = SPEC['components']['schemas']
        self.assertTrue(properties['Task']['properties']['canvasManaged']['readOnly'])
        self.assertTrue(properties['Plan']['properties']['canvasBinding']['readOnly'])

    def test_legacy_task_receipts_remain_valid_without_server_markers(self):
        legacy = task()
        self.assertFalse(errors(schema('Task'), legacy))
        self.assertFalse(errors(schema('Task'), {**legacy, 'canvasManaged': False}))
        legacy['plans'][0]['canvasBinding'] = {'applicationState': 'PENDING'}
        self.assertTrue(errors(schema('Task'), legacy))
        self.assertTrue(errors(schema('Task'), {**legacy, 'canvasManaged': False}))

    def test_managed_task_requires_one_bound_basic_node_plan(self):
        managed = {**task(), 'canvasManaged': True}
        self.assertTrue(errors(schema('Task'), managed))
        managed['plans'][0]['canvasBinding'] = {'applicationState': 'PENDING'}
        self.assertFalse(errors(schema('Task'), managed))
        for state, application in [('SUCCEEDED', 'APPLIED'), ('FAILED', 'APPLIED'),
                                   ('CANCELED', 'APPLIED'), ('SUCCEEDED', 'DETACHED')]:
            candidate = copy.deepcopy(managed)
            candidate['state'] = candidate['plans'][0]['state'] = state
            candidate['plans'][0]['canvasBinding'] = {'applicationState': application}
            if application == 'DETACHED':
                candidate['plans'][0]['canvasBinding']['reason'] = 'NODE_CHANGED'
            self.assertFalse(errors(schema('Task'), candidate))
        for key, value in [('kind', 'ASSISTANT'), ('targetType', 'GROUP'),
                           ('projectId', None), ('plans', []),
                           ('plans', managed['plans'] * 2), ('canvasManaged', 'true')]:
            with self.subTest(key=key):
                self.assertTrue(errors(schema('Task'), {**managed, key: value}))
        managed['plans'][0]['state'] = 'WAITING_TOOL'
        self.assertTrue(errors(schema('Task'), managed))

    def test_binding_receipt_excludes_unknown_states_and_private_evidence(self):
        valid = {'applicationState': 'DETACHED', 'reason': 'OUTPUT_UNAVAILABLE'}
        self.assertFalse(errors(schema('CanvasBinding'), valid))
        for key, value in [('applicationState', 'SUCCESS'), ('reason', ''),
                           ('reason', 'x' * 201), ('taskId', 'task_a'),
                           ('inputGuard', 'private'), ('inputVersions', {}),
                           ('providerRef', 'private'), ('nodeVersion', 1)]:
            with self.subTest(key=key):
                self.assertTrue(errors(schema('CanvasBinding'), {**valid, key: value}))
        public = task()
        for key, value in [('expectedRevision', 1), ('ownerId', 'private'),
                           ('nodeVersions', {'node_a': 1})]:
            self.assertTrue(errors(schema('Task'), {**public, key: value}))


if __name__ == '__main__':
    unittest.main()
