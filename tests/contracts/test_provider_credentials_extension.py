import copy
import json
from pathlib import Path
import unittest

import yaml
from jsonschema import Draft202012Validator
from openapi_spec_validator import validate
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[2]
SPEC = json.loads((ROOT / 'contracts/provider-credentials-extension.json').read_text())
URI = 'https://studio.example.invalid/provider-credentials-extension.json'
REGISTRY = Registry().with_resource(URI, Resource(SPEC, DRAFT202012))


class PersonalProviderCredentialContract(unittest.TestCase):
    def test_implemented_independent_contract_has_verified_auth_and_no_store(self):
        validate(SPEC)
        self.assertEqual(SPEC, yaml.safe_load((ROOT / 'contracts/provider-credentials-extension.yaml').read_text()))
        self.assertEqual(SPEC['security'], [{'SessionBearer': []}])
        self.assertEqual(set(SPEC['paths']), {
            '/me/model-provider-credentials', '/me/model-provider-credentials/{providerRef}'})
        for path in SPEC['paths'].values():
            for method in ('get', 'put', 'delete'):
                if method not in path:
                    continue
                op = path[method]
                self.assertEqual(op['x-implementation-status'], 'IMPLEMENTED')
                self.assertEqual(op['x-required-capability'], 'tv.access')
                self.assertEqual(op['responses']['200']['headers']['Cache-Control']['schema'], {'const': 'no-store'})

    def test_only_write_operation_accepts_key_and_rejects_browser_scope(self):
        request = SPEC['paths']['/me/model-provider-credentials/{providerRef}']['put']['requestBody']['content']['application/json']['schema']
        self.assertTrue(request['properties']['apiKey']['writeOnly'])
        validator = Draft202012Validator(request)
        self.assertFalse(list(validator.iter_errors({'apiKey': 'TEST_ONLY_fixture', 'region': 'cn'})))
        for field in ('subjectRef', 'credentialRef', 'userId', 'providerURL', 'workspaceId'):
            self.assertTrue(list(validator.iter_errors({'apiKey': 'TEST_ONLY_fixture', field: 'forged'})))
        self.assertTrue(list(validator.iter_errors({'apiKey': 'TEST_ONLY_fixture', 'region': 'arbitrary'})))
        self.assertNotIn('requestBody', SPEC['paths']['/me/model-provider-credentials']['get'])
        self.assertNotIn('requestBody', SPEC['paths']['/me/model-provider-credentials/{providerRef}']['delete'])

    def test_status_contract_cannot_echo_key_or_private_binding(self):
        validator = Draft202012Validator({'$ref': URI + '#/components/schemas/ProviderCredential'}, registry=REGISTRY)
        item = {'providerRef': 'minimax-official', 'title': 'MiniMax', 'configured': False,
                'maskedKey': '', 'region': 'global', 'updatedAt': None, 'configurable': True}
        self.assertFalse(list(validator.iter_errors(item)))
        for field in ('apiKey', 'credentialRef', 'subjectRef', 'encryptedKey'):
            unsafe = copy.deepcopy(item)
            unsafe[field] = 'TEST_ONLY_private'
            self.assertTrue(list(validator.iter_errors(unsafe)))


if __name__ == '__main__':
    unittest.main()
