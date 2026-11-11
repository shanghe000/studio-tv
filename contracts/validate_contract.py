#!/usr/bin/env python3
"""Validate the local API contract without making any service calls.

Install tooling in an isolated environment:
  python -m pip install openapi-spec-validator==0.7.2 PyYAML
Run:
  python validate_contract.py
"""
import json
from collections import Counter
from decimal import Decimal
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from openapi_spec_validator import validate
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parent
spec = json.loads((ROOT / 'openapi.json').read_text())
validate(spec)
assert yaml.safe_load((ROOT / 'openapi.yaml').read_text()) == spec, 'JSON/YAML differ'
registry = Registry().with_resource('urn:rhtv:contract', Resource(spec, DRAFT202012))


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


for node in walk(spec):
    if '$ref' in node:
        reference = node['$ref']
        assert reference.startswith('#/'), 'Unexpected external contract reference'
        target = spec
        for part in reference[2:].split('/'):
            target = target[part.replace('~1', '/').replace('~0', '~')]

operations = {v['operationId']: (p, m, v) for p, methods in spec['paths'].items() for m, v in methods.items()}
assert len(operations) == sum(len(x) for x in spec['paths'].values()), 'Duplicate operationId'
examples = json.loads((ROOT / 'examples.json').read_text())['examples']
assert len({e['name'] for e in examples}) == len(examples), 'Duplicate example name'
model_schema = next(e['value']['parameterSchema'] for e in examples if e['name'] == 'model-capability')
Draft202012Validator.check_schema(model_schema)


def validate_value(schema_name, value):
    schema = model_schema if schema_name == 'Model.parameterSchema' else {'$ref': 'urn:rhtv:contract#/components/schemas/' + schema_name}
    validator = Draft202012Validator(schema, registry=registry, format_checker=FormatChecker())
    return list(validator.iter_errors(value))


def check_billing(billing):
    fields = ['authorized', 'reserved', 'charged', 'released', 'refunded']
    assert len({billing[f]['currency'] for f in fields}) == 1, 'Billing currencies differ'
    amounts = {f: Decimal(billing[f]['amount']) for f in fields}
    assert amounts['authorized'] == amounts['reserved'] + amounts['charged'] + amounts['released'], 'Authorization equation'
    assert amounts['refunded'] <= amounts['charged'], 'Refund exceeds capture'
    expected = ('RESERVED' if amounts['reserved'] > 0 else
                'REFUNDED' if amounts['refunded'] > 0 else
                'SETTLED' if amounts['charged'] > 0 else
                'RELEASED' if amounts['authorized'] > 0 else 'NONE')
    assert billing['state'] == expected, 'Aggregate billing state'


for e in examples:
    errors = validate_value(e['schema'], e['value'])
    if e['valid']:
        assert not errors, e['name'] + ': ' + '; '.join(x.message for x in errors)
        for node in walk(e['value']):
            if {'authorized', 'reserved', 'charged', 'released', 'refunded', 'state'}.issubset(node):
                check_billing(node)
            if {'lineItems', 'maximumCost', 'purpose'}.issubset(node):
                assert all(i['maximumCost']['currency'] == node['maximumCost']['currency'] for i in node['lineItems'])
                assert sum(Decimal(i['maximumCost']['amount']) for i in node['lineItems']) == Decimal(node['maximumCost']['amount'])
            if node.get('state') == 'AWAITING_CONFIRMATION' and 'projectId' in node:
                quote = node['confirmationQuote']
                assert quote and node['plan'] and quote['generationId'] == node['id']
                assert quote['planRevision'] == node['plan']['revision']
    else:
        assert errors, e['name'] + ': invalid input was accepted'

# Inline OpenAPI examples and SSE payload must be real instances too.
inline_examples = 0
for _, _, operation in operations.values():
    content_groups = [operation.get('requestBody', {}).get('content', {})]
    content_groups += [r.get('content', {}) for r in operation['responses'].values()]
    for content in content_groups:
        for mime, media in content.items():
            if 'example' not in media:
                continue
            if mime == 'application/json':
                validator = Draft202012Validator(media['schema'], registry=registry, format_checker=FormatChecker())
                # Local fragments must resolve against the full OpenAPI document.
                schema_name = media['schema']['$ref'].split('/')[-1]
                assert not validate_value(schema_name, media['example'])
                inline_examples += 1
            elif mime == 'text/event-stream':
                data = next(line[6:] for line in media['example'].splitlines() if line.startswith('data: '))
                event = json.loads(data)
                assert not validate_value('GenerationEvent', event)
                assert event['generationId'] == event['snapshot']['id'] and event['revision'] == event['snapshot']['revision']
                inline_examples += 1

mapping = json.loads((ROOT / 'legacy-mapping.json').read_text())
inventory = json.loads((ROOT / 'legacy-inventory.json').read_text())
old_keys = {(x['method'].upper(), x['path']) for x in inventory['endpoints']}
new_keys = [(x['legacyMethod'].upper(), x['legacyPath']) for x in mapping['mappings']]
assert len(new_keys) == len(set(new_keys)) and set(new_keys) == old_keys, 'Incomplete or duplicate legacy mapping'
for node in walk(mapping):
    if 'operationId' in node:
        assert node['operationId'] in operations, 'Unknown mapped operationId'
for entry in mapping['mappings']:
    assert entry['implemented'] is False, 'Do not label a design as implemented'
    assert all(oid in operations for oid in entry.get('targetOperationIds', []))
assert not any(code in json.dumps(mapping) for code in ['FEATURE_NOT_IMPLEMENTED', 'AUTH_REQUIRED'])
# Check meaningful non-schema ledger failures separately (no backend involved).
for field, value in [('charged', '0.250000'), ('refunded', '1.000000')]:
    billing = next(e['value']['data']['billing'] for e in examples if e['name'] == 'generation-completed')
    bad = json.loads(json.dumps(billing))
    bad[field]['amount'] = value
    try:
        check_billing(bad)
    except AssertionError:
        pass
    else:
        raise AssertionError('Invalid ledger accepted: ' + field)
print(json.dumps({'openapi': 'PASS', 'jsonYamlParity': 'PASS', 'paths': len(spec['paths']), 'operations': len(operations), 'validExamples': sum(e['valid'] for e in examples), 'rejectedExamples': sum(not e['valid'] for e in examples), 'inlineExamples': inline_examples, 'legacyMappings': len(new_keys), 'billingInvariants': 'PASS', 'mappingStatuses': dict(Counter(e['status'] for e in mapping['mappings']))}, ensure_ascii=False, indent=2))
