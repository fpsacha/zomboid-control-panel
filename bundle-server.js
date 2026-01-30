import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['./server/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: './server.cjs',
  external: ['@aws-sdk/client-s3'],
  define: {
    'import.meta.url': 'import_meta_url'
  },
  banner: {
    js: `const import_meta_url = require('url').pathToFileURL(__filename).href;`
  }
});

console.log('✅ Server bundled to server.cjs');
