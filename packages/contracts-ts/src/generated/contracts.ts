export type EditOp =
  | ReplaceSnippetOp
  | ClassTokensOp
  | JsxAttrOp
  | StylePropOp
  | TextContentOp
  | TextAtOp
  | CreateFileOp
  | RewriteFileOp;
export type ProjectPath = string;
export type ContentHash = string;
export type JsxValue = JsxStringValue | JsxExpressionValue;
export type StyleGroup = 'fill' | 'radius' | 'stroke' | 'text' | 'effects' | 'opacity';
export type ContentPart = TextPart | CodePart | FoundPart | ElementPart;
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
  | TrackerStatusMessage
  | TrackerStatusOkMessage
  | TrackerSearchMessage
  | TrackerTicketsMessage
  | TrackerTicketMessage
  | TrackerTicketOkMessage
  | TrackerStartMessage
  | TrackerStartedMessage
  | TrackerPostMessage
  | TrackerPostedMessage
  | TrackerReportMessage
  | TrackerReportedMessage
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
  | 'TRACKER_NOT_PAIRED'
  | 'TRACKER_FAILED'
  | 'INTERNAL';
export type BridgeErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'TOO_LARGE'
  | 'RATE_LIMITED'
  | 'JIRA_ERROR'
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
export interface TextContentOp {
  kind: 'text_content';
  file: ProjectPath;
  base_hash: ContentHash;
  at: SrcLoc;
  run: number;
  value: string;
}
export interface TextAtOp {
  kind: 'text_at';
  file: ProjectPath;
  base_hash: ContentHash;
  at: SrcLoc;
  value: string;
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
  content?: ContentPart[];
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
export interface TextPart {
  kind: 'text';
  run: number;
  value: string;
}
export interface CodePart {
  kind: 'code';
  source: string;
}
export interface FoundPart {
  kind: 'found';
  value: string;
  code: string;
  places: [TextPlace, ...TextPlace[]];
}
export interface TextPlace {
  file: string;
  line: number;
  column: number;
  label: string;
}
export interface ElementPart {
  kind: 'element';
  tag: string;
}
export interface FinetuneProps {
  fill?: FillValue;
  radius?: RadiusValue;
  source?: {
    file: string;
    line: number;
    column: number;
    value: string;
  };
  content?: [TextEdit, ...TextEdit[]];
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
export interface TextEdit {
  run: number;
  value: string;
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
  payload: ElementInspect;
}
export interface ElementInspect {
  file: string;
  line: number;
  column: number;
  text?: string;
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
  text?: {
    run: number;
    value: string;
  }[];
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
  instance?: {
    count: number;
    placedAt?: string;
    index?: number;
    text?: string;
  };
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
export interface SourceRef {
  file: string;
  line: number;
  column: number;
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
export interface TrackerStatusMessage {
  type: 'tracker.status';
  id?: string;
  payload: TrackerStatusRequest;
}
export interface TrackerStatusRequest {}
export interface TrackerStatusOkMessage {
  type: 'tracker.status.ok';
  id?: string;
  payload: TrackerStatus;
}
export interface TrackerStatus {
  sites: TrackerSite[];
}
export interface TrackerSite {
  provider: 'jira';
  site: string;
  url: string;
  account: string;
  projects: TrackerProject[];
  error?: string;
}
export interface TrackerProject {
  key: string;
  name: string;
}
export interface TrackerSearchMessage {
  type: 'tracker.search';
  id?: string;
  payload: TicketSearch;
}
export interface TicketSearch {
  site?: string;
  preset: 'assigned' | 'queued';
  query?: string;
}
export interface TrackerTicketsMessage {
  type: 'tracker.tickets';
  id?: string;
  payload: TicketList;
}
export interface TicketList {
  tickets: TicketSummary[];
}
export interface TicketSummary {
  ref: TicketRef;
  summary: string;
  status: string;
  type?: string;
  url: string;
}
export interface TicketRef {
  provider: 'jira';
  site: string;
  key: string;
}
export interface TrackerTicketMessage {
  type: 'tracker.ticket';
  id?: string;
  payload: TicketRequest;
}
export interface TicketRequest {
  ref: TicketRef;
}
export interface TrackerTicketOkMessage {
  type: 'tracker.ticket.ok';
  id?: string;
  payload: TicketDetail;
}
export interface TicketDetail {
  ref: TicketRef;
  summary: string;
  description: string;
  status: string;
  url: string;
  images:
    | []
    | [TicketImage]
    | [TicketImage, TicketImage]
    | [TicketImage, TicketImage, TicketImage]
    | [TicketImage, TicketImage, TicketImage, TicketImage];
  transitions: TicketTransition[];
}
export interface TicketImage {
  name: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
}
export interface TicketTransition {
  id: string;
  name: string;
}
export interface TrackerStartMessage {
  type: 'tracker.start';
  id?: string;
  payload: TicketStart;
}
export interface TicketStart {
  ref: TicketRef;
  pageUrl: string;
  src: string;
}
export interface TrackerStartedMessage {
  type: 'tracker.started';
  id?: string;
  payload: TicketStarted;
}
export interface TicketStarted {
  ref: TicketRef;
}
export interface TrackerPostMessage {
  type: 'tracker.post';
  id?: string;
  payload: TicketPost;
}
export interface TicketPost {
  ref: TicketRef;
  journalId: string;
  pageUrl: string;
  src: string;
  before: [] | [SketchImage] | [SketchImage, SketchImage];
  after: [] | [SketchImage] | [SketchImage, SketchImage];
  transitionId?: string;
}
export interface TrackerPostedMessage {
  type: 'tracker.posted';
  id?: string;
  payload: TicketPosted;
}
export interface TicketPosted {
  ref: TicketRef;
  journalId: string;
  outcome: 'posted' | 'cancelled';
  url: string;
}
export interface TrackerReportMessage {
  type: 'tracker.report';
  id?: string;
  payload: TicketReport;
}
export interface TicketReport {
  site: string;
  project: string;
  summary: string;
  description: string;
  pageUrl: string;
  src: string;
  image: SketchImage;
}
export interface TrackerReportedMessage {
  type: 'tracker.reported';
  id?: string;
  payload: TicketReported;
}
export interface TicketReported {
  ref: TicketRef;
  url: string;
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
export interface BridgeError {
  ok: false;
  code: BridgeErrorCode;
  message: string;
}
export interface BridgeWhoami {
  accountId: string;
  displayName: string;
  site: string;
  url: string;
  projects: TrackerProject[];
}
export interface BridgeTicketSummary {
  key: string;
  summary: string;
  status: string;
  type?: string;
}
export interface BridgeTicketPage {
  tickets: BridgeTicketSummary[];
}
export interface BridgeAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}
export interface BridgeTicket {
  key: string;
  summary: string;
  description: string;
  status: string;
  attachments: BridgeAttachment[];
  transitions: TicketTransition[];
}
export interface BridgeImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
}
export interface BridgeStart {
  pageUrl: string;
  src: string;
}
export interface BridgeResult {
  journalId: string;
  summary: string;
  files: string[];
  changes: CodeChange[];
  patch?: string;
  pageUrl: string;
  src: string;
  agent: string;
  before: [] | [SketchImage] | [SketchImage, SketchImage];
  after: [] | [SketchImage] | [SketchImage, SketchImage];
  transitionId?: string;
}
export interface BridgePosted {
  key: string;
  url: string;
}
export interface BridgeReverted {
  journalId: string;
}
export interface BridgeCreate {
  project: string;
  summary: string;
  description: string;
  pageUrl: string;
  src: string;
  image?: SketchImage;
}
