import json
from pathlib import Path
import unittest
import yaml
from jsonschema import Draft202012Validator
from openapi_spec_validator import validate
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[2]
SPEC = json.loads((ROOT / 'contracts/capability-versions-extension.json').read_text())
URI = 'https://studio.example.invalid/capability-versions-extension.json'
REGISTRY = Registry().with_resource(URI, Resource(SPEC, DRAFT202012))

class CapabilityVersionTests(unittest.TestCase):
    def test_independent_contract_and_single_exact_query(self):
        validate(SPEC)
        self.assertEqual(SPEC, yaml.safe_load((ROOT / 'contracts/capability-versions-extension.yaml').read_text()))
        self.assertEqual(set(SPEC['paths']), {'/model-capability-version'})
        operation = SPEC['paths']['/model-capability-version']['get']
        self.assertEqual(operation['x-implementation-status'], 'IMPLEMENTED')
        self.assertEqual(operation['x-required-capability'], 'tv.access')
        self.assertEqual([p['name'] for p in operation['parameters']], ['ref', 'version'])
        self.assertTrue(all(p['required'] for p in operation['parameters']))
        self.assertNotIn('requestBody', operation)
        self.assertIn('404', operation['responses'])
        self.assertEqual(SPEC['x-router-transport']['path'], '/extensions/capability-versions/v1/capability')

    def test_metadata_shape_matches_existing_discovery_without_changing_version_one(self):
        base = json.loads((ROOT / 'contracts/model-product-extension.json').read_text())
        for name in ('Capability', 'ModelDescriptor'):
            self.assertEqual(SPEC['components']['schemas'][name], base['components']['schemas'][name])
        envelope = SPEC['components']['schemas']['CapabilityVersionResponse']
        self.assertEqual(envelope['properties']['data'], {'$ref': '#/components/schemas/Capability'})
        self.assertEqual(envelope['properties']['code'], {'const': 0})
        self.assertIn('immutable empty parameter schema', SPEC['x-version-policy']['reasoningSchema1'])

    def test_query_patterns_accept_ref_slash_and_reject_empty_or_invalid_versions(self):
        parameters = SPEC['paths']['/model-capability-version']['get']['parameters']
        ref = Draft202012Validator(parameters[0]['schema'])
        version = Draft202012Validator(parameters[1]['schema'])
        self.assertFalse(list(ref.iter_errors('public/model')))
        self.assertFalse(list(version.iter_errors('1')))
        for value in ('', ' ', 'x' * 101, '1?latest=true'):
            self.assertTrue(list(version.iter_errors(value)))

if __name__ == '__main__':
    unittest.main()
