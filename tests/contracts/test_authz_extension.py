"""Tool access stays server-authorized; experimental workspace interfaces are retired."""
from pathlib import Path
import hashlib
import json
import unittest

import yaml
from openapi_spec_validator import validate

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / 'contracts'


class AuthorizationExtension(unittest.TestCase):
    def test_extension_is_valid_and_preserves_frozen_core(self):
        path = CONTRACTS / 'authz-extension.json'
        document = json.loads(path.read_text())
        self.assertEqual(document, yaml.safe_load((CONTRACTS / 'authz-extension.yaml').read_text()))
        validate(document, base_uri=path.as_uri())
        core = json.loads((CONTRACTS / 'openapi.json').read_text())
        self.assertFalse(set(document['paths']) & set(core['paths']))
        for name, digest in document['x-frozen-core-sha256'].items():
            self.assertEqual(hashlib.sha256((CONTRACTS / name).read_bytes()).hexdigest(), digest)
        self.assertEqual(document['paths'], {})
        self.assertNotIn('WorkspaceHeader', document['components'].get('parameters', {}))
        self.assertFalse({'Workspace', 'WorkspaceList'} & set(document['components'].get('schemas', {})))

    def test_capability_manifest_matches_route_guards(self):
        document = json.loads((CONTRACTS / 'authz-extension.json').read_text())
        manifest = json.loads((CONTRACTS / 'ipac-capabilities.template.json').read_text())
        codes = [capability['code'] for capability in manifest['capabilities']]
        self.assertEqual(codes, ['tv.access'])
        self.assertEqual(set(codes), set(document['x-core-route-authorization']))
        self.assertEqual(len(codes), len(set(codes)))
        self.assertEqual(manifest['application_code'], '${IPAC_APP_ID}')
        self.assertIn('GET /storage/assets/{assetId}', document['x-core-route-authorization']['tv.access'])
        self.assertIn('HEAD /storage/assets/{assetId}', document['x-core-route-authorization']['tv.access'])
        self.assertIn('PUT /storage/uploads/{uploadId}', document['x-core-route-authorization']['tv.access'])
        self.assertFalse(any('generation' in code for code in codes))

    def test_tool_access_is_live_server_resolved_and_owner_isolated(self):
        document = json.loads((CONTRACTS / 'authz-extension.json').read_text())
        policy = document['x-server-authorization-policy']
        self.assertEqual(policy['capability'], 'tv.access')
        self.assertEqual(policy['authenticationProvider'], 'feishu')
        self.assertEqual(policy['subjectSource'], 'VERIFIED_IPAC_SESSION')
        self.assertEqual(policy['scopeSource'], 'VERIFIED_IPAC_EFFECTIVE_SCOPES')
        self.assertEqual(policy['effectiveScopes'], 'BOUNDED_APPLICATION_LEASE')
        self.assertEqual(policy['runtimeCheck'], 'NOT_REQUIRED')
        self.assertEqual(policy['grantRule'], 'ANY_VERIFIED_TV_ACCESS_SCOPE')
        self.assertIn('at most 300 seconds', policy['description'])
        self.assertIn('bounded by session expiry', policy['description'])
        self.assertIn('never serve stale allowances', policy['description'])
        self.assertFalse(policy['clientSelectsScope'])
        self.assertFalse(policy['localRoleFallback'])
        self.assertFalse(policy['scopePartitionsResources'])
        self.assertTrue(policy['ownerIsolation'])
        self.assertEqual(policy['failureHttpStatus'], {'UNAUTHENTICATED': 401, 'FORBIDDEN': 403, 'AUTHORIZATION_UNAVAILABLE': 503})

    def test_retired_workspace_interfaces_cannot_select_scope_or_change_data(self):
        document = json.loads((CONTRACTS / 'authz-extension.json').read_text())
        retired = document['x-retired-experimental-interfaces']
        route = next(item for item in retired['routes'] if item['path'] == '/workspaces')
        self.assertEqual(route['method'], 'GET')
        self.assertEqual(route['status'], 'RETIRED')
        self.assertEqual(route['httpStatus'], 404)
        self.assertNotIn(route['path'], document['paths'])
        header = next(item for item in retired['parameters'] if item['name'] == 'X-Workspace-Id')
        self.assertEqual(header['status'], 'RETIRED')
        self.assertEqual(header['behavior'], 'IGNORED')
        self.assertFalse(header['affectsAuthorization'])
        self.assertFalse(header['affectsDataPartition'])
        self.assertFalse(header['affectsIdempotency'])
        storage = document['x-legacy-storage']
        self.assertEqual(storage['workspaceColumnsAndMappings'], 'PRESERVED')
        self.assertFalse(storage['participatesInAuthorization'])
        self.assertFalse(storage['partitionsBusinessData'])


if __name__ == '__main__':
    unittest.main()
