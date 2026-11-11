import json
from pathlib import Path
import unittest

import yaml
from jsonschema import Draft202012Validator
from openapi_spec_validator import validate
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[2]
SPEC = json.loads((ROOT / 'contracts/model-product-extension.json').read_text())
URI = 'https://studio.example.invalid/model-product-extension.json'
REGISTRY = Registry().with_resource(URI, Resource(SPEC, DRAFT202012))


def errors(name, value):
    return list(Draft202012Validator({'$ref': URI + '#/components/schemas/' + name},
                                    registry=REGISTRY).iter_errors(value))


class ProductModelDiscoveryTests(unittest.TestCase):
    def test_implemented_discovery_and_parity(self):
        validate(SPEC)
        self.assertEqual(SPEC, yaml.safe_load((ROOT / 'contracts/model-product-extension.yaml').read_text()))
        self.assertEqual(set(SPEC['paths']), {'/model-requirements', '/model-capabilities'})
        for path in SPEC['paths'].values():
            op = path['get']
            self.assertEqual(op['x-implementation-status'], 'IMPLEMENTED')
            self.assertEqual(op['x-required-capability'], 'tv.access')
            self.assertIn('501', op['responses'])
        router = json.loads((ROOT / 'contracts/models-router.json').read_text())
        self.assertEqual(SPEC['components']['schemas']['Capability'], router['components']['schemas']['Capability'])
        self.assertEqual(SPEC['components']['schemas']['ModelDescriptor'], router['components']['schemas']['ModelDescriptor'])

    def test_model_metadata_is_provider_neutral_and_excludes_native_configuration(self):
        model = {'providerRef': 'qwen', 'modelRef': 'qwen-vision', 'title': 'Qwen vision', 'version': '1'}
        self.assertFalse(errors('ModelDescriptor', model))
        for field in ('nativeModel', 'nativeEndpoint', 'apiKey', 'price'):
            self.assertTrue(errors('ModelDescriptor', dict(model, **{field: 'untrusted'})))
        for field in model:
            bad = dict(model)
            del bad[field]
            self.assertTrue(errors('ModelDescriptor', bad))

    def test_requirements_cannot_claim_model_availability(self):
        requirement = {'id': 'image', 'title': '文生图', 'kind': 'TEXT_TO_IMAGE', 'priority': 'P0',
                       'inputKinds': ['TEXT'], 'outputKinds': ['IMAGE'], 'features': ['角色设计']}
        self.assertFalse(errors('Requirement', requirement))
        self.assertTrue(errors('Requirement', dict(requirement, available=True)))
        self.assertTrue(errors('Requirement', dict(requirement, provider='vendor')))
        self.assertTrue(errors('Requirement', dict(requirement, price='0')))

    def test_actual_empty_catalog_and_no_business_payment_fields(self):
        envelope = {'code': 0, 'message': 'OK', 'requestId': 'test',
                    'data': {'items': [], 'nextCursor': None, 'schemaVersion': '1'}}
        self.assertFalse(errors('CapabilityResponse', envelope))
        for field in ('wallet', 'price', 'skuId', 'balance', 'nativeEndpoint'):
            bad = dict(envelope, data=dict(envelope['data'], **{field: 'untrusted'}))
            self.assertTrue(errors('CapabilityResponse', bad))


if __name__ == '__main__':
    unittest.main()
