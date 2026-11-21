export type BridgeErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'TOO_LARGE'
  | 'RATE_LIMITED'
  | 'JIRA_ERROR'
  | 'INTERNAL';

export interface CodeChange {
  file: string;
  line: number;
  before: string[];
  after: string[];
}
export interface SketchImage {
  mediaType: 'image/png' | 'image/jpeg';
  base64: string;
}
export interface TrackerProject {
  key: string;
  name: string;
}
export interface TicketTransition {
  id: string;
  name: string;
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
