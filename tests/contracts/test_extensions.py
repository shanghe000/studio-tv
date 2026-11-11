"""Offline contract checks, not RESERVED backend or provider implementation tests."""
from copy import deepcopy
from pathlib import Path
import hashlib
import json
import unittest

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from openapi_spec_validator import validate
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[2]
C = ROOT / 'contracts'
URI = 'https://contracts.rhtv.local/'
DOCS = {name: json.loads((C/name).read_text()) for name in ['openapi.json', 'canvas-extension.json', 'model-capabilities.json']}
REGISTRY = Registry().with_resources([(URI+n, Resource(d, DRAFT202012)) for n,d in DOCS.items()])


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def schema_errors(example):
    if example['domain'] == 'model':
        reference = URI+'model-capabilities.json'+('' if example['schema']=='root' else '#/$defs/'+example['schema'])
    else:
        reference = URI+'canvas-extension.json#/components/schemas/'+example['schema']
    return list(Draft202012Validator({'$ref':reference}, registry=REGISTRY, format_checker=FormatChecker()).iter_errors(example['value']))


def semantic_errors(kind, value, context):
    """Normative cross-field examples; real service must enforce these independently."""
    errors=[]
    if kind == 'appInput':
        allowed={'type','enum','minimum','maximum','minLength','maxLength','pattern','format','default'}
        constraints=value['constraints']
        if set(constraints)-allowed: errors.append('unsupported constraint')
        else:
            Draft202012Validator.check_schema(constraints)
            if value['defaultValue'] is not None and list(Draft202012Validator(constraints).iter_errors(value['defaultValue'])):errors.append('default violates constraints')
    if kind == 'modelManifest':
        paths=[f['path'] for f in value['files']]
        if value['entrypoint'] not in paths:errors.append('entrypoint absent from manifest')
        if len(paths)!=len(set(paths)):errors.append('duplicate path')
        if sum(f['byteSize'] for f in value['files'])>536870912:errors.append('total size exceeds bound')
    if kind == 'appInvocation':
        app=context['app'];inputs={i['id']:i for i in app['inputs']};bindings=value['bindings'];values=value['values']
        if value['appId'] != app['id'] or value['appVersion'] != app['version']:errors.append('catalog version mismatch')
        ids=[b['inputId'] for b in bindings]+[v['inputId'] for v in values]
        if len(ids)!=len(set(ids)):errors.append('duplicate/conflicting input')
        if any(i not in inputs for i in ids):errors.append('unknown input')
        if any(i['required'] and i['id'] not in ids for i in inputs.values()):errors.append('missing required input')
        for b in bindings:
            if b['appNodeId'] != value['appNodeId']:errors.append('binding belongs to other app node')
            source=context['nodes'].get(b['sourceNodeId']);target=inputs.get(b['inputId'])
            if not source or not target:errors.append('dangling binding');continue
            permitted={'STRING':{'STRING','TEXT'}}.get(target['type'],{target['type']})
            if source['kind'] not in permitted:errors.append('binding type mismatch')
            if target['type'] in ['IMAGE','VIDEO','AUDIO']:
                asset=context['assets'].get(source.get('assetId'))
                if not asset or asset['state'] != 'READY' or not asset['authorized'] or asset['kind'] != target['type']:errors.append('unusable/unauthorized asset')
        for submitted in values:
            target=inputs.get(submitted['inputId'])
            if not target:continue
            input_value=submitted['value']
            if input_value is None and not target['required']:continue
            value_type={'INT':'integer','FLOAT':'number','BOOLEAN':'boolean','SWITCH':'boolean'}.get(target['type'],'string')
            constraint={'type':value_type,**target.get('constraints',{})}
            if list(Draft202012Validator(constraint).iter_errors(input_value)):errors.append('value type/constraint mismatch')
            if target['type'] in ['IMAGE','VIDEO','AUDIO']:
                asset=context['assets'].get(input_value) if isinstance(input_value,str) else None
                if not asset or asset['state'] != 'READY' or not asset['authorized'] or asset['kind'] != target['type']:errors.append('unusable/unauthorized value asset')
    if kind == 'graph':
        ids=[n['id'] for n in value['nodes']]; edges=[e['id'] for e in value['edges']]
        if len(ids)!=len(set(ids)) or len(edges)!=len(set(edges)):errors.append('duplicate graph id')
        metadata=next((n for n in value['nodes'] if n['id']=='rhtv_meta_v1'),None)
        if not metadata:errors.append('metadata missing')
        for e in value['edges']:
            if e['source'] not in ids or e['target'] not in ids or 'rhtv_meta_v1' in [e['source'],e['target']]:errors.append('invalid executable endpoint')
        if metadata and set(metadata['data']['edges'])-set(edges):errors.append('unknown edge metadata')
        parents={n['id']:n['data'].get('__rhtv',{}).get('native',{}).get('parentId') for n in value['nodes']}
        for start,parent in parents.items():
            seen={start}
            while parent:
                if parent not in parents:errors.append('missing group');break
                if parent in seen:errors.append('group cycle');break
                seen.add(parent);parent=parents[parent]
        for obj_ in walk(value):
            if {'__proto__','prototype','constructor'} & set(obj_):errors.append('prototype key')
            if {'apiKey','apiUrl','secretKey','accessToken','Authorization','refreshToken'} & set(obj_):errors.append('credentials/execution endpoint')
            if 'assetId' in obj_ and obj_['assetId'] not in context['authorizedAssets']:errors.append('unauthorized asset reference')
            if 'modelAssetId' in obj_ and obj_['modelAssetId'] not in context.get('authorizedModelAssets',[]):errors.append('unauthorized model asset reference')
            for item in obj_.values():
                if isinstance(item,str) and item.startswith(('blob:','rhtv-asset:','http://127.0.0.1','/__rhtv_media/')):errors.append('nonpersistent media locator')
    return errors


def restore_fixture(graph):
    """Reference decoding of test fixture; production adapter is tested separately."""
    graph=deepcopy(graph);meta=next(n for n in graph['nodes'] if n['id']=='rhtv_meta_v1')['data']
    nodes=[]
    for node in graph['nodes']:
        if node['id']=='rhtv_meta_v1':continue
        extra=node['data'].pop('__rhtv',{}).get('native',{})
        nodes.append({**node,**extra})
    return {'nodes':nodes,'edges':[{**edge,**meta['edges'].get(edge['id'],{})} for edge in graph['edges']], 'meta':meta['meta'],'viewport':graph['viewport']}


class ExtensionContracts(unittest.TestCase):
    def test_openapi_and_equivalent_yaml(self):
        path=C/'canvas-extension.json'
        validate(DOCS[path.name], base_uri=path.as_uri())
        for name in ['canvas-extension','model-capabilities']:
            self.assertEqual(yaml.safe_load((C/(name+'.yaml')).read_text()),json.loads((C/(name+'.json')).read_text()))
        Draft202012Validator.check_schema(DOCS['model-capabilities.json'])

    def test_frozen_core_unchanged_and_no_override(self):
        ext=DOCS['canvas-extension.json']
        for name,digest in ext['x-frozen-core-sha256'].items():self.assertEqual(hashlib.sha256((C/name).read_bytes()).hexdigest(),digest)
        self.assertFalse(set(ext['paths']) & set(DOCS['openapi.json']['paths']))
        self.assertEqual(DOCS['openapi.json']['info']['version'],'1.0.0')
        self.assertEqual(DOCS['openapi.json']['components']['schemas']['Asset']['properties']['kind']['enum'],['IMAGE','VIDEO','AUDIO'])

    def test_all_operations_reserved_with_errors_and_unique_ids(self):
        ops=[]
        for path,methods in DOCS['canvas-extension.json']['paths'].items():
            for method,operation in methods.items():
                ops.append(operation['operationId'])
                self.assertEqual(operation['x-implementation-stage'],'RESERVED')
                self.assertIn('501',operation['responses'])
                self.assertIn('default',operation['responses'])
                for n in walk(operation):
                    if '$ref' in n:self.assertTrue(n['$ref'].startswith(('#/','./openapi.json#/')))
                for name in __import__('re').findall(r'\{([^}]+)\}',path):
                    self.assertTrue(any(p.get('name')==name and p.get('required') for p in operation['parameters']))
        self.assertEqual(len(ops),len(set(ops)))
        frozen={o['operationId'] for p in DOCS['openapi.json']['paths'].values() for o in p.values()}
        self.assertFalse(set(ops)&frozen)

    def test_examples_and_semantic_rejections(self):
        examples=json.loads((C/'canvas-extension-examples.json').read_text())['examples']
        self.assertEqual(len(examples),len({e['name'] for e in examples}))
        for example in examples:
            with self.subTest(example=example['name']):
                errors=schema_errors(example)
                if not errors and example.get('semantic'):errors=semantic_errors(example['semantic'],example['value'],example['context'])
                self.assertEqual(not errors,example['valid'],str(errors))

    def test_group_style_and_empty_graph_roundtrip(self):
        fixtures=json.loads((C/'canvas-extension-examples.json').read_text())['roundtrips']
        for case in fixtures:
            with self.subTest(case=case['name']):
                self.assertEqual(restore_fixture(case['projectGraph']),case['sourceGraph'])
                self.assertEqual(len([n for n in case['projectGraph']['nodes'] if n['type']=='__rhtv_meta']),1)
                # Metadata is never in the restored executable graph.
                self.assertNotIn('rhtv_meta_v1',[n['id'] for n in restore_fixture(case['projectGraph'])['nodes']])
                frozen_schema={'$ref':URI+'openapi.json#/components/schemas/ProjectGraph'}
                self.assertFalse(list(Draft202012Validator(frozen_schema,registry=REGISTRY).iter_errors(case['projectGraph'])))


if __name__=='__main__':unittest.main(verbosity=2)
