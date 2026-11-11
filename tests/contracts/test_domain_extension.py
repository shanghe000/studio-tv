"""Validate the design contract; does not claim any domain route is implemented."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import unittest
import yaml
from jsonschema import Draft202012Validator, FormatChecker
from openapi_spec_validator import validate
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012
from build_domain_extension import DOC

ROOT = Path(__file__).resolve().parents[2]
C = ROOT / 'contracts'
URI = 'https://studio.example.invalid/'
SPEC = json.loads((C/'domain-extension.json').read_text())
CORE = json.loads((C/'openapi.json').read_text())
REGISTRY = Registry().with_resources([
    (URI+'domain-extension.json',Resource(SPEC,DRAFT202012)),
    (URI+'openapi.json',Resource(CORE,DRAFT202012)),
])

def errors(name,value):
    return list(Draft202012Validator({'$ref':URI+'domain-extension.json#/components/schemas/'+name},
        registry=REGISTRY,format_checker=FormatChecker()).iter_errors(value))

META={'id':'rhtv_meta_v1','type':'__rhtv_meta','position':{'x':0,'y':0},
      'data':{'version':'1','meta':{},'edges':{}}}
GRAPH={'schemaVersion':'1','nodes':[META,{'id':'n1','type':'rh-image','position':{'x':0,'y':0},
       'data':{'subType':'text-image','modelCode':'configured-model','params':{'prompt':'fox'}}}],
       'edges':[],'viewport':{'x':0,'y':0,'zoom':1}}

class DomainContractTests(unittest.TestCase):
    def test_contract_valid_and_generated_artifacts_equal(self):
        self.assertEqual(SPEC,DOC)
        self.assertEqual(SPEC,yaml.safe_load((C/'domain-extension.yaml').read_text()))
        validate(SPEC,base_uri=(C/'domain-extension.json').as_uri())

    def test_core_is_frozen_and_server_not_registered(self):
        frozen=json.loads((C/'canvas-extension.json').read_text())['x-frozen-core-sha256']
        for name,digest in frozen.items():
            self.assertEqual(digest,hashlib.sha256((C/name).read_bytes()).hexdigest())
        runtime=(ROOT/'apps/api-go/internal/core/server.go').read_text()
        self.assertNotIn('domain-extension',runtime)
        self.assertEqual(SPEC['servers'],[{'url':'/api/v2'}])

    def test_operations_have_real_tables_unique_ids_and_no_scope_parameters(self):
        sql=(ROOT/'docs/design/database.sql').read_text()
        tables=set(re.findall(r'CREATE TABLE (\w+\.\w+)',sql))
        tables.update('public.'+name for name in re.findall(r'CREATE TABLE(?: IF NOT EXISTS)? (\w+)\s*\(',
             (ROOT/'apps/api-go/migrations/001_core.sql').read_text(),re.I))
        ids=[]
        for path,item in SPEC['paths'].items():
            for method,op in item.items():
                with self.subTest(path=path,method=method):
                    self.assertEqual(op['x-design-status'],'PROPOSED')
                    self.assertEqual(op['x-implementation-stage'],'RESERVED')
                    self.assertIn(op['x-phase'],['P1','P2','P3'])
                    self.assertTrue(op['x-persistence'])
                    self.assertFalse(set(op['x-persistence'])-tables)
                    ids.append(op['operationId'])
                    self.assertFalse({'workspaceId','teamId','userId','X-Workspace-Id'} &
                                     {p.get('name') for p in op['parameters']})
                    self.assertIn('501',op['responses'])
        self.assertEqual(len(ids),len(set(ids)))

    def test_valid_execution_and_reference_shapes(self):
        examples=[('RunInput',{'projectId':'p1','baseRevision':8,'targetType':'NODE','targetId':'n1','graph':GRAPH}),
          ('RunInput',{'projectId':'p1','baseRevision':8,'targetType':'CANVAS','targetId':None,'graph':GRAPH}),
          ('ModelVersionRef',{'capabilityId':'cap1','version':'2026-10-v1'}),
          ('ResourceVersionRef',{'resourceId':'s1','version':'v2'}),
          ('ChatInput',{'content':[{'type':'TEXT','text':'hello'}],'skillVersions':[],
                        'modelVersion':{'capabilityId':'llm1','version':'v1'},'interactionMode':'ASK'}),
          ('FolderCreate',{'name':'参考','categoryCode':'USER_OTHER','kind':'MIXED'}),
          ('HfRenderInput',{'fps':30,'quality':'standard','format':'mp4'}),
          ('Output',{'id':'o1','kind':'MODEL_3D','modelAssetId':'m1'}),
          ('Output',{'id':'o2','kind':'WORLD_3D','url':'https://example.test/authorized-output'}),
          ('Output',{'id':'o3','kind':'STORYBOARD','schemaCode':'storyboard.v1','value':{'shots':[]}}),
          ('SkillFileWrite',{'path':'SKILL.md','uploadId':'u1','primary':True})]
        for name,value in examples:
            with self.subTest(name=name,value=value):self.assertEqual(errors(name,value),[])

    def test_invalid_or_ambiguous_inputs_rejected(self):
        invalid=[('RunInput',{'projectId':'p1','baseRevision':8,'targetType':'NODE','targetId':None,'graph':GRAPH}),
          ('RunInput',{'projectId':'p1','baseRevision':8,'targetType':'CANVAS','targetId':'n1','graph':GRAPH}),
          ('ModelVersionRef',{'versionId':'pretend-single-id'}),
          ('SkillFileWrite',{'path':'SKILL.md','blobId':'unproven-blob','primary':True}),
          ('ConversationCreate',{'kind':'CANVAS','title':'Chat'}),
          ('HfRenderInput',{'fps':'30','quality':'standard','format':'mp4'}),
          ('TagCreate',{'name':'shot','color':'green'}),
          ('FolderCreate',{'name':'x'*121,'categoryCode':'USER_OTHER'}),
          ('MaterializeInput',{'projectId':'p1','mediaIds':[]})]
        for name,value in invalid:
            with self.subTest(name=name): self.assertTrue(errors(name,value))

    def test_upload_purpose_shape_and_media_inputs_use_ids(self):
        file={'path':'ref.png','byteSize':1024,'mimeType':'image/png','sha256':'a'*64}
        self.assertFalse(errors('BlobUploadInput',{'purpose':'SKILL','file':file}))
        self.assertFalse(errors('BlobUploadInput',{'purpose':'HF','hfProjectId':'h1','file':file}))
        self.assertTrue(errors('BlobUploadInput',{'purpose':'HF','file':file}))
        self.assertTrue(errors('BlobUploadInput',{'purpose':'SKILL','hfProjectId':'h1','file':file}))
        spec={'version':1,'inputs':[{'id':'a','assetId':'v1'}],
              'tracks':[{'type':'video','clips':[{'input':'a','trim':{'startMs':0,'endMs':1000}}]}],
              'output':{'container':'mp4'}}
        self.assertFalse(errors('MediaSpec',spec))
        bad=deepcopy(spec);bad['inputs'][0]={'id':'a','url':'http://arbitrary/internal'}
        self.assertTrue(errors('MediaSpec',bad))

if __name__=='__main__':unittest.main()
