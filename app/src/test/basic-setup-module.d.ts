// The package is a transitive dependency (not resolvable from `src`), and the build aliases it to
// `lib/editor-setup.ts`: give the alias target's shape to the one test that imports it by its
// upstream name (`lib/editor-setup.test.tsx`).
declare module '@uiw/codemirror-extensions-basic-setup' {
  export * from '@/features/editor/lib/editor-setup';
}
