"""Offline checks for consistent JSON replay and bounded authenticated SSE."""
import copy
import json
from pathlib import Path
import unittest

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from openapi_spec_validator import validate
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[2] / 'contracts'
NAME = 'canvas-sync-implemented-extension'
DOC = json.loads((ROOT / (NAME + '.json')).read_text())
URI = 'https://contracts.rhtv.local/'
REGISTRY = Registry().with_resources([
    (URI + name, Resource(json.loads((ROOT / name).read_text()), DRAFT202012))
    for name in [NAME + '.json', 'openapi.json']
])


def errors(schema, value):
    return list(Draft202012Validator(
        {'$ref': URI + NAME + '.json#/components/schemas/' + schema},
        registry=REGISTRY, format_checker=FormatChecker()).iter_errors(value))


class CanvasSyncContract(unittest.TestCase):
    def test_valid_openapi_parity_and_honest_bounded_transport_scope(self):
        validate(DOC, base_uri=(ROOT / (NAME + '.json')).as_uri())
        self.assertEqual(yaml.safe_load((ROOT / (NAME + '.yaml')).read_text()), DOC)
        self.assertEqual(DOC['x-implementation-stage'], 'IMPLEMENTED')
        self.assertTrue(DOC['x-implemented-subset']['nodeExecutionAvailable'])
        self.assertIn('targetType NODE', DOC['x-implemented-subset']['nodeExecutionScope'])
        operations = [op for path in DOC['paths'].values() for op in path.values()]
        self.assertEqual(len(operations), 2)
        self.assertEqual(len({op['operationId'] for op in operations}), 2)
        for path in DOC['paths'].values():
            self.assertEqual(set(path), {'get'})
            op = path['get']
            self.assertEqual(op['security'], [{'BearerAuth': []}])
            expected = {'application/json'}
            if op['operationId'] == 'listCanvasProjectEvents':
                expected.add('text/event-stream')
            self.assertEqual(set(op['responses']['200']['content']), expected)
            for code in ['401', '403', '404', '503']:
                self.assertIn(code, op['responses'])

    def test_stream_limits_preserve_bounded_transport_with_basic_node_projection(self):
        limits = DOC['x-implemented-subset']['streamLimits']
        self.assertEqual(limits['lifetimeSeconds'], 30)
        self.assertEqual(limits['maxConnectionsPerUser'], 8)
        self.assertEqual(limits['maxConnectionsPerProcess'], 128)
        self.assertEqual(limits['maxDeliveredEvents'], 1024)
        self.assertEqual(limits['maxEventFrameBytes'], 8 * 1024 * 1024)
        self.assertEqual(limits['operationTimeoutSeconds'], 5)
        events = DOC['paths']['/api/v2/projects/{projectId}/events']['get']
        self.assertIn('429', events['responses'])
        self.assertIn('501', events['responses'])
        self.assertNotIn('410', events['responses'])
        self.assertIn('1 second is the empty-page poll interval', events['description'])

    def test_stream_error_is_control_without_sequence_or_cursor(self):
        control = {'status': 403, 'code': 'IPAC_PERMISSION_DENIED',
                   'message': 'permission revoked', 'requestId': 'req_a',
                   'retryable': False, 'details': []}
        self.assertFalse(errors('StreamError', control))
        for key, value in [('sequence', '1'), ('eventCursor', '1'),
                           ('projectId', 'project_a'), ('accessToken', 'secret')]:
            self.assertTrue(errors('StreamError', {**control, key: value}))
        self.assertTrue(errors('StreamError', {**control, 'status': 200}))
        self.assertTrue(errors('ProjectEvent', control))

    def test_snapshot_accepts_only_current_server_binding_shapes_and_legacy_empty_states(self):
        snapshot = {'schemaVersion': '1', 'projectId': 'project_a',
                    'graph': {'schemaVersion': '1', 'nodes': [], 'edges': [],
                              'viewport': {'x': 0, 'y': 0, 'zoom': 1}},
                    'graphRevision': 3, 'eventCursor': '9007199254740993',
                    'updatedAt': '2026-10-06T12:00:00Z',
                    'nodeStates': [], 'nodeExecutionAvailable': False}
        self.assertFalse(errors('LiveSnapshot', snapshot))
        self.assertFalse(errors('LiveSnapshot', {**snapshot, 'nodeExecutionAvailable': True}))
        state = {'nodeId': 'node_a', 'taskId': 'task_a', 'executionId': 'exec_a',
                 'state': 'SUCCEEDED', 'applicationState': 'APPLIED'}
        managed = {**snapshot, 'nodeExecutionAvailable': True,
                   'nodeStates': [state]}
        managed['graph'] = {**snapshot['graph'], 'nodes': [
            {'id': 'node_a', 'type': 'rh-text', 'position': {'x': 0, 'y': 0},
             'data': {'text': 'server result'}}]}
        self.assertFalse(errors('LiveSnapshot', managed))
        for key, value in [('nodeExecutionAvailable', 'true'),
                           ('nodeStates', [{'status': 'SUCCEEDED'}]),
                           ('nodeStates', [state]),
                           ('eventCursor', 9007199254740993),
                           ('eventCursor', '01'), ('eventCursor', '-1')]:
            with self.subTest(key=key, value=value):
                self.assertTrue(errors('LiveSnapshot', {**snapshot, key: value}))
        for key, value in [('taskId', ''), ('state', 'WAITING_TOOL'),
                           ('applicationState', 'SUCCESS'), ('reason', ''),
                           ('providerToken', 'private')]:
            with self.subTest(key=key, value=value):
                self.assertTrue(errors('NodeExecutionState', {**state, key: value}))

    def test_changed_and_invalidated_events_have_distinct_payloads(self):
        event = {'schemaVersion': '1', 'projectId': 'project_a', 'sequence': '1',
                 'occurredAt': '2026-10-06T12:00:00Z', 'source': {'kind': 'API'},
                 'type': 'canvas.invalidated',
                 'data': {'baseRevision': 1, 'graphRevision': 2,
                          'reason': 'LEGACY_GRAPH_WRITE'}}
        self.assertFalse(errors('ProjectEvent', event))
        changed = {**event, 'type': 'canvas.changed',
                   'data': {'commandId': 'cmd_a', 'baseRevision': 1,
                            'graphRevision': 2, 'delta': {
                                'nodesUpsert': [], 'nodesRemoved': ['node_a'],
                                'edgesUpsert': [], 'edgesRemoved': []}}}
        self.assertFalse(errors('ProjectEvent', changed))
        self.assertTrue(errors('ProjectEvent', {**event, 'type': 'canvas.changed'}))
        self.assertTrue(errors('ProjectEvent', {**event, 'source': {'kind': 'AGENT'}}))
        self.assertTrue(errors('ProjectEvent', {**event, 'type': 'node.result.applied'}))
        page = {'projectId': 'project_a', 'events': [changed], 'nextCursor': '1',
                'eventCursor': '8', 'hasMore': True}
        self.assertFalse(errors('ProjectEventPage', page))
        invalid = copy.deepcopy(page)
        invalid['events'][0]['data']['delta']['assetUrl'] = 'https://unexpected.invalid/'
        self.assertTrue(errors('ProjectEventPage', invalid))


if __name__ == '__main__':
    unittest.main()
