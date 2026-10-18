/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_USE_MOCKS?: string;
  /** `0` / `false` / `off` turns the editable Write view off (see `features/editor/lib/write-editing.ts`). */
  readonly VITE_WRITE_EDITING?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
