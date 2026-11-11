"""Current implemented IPAC login configuration, separate from frozen core."""
from copy import deepcopy
from pathlib import Path
import hashlib
import json
import unittest

import yaml
from jsonschema import Draft202012Validator
from openapi_spec_validator import validate
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[2]
C = ROOT / 'contracts'
URI = 'https://contracts.rhtv.local/'
AUTH = json.loads((C / 'auth-extension.json').read_text())
CORE = json.loads((C / 'openapi.json').read_text())
REGISTRY = Registry().with_resources([
    (URI + 'auth-extension.json', Resource(AUTH, DRAFT202012)),
    (URI + 'openapi.json', Resource(CORE, DRAFT202012)),
])


def errors(value):
    return list(Draft202012Validator(
        {'$ref': URI + 'auth-extension.json#/components/schemas/LoginConfigurationResponse'},
        registry=REGISTRY,
    ).iter_errors(value))


class AuthenticationExtension(unittest.TestCase):
    def test_openapi_parity_and_frozen_core(self):
        validate(AUTH, base_uri=(C / 'auth-extension.json').as_uri())
        self.assertEqual(AUTH, yaml.safe_load((C / 'auth-extension.yaml').read_text()))
        self.assertFalse(set(AUTH['paths']) & set(CORE['paths']))
        authz = json.loads((C / 'authz-extension.json').read_text())
        for name, digest in authz['x-frozen-core-sha256'].items():
            self.assertEqual(hashlib.sha256((C / name).read_bytes()).hexdigest(), digest)

    def test_actual_configuration_response_examples(self):
        examples = AUTH['paths']['/auth/config']['get']['responses']['200']['content']['application/json']['examples']
        self.assertEqual(set(examples), {'ready', 'notConfigured', 'upstreamUnavailable'})
        expected = {
            'ready': (True, None),
            'notConfigured': (False, 'IPAC_NOT_CONFIGURED'),
            'upstreamUnavailable': (False, 'IPAC_SESSION_STATUS_UNAVAILABLE'),
        }
        for name, example in examples.items():
            with self.subTest(name=name):
                value = example['value']
                self.assertFalse(errors(value))
                self.assertEqual((value['data']['configured'], value['data']['unavailableReason']), expected[name])

    def test_removed_bypass_reason_and_private_fields_are_rejected(self):
        example = AUTH['paths']['/auth/config']['get']['responses']['200']['content']['application/json']['examples']['notConfigured']['value']
        for field, value in [('unavailableReason', 'IPAC_FEISHU_PROVENANCE_REQUIRED'),
                             ('unavailableReason', 'raw upstream secret or internal failure'),
                             ('loginUrl', 'https://external.invalid/login'),
                             ('clientSecret', 'not-public')]:
            with self.subTest(field=field, value=value):
                bad = deepcopy(example)
                bad['data'][field] = value
                self.assertTrue(errors(bad))
