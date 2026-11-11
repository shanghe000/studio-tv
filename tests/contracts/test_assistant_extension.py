"""The actual conversation slice, independently of the full domain blueprint."""
import json
from pathlib import Path
import unittest

import yaml
from jsonschema import Draft202012Validator
from openapi_spec_validator import validate
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[2]
SPEC = json.loads((ROOT / 'contracts/assistant-extension.json').read_text())
URI = 'https://studio.example.invalid/assistant-extension.json'
REGISTRY = Registry().with_resource(URI, Resource(SPEC, DRAFT202012))


def errors(name, value):
    return list(Draft202012Validator({'$ref': URI + '#/components/schemas/' + name},
                                    registry=REGISTRY).iter_errors(value))


class AssistantExtensionTests(unittest.TestCase):
    def test_openapi_parity_and_implemented_subset(self):
        validate(SPEC)
        self.assertEqual(SPEC, yaml.safe_load((ROOT / 'contracts/assistant-extension.yaml').read_text()))
        operations = [op for item in SPEC['paths'].values() for method, op in item.items()
                      if method in {'get', 'post', 'delete'}]
        self.assertEqual(14, len(operations))
        self.assertEqual(9, sum(op['x-implementation-status'] == 'IMPLEMENTED' for op in operations))
        self.assertEqual(5, sum(op['x-implementation-status'] == 'RESERVED' for op in operations))
        self.assertTrue(all(op['x-required-capability'] == 'tv.access' for op in operations))

    def test_global_has_no_canvas_dependency(self):
        self.assertFalse(errors('ConversationCreate', {'kind': 'GLOBAL', 'title': '首页剧本'}))
        self.assertFalse(errors('ConversationCreate', {'kind': 'GLOBAL', 'title': '', 'projectId': None}))
        self.assertTrue(errors('ConversationCreate', {'kind': 'GLOBAL', 'title': '', 'projectId': 'p1'}))
        self.assertTrue(errors('ConversationCreate', {'kind': 'CANVAS', 'title': ''}))
        self.assertFalse(errors('ConversationCreate', {'kind': 'CANVAS', 'title': '', 'projectId': 'p1'}))

    def test_browser_cannot_supply_ownership_or_native_state(self):
        for field in ['ownerId', 'userId', 'workspaceId', 'routerSessionRef', 'nativeThreadId']:
            self.assertTrue(errors('ConversationCreate', {'kind': 'GLOBAL', 'title': '', field: 'forged'}))

    def test_user_text_write_request_boundaries(self):
        part = {'type': 'TEXT', 'text': ' 保存 <fox> & 狐 '}
        self.assertFalse(errors('MessageCreate', {'content': [part]}))
        self.assertFalse(errors('MessageCreate', {'content': [part] * 100}))
        self.assertFalse(errors('MessageCreate', {'content': [{'type': 'TEXT', 'text': ' \n '}, part]}))
        for content in [None, [], [None], [part] * 101,
                        [{'type': 'TEXT', 'text': ''}],
                        [{'type': 'TEXT', 'text': ' \n\t　'}],
                        [{'type': 'TEXT', 'text': 'a\x00b'}],
                        [{'type': 'TEXT', 'text': '狐' * 200001}],
                        [{'type': 'TEXT', 'text': 'x', 'role': 'ASSISTANT'}],
                        [{'type': 'STRUCTURED', 'schemaCode': 's', 'value': {}}]]:
            self.assertTrue(errors('MessageCreate', {'content': content}))
        for field in ['role', 'ownerId', 'userId', 'workspaceId', 'id', 'seq', 'createdAt',
                      'conversationId', 'conversationRevision', 'nativeThreadId', 'routerSessionRef', 'usage']:
            self.assertTrue(errors('MessageCreate', {'content': [part], field: 'forged'}))

    def test_authorized_asset_and_selected_skill_shapes(self):
        self.assertFalse(errors('MessageCreate', {'content': [{'type': 'ASSET', 'assetId': 'a'}]}))
        skill = {'type': 'STRUCTURED', 'schemaCode': 'ASSISTANT_SKILL_V1', 'value': {
            'skillId': 'skill-a', 'revision': 2, 'version': 'v2', 'markdown': '# Selected',
            'files': [{'path': 'examples/readme.md', 'content': 'actual persisted content'}]}}
        self.assertFalse(errors('MessageCreate', {'content': [skill]}))
        self.assertTrue(errors('MessageCreate', {'content': [{'type': 'ASSET', 'assetId': ''}]}))
        self.assertTrue(errors('MessageCreate', {'content': [dict(skill, ownerId='forged')]}))
        self.assertTrue(errors('MessageCreate', {'content': [dict(skill, schemaCode='arbitrary')]}))

    def test_lifecycle_actual_ids_preconditions_and_none_evidence(self):
        deletion = {'conversationId': 'c', 'deletedMessageIds': ['u', 'a'],
                    'conversationRevision': 3, 'deletedAt': '2026-10-05T00:00:00.000Z'}
        self.assertFalse(errors('MessageDeletion', deletion))
        self.assertTrue(errors('MessageDeletion', dict(deletion, deletedMessageIds=[])))
        self.assertTrue(errors('MessageDeletion', dict(deletion, deletedMessageIds=['u', 'u'])))
        for suffix in ['turns/{turnId}', 'messages/{messageId}']:
            op = SPEC['paths']['/api/v2/conversations/{id}/' + suffix]['delete']
            self.assertEqual('IMPLEMENTED', op['x-implementation-status'])
            self.assertNotIn('requestBody', op)
            self.assertTrue({'If-Match', 'Idempotency-Key'} <= {p['name'] for p in op['parameters'] if p['required']})
            self.assertTrue({'200', '404', '409', '412', '413', '428', '503'} <= set(op['responses']))
            self.assertIn('ETag', op['responses']['200']['headers'])
        none = {'session_id': 'c', 'status': 'none', 'call': None, 'resume_command': None,
                'active_resume': None, 'host_events': [], 'terminal_recovered': False}
        self.assertFalse(errors('ClientToolPending', none))
        for field, value in [('call', {'fake': True}), ('host_events', [{}]),
                             ('terminal_recovered', True), ('status', 'pending')]:
            self.assertTrue(errors('ClientToolPending', dict(none, **{field: value})))
        self.assertIn('501', SPEC['paths']['/api/v2/conversations/{id}/client-tools/pending']['get']['responses'])

    def test_receipt_and_historical_message_contracts(self):
        message = {'id': 'msg_a', 'conversationId': 'cnv_a', 'seq': 1, 'role': 'USER',
                   'createdAt': '2026-10-05T00:00:00.000Z',
                   'content': [{'type': 'TEXT', 'text': 'saved'}]}
        self.assertFalse(errors('Message', message))
        receipt = dict(message, conversationRevision=2)
        self.assertFalse(errors('MessageReceipt', receipt))
        self.assertTrue(errors('MessageReceipt', dict(receipt, role='ASSISTANT')))
        self.assertTrue(errors('MessageReceipt', dict(receipt, conversationRevision=1)))
        self.assertTrue(errors('MessageReceipt', dict(receipt, ownerId='forged')))
        # Readable legacy shapes stay broad; no unimplemented write is enabled.
        self.assertFalse(errors('Message', dict(message, content=[])))
        self.assertFalse(errors('Message', dict(message, content=[{'type': 'ASSET', 'assetId': 'a'}])))

    def test_append_preconditions_receipt_etag_and_reserved_runs(self):
        paths = SPEC['paths']
        op = paths['/api/v2/conversations/{id}/messages']['post']
        self.assertEqual('IMPLEMENTED', op['x-implementation-status'])
        self.assertEqual({'id', 'If-Match', 'Idempotency-Key'},
                         {p['name'] for p in op['parameters'] if p['required']})
        self.assertEqual('#/components/schemas/MessageCreate',
                         op['requestBody']['content']['application/json']['schema']['$ref'])
        self.assertTrue({'201', '400', '401', '403', '404', '409', '412', '413', '415', '428', '501', '503'} <= set(op['responses']))
        self.assertIn('ETag', op['responses']['201']['headers'])
        self.assertIn('ETag', paths['/api/v2/conversations/{id}']['get']['responses']['200']['headers'])
        for path, methods in paths.items():
            if '/runs' in path or '/assistant-runs/' in path:
                for run in methods.values():
                    self.assertEqual('RESERVED', run['x-implementation-status'])
                    self.assertIn('501', run['responses'])


if __name__ == '__main__':
    unittest.main()
