import {defineConfig, loadEnv} from 'vite';
export default defineConfig(({mode})=>{
 const env=loadEnv(mode, process.cwd(), '');
 const runtimeMode=process.env.RHTV_MODE || env.RHTV_MODE || 'service';
 if(!['preview','service'].includes(runtimeMode))throw new Error('RHTV_MODE must be preview or service');
 return {
  define:{__RHTV_BUILD_MODE__:JSON.stringify(runtimeMode)},
  build:{target:'es2022',outDir:'dist',emptyOutDir:true,rollupOptions:{external:(id:string)=>id.startsWith('/project/assets/')}},
  server:{proxy:{'/api/v1':{target:env.RHTV_DEV_API_TARGET||'http://127.0.0.1:3001',changeOrigin:false},'/api/v2':{target:env.RHTV_DEV_API_TARGET||'http://127.0.0.1:3001',changeOrigin:false},'/storage':{target:env.RHTV_DEV_API_TARGET||'http://127.0.0.1:3001',changeOrigin:false}}}
 };
});
