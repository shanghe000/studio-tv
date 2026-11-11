"""Actual private ROLE/SCENE contract, independent of the reserved blueprint.

These checks validate transport shapes and the implementation inventory. Runtime
owner/READY checks, main-image membership, pagination arithmetic and concurrency
are covered by Go application/HTTP and explicitly configured PostgreSQL tests.
"""
from copy import deepcopy
import json
from pathlib import Path
import unittest

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from openapi_spec_validator import validate
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[2]
SPEC_PATH = ROOT / 'contracts/library-extension.json'
SPEC = json.loads(SPEC_PATH.read_text())
URI = 'https://studio.example.invalid/library-extension.json'
REGISTRY = Registry().with_resource(URI, Resource(SPEC, DRAFT202012))
METHODS = {'get', 'post', 'patch', 'put', 'delete'}
ITEMS = '/api/v2/library/items'
DETAIL = ITEMS + '/{id}'


def errors(name, value):
    return list(Draft202012Validator(
        {'$ref': URI + '#/components/schemas/' + name}, registry=REGISTRY,
        format_checker=FormatChecker()).iter_errors(value))


def schema_errors(schema, value):
    return list(Draft202012Validator(schema, registry=REGISTRY,
                                    format_checker=FormatChecker()).iter_errors(value))


def parameter(operation, name):
    return next(p for p in operation['parameters'] if p['name'] == name)


def input_value():
    return {'title': '本人角色', 'description': '真实上传的参考图', 'kind': 'ROLE',
            'assetIds': ['ast_owned_image'], 'mainAssetId': 'ast_owned_image'}


def item_value():
    return dict(input_value(), id='lib_owned_gallery', itemType='ROLE_GALLERY',
                revision=2, createdAt='2026-10-05T00:00:00.000Z',
                updatedAt='2026-10-05T00:01:00.000Z')


def envelope(data):
    return {'code': 0, 'message': 'OK', 'data': data, 'requestId': 'req_test'}


class LibraryExtensionTests(unittest.TestCase):
    def test_openapi_json_yaml_parity_and_honest_inventory(self):
        validate(SPEC, base_uri=SPEC_PATH.as_uri())
        self.assertEqual(SPEC, yaml.safe_load(
            (ROOT / 'contracts/library-extension.yaml').read_text()))
        operations = [(path, method, op)
                      for path, item in SPEC['paths'].items()
                      for method, op in item.items() if method in METHODS]
        self.assertEqual(21, len(operations))
        implemented = {(path, method) for path, method, op in operations
                       if op['x-implementation-status'] == 'IMPLEMENTED'}
        self.assertEqual(21, len(implemented))
        self.assertEqual(set(), {(path,method) for path,method,op in operations if op['x-implementation-status']=='RESERVED'})
        self.assertTrue({(ITEMS,'get'),(ITEMS,'post'),(DETAIL,'get'),(DETAIL,'patch'),(DETAIL,'delete'),
                         ('/api/v2/library/entries','get'),('/api/v2/library/move','post'),
                         ('/api/v2/library/batch-create','post'),('/api/v2/library/nodes/{id}','patch')} <= implemented)
        ids = [op['operationId'] for _, _, op in operations]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(404, SPEC['x-default-unknown-path-status'])
        for path, method, op in operations:
            with self.subTest(path=path, method=method):
                self.assertEqual('tv.access', op['x-required-capability'])
                self.assertEqual([{'LocalBearer': []}], op['security'])
                self.assertIn(op['x-implementation-status'], {'IMPLEMENTED', 'RESERVED'})
                self.assertFalse({'ownerId', 'userId', 'teamId', 'workspaceId',
                                  'X-Owner-Id', 'X-Workspace-Id'} &
                                 {p['name'] for p in op['parameters']})
                if op['x-implementation-status'] == 'RESERVED':
                    self.assertIn('501', op['responses'])
                    self.assertFalse({'200', '201', '202', '204'} & set(op['responses']))
        self.assertTrue({'library.collections','library.items','library.item_media_refs','public.idempotency_keys'} <= set(SPEC['x-persistence']))

    def test_self_contained_schema_references(self):
        def walk(value):
            if isinstance(value, dict):
                if '$ref' in value:
                    ref = value['$ref']
                    self.assertTrue(ref.startswith('#/'))
                    target = SPEC
                    for part in ref[2:].split('/'):
                        target = target[part.replace('~1', '/').replace('~0', '~')]
                for child in value.values():
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)
        walk(SPEC)
        for schema in SPEC['components']['schemas'].values():
            Draft202012Validator.check_schema(schema)

    def test_private_input_boundaries_and_ownership_injection(self):
        valid = input_value()
        self.assertFalse(errors('LibraryItemInput', valid))
        self.assertFalse(errors('LibraryItemInput', dict(valid, kind='SCENE')))
        empty = dict(valid, assetIds=[], mainAssetId=None)
        self.assertFalse(errors('LibraryItemInput', empty))
        del empty['mainAssetId']
        self.assertFalse(errors('LibraryItemInput', empty))
        for field in ['ownerId', 'userId', 'workspaceId', 'teamId', 'id', 'revision',
                      'itemType', 'createdAt', 'deletedAt', 'folderId', 'categoryCode',
                      'nodeContent', 'content', 'routerSessionRef']:
            with self.subTest(field=field):
                self.assertTrue(errors('LibraryItemInput', dict(valid, **{field: 'forged'})))
        for field in ['title', 'description', 'kind', 'assetIds']:
            value = deepcopy(valid)
            del value[field]
            self.assertTrue(errors('LibraryItemInput', value))
        invalid = [dict(valid, title=''), dict(valid, title=' \n\t　'),
                   dict(valid, title='狐' * 121), dict(valid, title='a\x00b'),
                   dict(valid, description=None), dict(valid, description='x' * 2001),
                   dict(valid, description='a\x00b'), dict(valid, kind='PUBLIC'),
                   dict(valid, kind='IMAGE'), dict(valid, kind='NODE'),
                   dict(valid, assetIds=None), dict(valid, assetIds=['a', 'a']),
                   dict(valid, assetIds=['']), dict(valid, assetIds=['a\x00b']),
                   dict(valid, assetIds=['x' * 201]),
                   dict(valid, assetIds=[str(i) for i in range(101)]),
                   dict(valid, mainAssetId=42)]
        for value in invalid:
            with self.subTest(value=value):
                self.assertTrue(errors('LibraryItemInput', value))

    def test_asset_references_are_ids_and_not_supplier_descriptors(self):
        valid = input_value()
        self.assertEqual({'title', 'description', 'kind', 'assetIds', 'mainAssetId'},
                         set(SPEC['components']['schemas']['LibraryItemInput']['properties']))
        self.assertTrue(errors('LibraryItemInput', dict(valid, assetIds=[
            {'assetId': 'ast_owned_image', 'url': 'https://vendor.invalid/image.png'}])))
        self.assertTrue(errors('LibraryItemInput', dict(valid, assetIds='ast_owned_image')))
        for field in ['url', 'imageUrl', 'previewUrl', 'downloadUrl', 'vendorUrl',
                      'storageKey', 'provider', 'checksumSha256']:
            with self.subTest(field=field):
                self.assertTrue(errors('LibraryItemInput', dict(valid, **{
                    field: 'https://vendor.invalid/image.png'})))
                self.assertTrue(errors('LibraryItem', dict(item_value(), **{
                    field: 'https://vendor.invalid/image.png'})))
        # ID existence and owner/READY authorization are runtime repository work;
        # the schema deliberately does not invent an ast_ prefix for legacy IDs.
        asset_schema = SPEC['components']['schemas']['LibraryItem']['properties']['assetIds']['items']
        self.assertEqual('string', asset_schema['type'])
        self.assertNotEqual('uri', asset_schema.get('format'))

    def test_item_response_kind_mapping_and_private_fields(self):
        value = item_value()
        self.assertFalse(errors('LibraryItemResponse', envelope(value)))
        scene = dict(value, kind='SCENE', itemType='SCENE_GALLERY')
        self.assertFalse(errors('LibraryItem', scene))
        for bad in [dict(value, itemType='SCENE_GALLERY'), dict(scene, itemType='ROLE_GALLERY'),
                    dict(value, revision=0), dict(value, revision='2'),
                    dict(value, ownerId='forged'), dict(value, updatedAt='not-a-date'),
                    dict(value, assetIds=None), dict(value, id='a\x00b')]:
            self.assertTrue(errors('LibraryItem', bad))
        for field in ['mainAssetId', 'revision', 'createdAt', 'updatedAt']:
            bad = deepcopy(value)
            del bad[field]
            self.assertTrue(errors('LibraryItem', bad))
        self.assertTrue(errors('LibraryItemResponse', dict(envelope(value), code=1)))
        self.assertTrue(errors('LibraryItemResponse', dict(envelope(value), requestId='')))

    def test_real_page_projection_including_empty_and_out_of_range(self):
        page = {'records': [item_value()], 'page': 1, 'size': 1,
                'total': 3, 'pages': 3, 'hasNext': True}
        self.assertFalse(errors('LibraryItemPageResponse', envelope(page)))
        self.assertFalse(errors('LibraryItemPage', dict(page, records=[], page=100000,
                                                       hasNext=False)))
        self.assertFalse(errors('LibraryItemPage', dict(page, records=[], total=0,
                                                       pages=0, hasNext=False)))
        for field in ['records', 'page', 'size', 'total', 'pages', 'hasNext']:
            bad = deepcopy(page)
            del bad[field]
            self.assertTrue(errors('LibraryItemPage', bad))
        for bad in [dict(page, records=None), dict(page, records=[item_value()] * 101),
                    dict(page, page=0), dict(page, page=100001), dict(page, size=101),
                    dict(page, total=-1), dict(page, pages=-1), dict(page, total='3'),
                    dict(page, hasNext='true'), dict(page, ownerId='forged')]:
            self.assertTrue(errors('LibraryItemPage', bad))
        query = SPEC['paths'][ITEMS]['get']['parameters']
        self.assertEqual({'page', 'size', 'keyword', 'kind'}, {p['name'] for p in query})
        for name, good, bad in [('page', 100000, 100001), ('size', 100, 101),
                                ('keyword', '狐' * 300, '狐' * 301), ('kind', 'ROLE', 'PUBLIC')]:
            schema = parameter(SPEC['paths'][ITEMS]['get'], name)['schema']
            self.assertFalse(schema_errors(schema, good))
            self.assertTrue(schema_errors(schema, bad))
        self.assertTrue(schema_errors(parameter(SPEC['paths'][ITEMS]['get'], 'keyword')['schema'],
                                      'a\x00b'))

    def test_uuid_creation_and_strong_etag_preconditions(self):
        paths = SPEC['paths']
        create = paths[ITEMS]['post']
        uuid_parameter = parameter(create, 'Idempotency-Key')
        self.assertTrue(uuid_parameter['required'])
        uuid_value = '73f8e9e0-4550-4914-a2ad-08c06ca96439'
        for good in [uuid_value, uuid_value.upper()]:
            self.assertFalse(schema_errors(uuid_parameter['schema'], good))
        for bad in ['', 'not-a-uuid', uuid_value.replace('-', ''), 'urn:uuid:' + uuid_value]:
            self.assertTrue(schema_errors(uuid_parameter['schema'], bad))
        self.assertTrue({'201', '400', '401', '403', '404', '409', '413', '415', '503'} <=
                        set(create['responses']))
        self.assertIn('ETag', create['responses']['201']['headers'])
        self.assertIn('ETag', paths[DETAIL]['get']['responses']['200']['headers'])
        for method in ['patch', 'delete']:
            operation = paths[DETAIL][method]
            match = parameter(operation, 'If-Match')
            self.assertTrue(match['required'])
            for good in ['"1"', '"9223372036854775807"']:
                self.assertFalse(schema_errors(match['schema'], good))
            for bad in ['W/"1"', '*', '"0"', '"01"', '"-1"', '"1", "2"']:
                self.assertTrue(schema_errors(match['schema'], bad))
            self.assertTrue({'200', '400', '401', '403', '404', '412', '428', '503'} <=
                            set(operation['responses']))
            self.assertIn('ETag', operation['responses']['200']['headers'])
            self.assertNotIn('Idempotency-Key', {p['name'] for p in operation['parameters']})
        self.assertTrue({'413', '415'} <= set(paths[DETAIL]['patch']['responses']))
        for operation in [create, paths[DETAIL]['patch']]:
            self.assertEqual('#/components/schemas/LibraryItemInput',
                             operation['requestBody']['content']['application/json']['schema']['$ref'])


if __name__ == '__main__':
    unittest.main()
