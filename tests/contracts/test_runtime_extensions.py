"""Validate implemented execution, resources, media and organization contracts."""
import json
from pathlib import Path
import unittest
import yaml
from openapi_spec_validator import validate
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012
ROOT=Path(__file__).resolve().parents[2]
class RuntimeExtensions(unittest.TestCase):
 def test_contracts_are_self_contained_and_auth_is_explicit(self):
  for name in ['execution','resources','media','organization']:
   with self.subTest(name=name):
    path=ROOT/'contracts'/f'{name}-extension.json';spec=json.loads(path.read_text());validate(spec)
    self.assertEqual(spec,yaml.safe_load(path.with_suffix('.yaml').read_text()))
    ids=[]
    for path,item in spec['paths'].items():
     for method,op in item.items():
      if method not in {'get','post','put','patch','delete'}:continue
      ids.append(op['operationId']);self.assertIn(op['x-implementation-status'],['IMPLEMENTED','RESERVED'])
      if 'preview/{' not in path:
       self.assertEqual('tv.access',op['x-required-capability'])
       self.assertTrue(op['security'])
      self.assertFalse({'ownerId','userId','workspaceId','teamId'} & {p['name'] for p in op.get('parameters',[])})
    self.assertEqual(len(ids),len(set(ids)))
 def test_task_does_not_expose_owner_provider_or_secret_state(self):
  spec=json.loads((ROOT/'contracts/execution-extension.json').read_text());uri='https://studio.invalid/execution';reg=Registry().with_resource(uri,Resource(spec,DRAFT202012))
  validator=Draft202012Validator({'$ref':uri+'#/components/schemas/Task'},registry=reg)
  task={'id':'tsk_1','projectId':'prj_1','kind':'CANVAS','targetType':'NODE','targetId':'n1','name':'QA','state':'QUEUED','revision':1,'plans':[],'testMode':True,'createdAt':'2026-10-05T00:00:00Z','updatedAt':'2026-10-05T00:00:00Z'}
  self.assertFalse(list(validator.iter_errors(task)))
  for key,value in {'ownerId':'other','workspaceId':'w','routerInvocationRef':'private','serviceToken':'secret'}.items():
   self.assertTrue(list(validator.iter_errors(dict(task,**{key:value}))))
