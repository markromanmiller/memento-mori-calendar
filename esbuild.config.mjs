import esbuild from 'esbuild';

const prod = process.argv[2] === 'production';

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian'],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  minify: prod,
  outfile: 'main.js',
});

if (prod) {
  await ctx.rebuild();
  ctx.dispose();
} else {
  await ctx.watch();
}
