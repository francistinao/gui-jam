export type EditOp =
  ReplaceSnippetOp | ClassTokensOp | JsxAttrOp | StylePropOp | CreateFileOp | RewriteFileOp;
export type ProjectPath = string;
export type ContentHash = string;
export type JsxValue = JsxStringValue | JsxExpressionValue;
export type StyleGroup = 'fill' | 'radius' | 'stroke' | 'text' | 'effects' | 'opacity';
export type FillValue = FillToken | FillHex | FillNone;
export type RadiusValue = RadiusToken | RadiusPx | RadiusFull;
export type GuijamMessage =
  | PluginHelloMessage
  | HelloOkMessage
  | TailwindRootsMessage
  | OverlaySetMessage
  | OverlayClearMessage
  | UpdateResultMessage
  | ElementInspectMessage
  | ElementStyleMessage
  | FinetunePreviewMessage
  | FinetunePreviewedMessage
  | ChangesetCommitMessage
  | CommitDoneMessage
  | ChangesetDiscardMessage
  | ChangesetDiscardedMessage
  | JournalUndoMessage
  | UndoDoneMessage
  | GenerateRequestMessage
  | GenerateDoneMessage
  | GenerateCancelMessage
  | GenerateCancelledMessage
  | {
      type: 'generate.progress';
      id?: string;
      payload: GenerateProgress;
    }
  | {
      type: 'variant.select';
      id?: string;
      payload: VariantSelect;
    }
  | {
      type: 'variant.selected';
      id?: string;
      payload: VariantSelected;
    }
  | {
      type: 'dependencies.install';
      id?: string;
      payload: DependenciesInstall;
    }
  | {
      type: 'dependencies.installed';
      id?: string;
      payload: DependenciesInstalled;
    }
  | {
      type: 'generate.discard';
      id?: string;
      payload: RunRef;
    }
  | {
      type: 'generate.discarded';
      id?: string;
      payload: RunRef;
    }
  | {
      type: 'generate.attach';
      id?: string;
      payload: GenerateAttach;
    }
  | {
      type: 'preview.release';
      id?: string;
      payload: PreviewRelease;
    }
  | {
      type: 'preview.released';
      id?: string;
      payload: PreviewRelease;
    }
  | ErrorMessage;
export type ErrorCode =
  | 'CONFLICT'
  | 'STALE_BASE'
  | 'PATH_DENIED'
  | 'NOT_EDITABLE'
  | 'INVALID_REQUEST'
  | 'UNKNOWN_CHANGESET'
  | 'UNKNOWN_ENTRY'
  | 'ALREADY_UNDONE'
  | 'CANCELLED'
  | 'PROVIDER_NOT_INSTALLED'
  | 'PROVIDER_NOT_AUTHENTICATED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_INVALID_OUTPUT'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_FAILED'
  | 'PROVIDER_CRASHED'
  | 'PLUGIN_UNAVAILABLE'
  | 'DAEMON_UNAVAILABLE'
  | 'INTERNAL';

export interface ReplaceSnippetOp {
  kind: 'replace_snippet';
  file: ProjectPath;
  base_hash: ContentHash;
  find: string;
  replace: string;
}
export interface ClassTokensOp {
  kind: 'class_tokens';
  file: ProjectPath;
  base_hash: ContentHash;
  at: SrcLoc;
  add: string[];
  remove: string[];
}
export interface SrcLoc {
  line: number;
  column: number;
}
export interface JsxAttrOp {
  kind: 'jsx_attr';
  file: ProjectPath;
  base_hash: ContentHash;
  at: SrcLoc;
  name: string;
  value: JsxValue | null;
}
export interface JsxStringValue {
  string: string;
}
export interface JsxExpressionValue {
  expression: string;
}
export interface StylePropOp {
  kind: 'style_prop';
  file: ProjectPath;
  base_hash: ContentHash;
  at: SrcLoc;
  prop: string;
  value: string | number | null;
}
export interface CreateFileOp {
  kind: 'create_file';
  file: ProjectPath;
  content: string;
}
export interface RewriteFileOp {
  kind: 'rewrite_file';
  file: ProjectPath;
  base_hash: ContentHash;
  content: string;
}
export interface VariantSet {
  answer?: string;
  variants: [] | [Variant] | [Variant, Variant] | [Variant, Variant, Variant];
}
export interface Variant {
  label: string;
  system: string;
  style: string;
  rationale: string;
  missing: string[];
  ops: [EditOp, ...EditOp[]];
  assets?:
    | []
    | [
        {
          name: string;
          format: 'svg' | 'webp';
          svg: string;
          width?: number;
        }
      ]
    | [
        {
          name: string;
          format: 'svg' | 'webp';
          svg: string;
          width?: number;
        },
        {
          name: string;
          format: 'svg' | 'webp';
          svg: string;
          width?: number;
        }
      ]
    | [
        {
          name: string;
          format: 'svg' | 'webp';
          svg: string;
          width?: number;
        },
        {
          name: string;
          format: 'svg' | 'webp';
          svg: string;
          width?: number;
        },
        {
          name: string;
          format: 'svg' | 'webp';
          svg: string;
          width?: number;
        }
      ]
    | [
        {
          name: string;
          format: 'svg' | 'webp';
          svg: string;
          width?: number;
        },
        {
          name: string;
          format: 'svg' | 'webp';
          svg: string;
          width?: number;
        },
        {
          name: string;
          format: 'svg' | 'webp';
          svg: string;
          width?: number;
        },
        {
          name: string;
          format: 'svg' | 'webp';
          svg: string;
          width?: number;
        }
      ];
}
export interface UpdateResult {
  updateId: string;
  status: 'ok' | 'compile_error' | 'runtime_error' | 'full_reload' | 'timeout';
  latencyMs: number;
  errors: UpdateError[];
}
export interface UpdateError {
  message: string;
  file?: string;
  line?: number;
  stack?: string;
  attributed: boolean;
}
export interface ElementStyle {
  file: string;
  line: number;
  column: number;
  tag: string;
  baseHash: ContentHash;
  classSource: 'none' | 'static' | 'call' | 'dynamic';
  tokens: StyleToken[];
  theme: ThemeTokens;
  adapter: 'tailwind' | 'inline' | 'vuetify';
  styleSource: 'none' | 'object' | 'dynamic';
}
export interface StyleToken {
  token: string;
  group: StyleGroup;
  property: string;
  variants: string[];
  themeToken?: string;
  value?: string;
  editable: boolean;
}
export interface ThemeTokens {
  colors: ThemeColor[];
  radii: ThemeRadius[];
}
export interface ThemeColor {
  name: string;
  value: string;
}
export interface ThemeRadius {
  name: string;
  px: number;
}
export interface FinetuneProps {
  fill?: FillValue;
  radius?: RadiusValue;
}
export interface FillToken {
  kind: 'token';
  name: string;
}
export interface FillHex {
  kind: 'hex';
  hex: string;
  opacity: number;
}
export interface FillNone {
  kind: 'none';
}
export interface RadiusToken {
  kind: 'token';
  name: string;
}
export interface RadiusPx {
  kind: 'px';
  px: number;
}
export interface RadiusFull {
  kind: 'full';
}
export interface PluginHelloMessage {
  type: 'plugin.hello';
  id?: string;
  payload: PluginHello;
}
export interface PluginHello {
  pluginVersion: string;
  viteVersion: string;
  root: string;
  tailwindRoots: string[];
}
export interface HelloOkMessage {
  type: 'hello.ok';
  id?: string;
  payload: HelloOk;
}
export interface HelloOk {
  daemonVersion: string;
}
export interface TailwindRootsMessage {
  type: 'tailwind.roots';
  id?: string;
  payload: TailwindRoots;
}
export interface TailwindRoots {
  files: string[];
}
export interface OverlaySetMessage {
  type: 'overlay.set';
  id?: string;
  payload: OverlaySet;
}
export interface OverlaySet {
  file: string;
  content: string;
  pageReload?: boolean;
}
export interface OverlayClearMessage {
  type: 'overlay.clear';
  id?: string;
  payload: OverlayClear;
}
export interface OverlayClear {
  file: string;
  pageReload?: boolean;
}
export interface UpdateResultMessage {
  type: 'update.result';
  id?: string;
  payload: UpdateResult;
}
export interface ElementInspectMessage {
  type: 'element.inspect';
  id?: string;
  payload: SourceRef;
}
export interface SourceRef {
  file: string;
  line: number;
  column: number;
}
export interface ElementStyleMessage {
  type: 'element.style';
  id?: string;
  payload: ElementStyle;
}
export interface FinetunePreviewMessage {
  type: 'finetune.preview';
  id?: string;
  payload: FinetunePreview;
}
export interface FinetunePreview {
  file: string;
  line: number;
  column: number;
  props: FinetuneProps;
}
export interface FinetunePreviewedMessage {
  type: 'finetune.previewed';
  id?: string;
  payload: FinetunePreviewed;
}
export interface FinetunePreviewed {
  changesetId: string;
  update: UpdateResult;
  changes: CodeChange[];
  dom?: DomPatch;
}
export interface CodeChange {
  file: string;
  line: number;
  before: string[];
  after: string[];
}
export interface DomPatch {
  src: string;
  addClasses: string[];
  removeClasses: string[];
  setStyles: {
    property: string;
    value: string;
  }[];
  removeStyles: string[];
}
export interface ChangesetCommitMessage {
  type: 'changeset.commit';
  id?: string;
  payload: ChangesetRef;
}
export interface ChangesetRef {
  changesetId: string;
}
export interface CommitDoneMessage {
  type: 'commit.done';
  id?: string;
  payload: CommitDone;
}
export interface CommitDone {
  journalId: string;
  files: string[];
  summary: string;
}
export interface ChangesetDiscardMessage {
  type: 'changeset.discard';
  id?: string;
  payload: ChangesetRef;
}
export interface ChangesetDiscardedMessage {
  type: 'changeset.discarded';
  id?: string;
  payload: ChangesetRef;
}
export interface JournalUndoMessage {
  type: 'journal.undo';
  id?: string;
  payload: JournalRef;
}
export interface JournalRef {
  journalId: string;
}
export interface UndoDoneMessage {
  type: 'undo.done';
  id?: string;
  payload: UndoDone;
}
export interface UndoDone {
  journalId: string;
  undoOf: string;
}
export interface GenerateRequestMessage {
  type: 'generate.request';
  id?: string;
  payload: GenerateRequest;
}
export interface GenerateRequest {
  runId: string;
  file: string;
  line: number;
  column: number;
  prompt: string;
  forceAi?: boolean;
  page?: PageOutline;
  sketch?: Sketch;
  attachments?: Attachments;
  alsoSelected?:
    | [SourceRef]
    | [SourceRef, SourceRef]
    | [SourceRef, SourceRef, SourceRef]
    | [SourceRef, SourceRef, SourceRef, SourceRef];
}
export interface PageOutline {
  items: PageItem[];
}
export interface PageItem {
  kind: 'landmark' | 'heading' | 'image' | 'link' | 'button';
  tag: string;
  text: string;
  region?: string;
  src?: string;
  url?: string;
  box: [number, number, number, number];
}
export interface Sketch {
  images: [SketchImage] | [SketchImage, SketchImage];
  box: [number, number, number, number];
  touching: string[];
  captureMs?: number;
  elementBox?: [number, number, number, number];
  near?: string;
}
export interface SketchImage {
  mediaType: 'image/png' | 'image/jpeg';
  base64: string;
}
export interface Attachments {
  images:
    | [InspirationImage]
    | [InspirationImage, InspirationImage]
    | [InspirationImage, InspirationImage, InspirationImage]
    | [InspirationImage, InspirationImage, InspirationImage, InspirationImage];
}
export interface InspirationImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
}
export interface GenerateDoneMessage {
  type: 'generate.done';
  id?: string;
  payload: GenerateDone;
}
export interface GenerateDone {
  runId: string;
  route: Route;
  summary: string;
  elapsedMs: number;
  variants:
    | []
    | [VariantPreview]
    | [VariantPreview, VariantPreview]
    | [VariantPreview, VariantPreview, VariantPreview];
  notes?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string];
  dropped: {
    label?: string;
    reason: string;
  }[];
  update?: UpdateResult;
  answer?: string;
}
export interface Route {
  tier: 'R0' | 'R1' | 'R2';
  provider?: string;
  model?: string;
  notice?: string;
}
export interface VariantPreview {
  changesetId: string;
  label: string;
  system: string;
  style: string;
  rationale: string;
  file: string;
  changes: CodeChange[];
  created: string[];
  needs?: DependencyNeeds;
}
export interface DependencyNeeds {
  command: string;
  packages:
    | [Package]
    | [Package, Package]
    | [Package, Package, Package]
    | [Package, Package, Package, Package];
}
export interface Package {
  name: string;
  version: string;
}
export interface GenerateCancelMessage {
  type: 'generate.cancel';
  id?: string;
  payload: RunRef;
}
export interface RunRef {
  runId: string;
}
export interface GenerateCancelledMessage {
  type: 'generate.cancelled';
  id?: string;
  payload: RunRef;
}
export interface GenerateProgress {
  runId: string;
  timeoutMs?: number;
  variants?:
    | []
    | [VariantPreview]
    | [VariantPreview, VariantPreview]
    | [VariantPreview, VariantPreview, VariantPreview];
  waiting?: number;
  expectedMs?: number;
  update?: UpdateResult1;
  steps: {
    label: string;
    state: 'done' | 'active' | 'pending';
    detail?: string;
  }[];
}
export interface UpdateResult1 {
  updateId: string;
  status: 'ok' | 'compile_error' | 'runtime_error' | 'full_reload' | 'timeout';
  latencyMs: number;
  errors: UpdateError[];
}
export interface VariantSelect {
  runId: string;
  changesetId: string;
}
export interface VariantSelected {
  changesetId: string;
  update: UpdateResult;
}
export interface DependenciesInstall {
  runId: string;
  changesetId: string;
}
export interface DependenciesInstalled {
  changesetId: string;
  installed: Package[];
  update: UpdateResult;
}
export interface GenerateAttach {
  runId: string;
}
export interface PreviewRelease {
  runId: string;
}
export interface ErrorMessage {
  type: 'error';
  id?: string;
  payload: ErrorPayload;
}
export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  action?: string;
}
