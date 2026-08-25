import type {
  ApprovalAuditRequest,
  ApprovalStatus,
  CliType,
  ConversationId,
  MemoryType,
  Platform,
  SessionStatus,
  UserLanguage,
} from './common'

export interface CursorPosition {
  timestamp: number
  id: string
}

export interface CursorPageQuery {
  limit: number
  before?: CursorPosition
}

export interface CursorPage<T> {
  items: T[]
  nextCursor: string | null
}

export interface ConversationListQuery extends CursorPageQuery {
  platform?: Platform
  userId?: string
  cli?: CliType
  status?: SessionStatus
}

export interface ConversationView {
  id: ConversationId
  platform: Platform
  userId: string
  cli: CliType
  cwd: string
  status: SessionStatus
  createdAt: number
  updatedAt: number
  messageCount: number
  fileCount: number
  auditCount: number
}

export type ConversationDetail = ConversationView

export interface TimelineChatItem {
  type: 'chat'
  id: string
  role: 'user' | 'assistant'
  content: string
  attachments: Array<{
    id: string
    kind: string
    fileName: string | null
    mimeType: string | null
    fileSize: number | null
  }>
  createdAt: number
}

export interface TimelineApprovalItem {
  type: 'approval'
  id: string
  createdAt: number
  approval: ApprovalView | null
}

export type TimelineItem = TimelineChatItem | TimelineApprovalItem

export interface TimelinePage {
  items: TimelineItem[]
  nextCursor: string | null
}

export interface ConversationFileView {
  id: string
  sequence: number
  kind: string
  fileName: string | null
  mimeType: string | null
  fileSize: number | null
  createdAt: number
}

export interface ConversationFilePage {
  items: ConversationFileView[]
  nextCursor: string | null
}

export interface ManagedFileResult {
  body: Blob
  fileName: string | null
  mimeType: string | null
}

export interface ConversationDeletionResult {
  conversationId: ConversationId
  managedFilePaths: string[]
  deleted: {
    messages: number
    audits: number
    files: number
  }
  fileCleanupWarnings: string[]
}

export interface PreferenceScope {
  platform: Platform
  userId: string
}

export interface PreferenceScopeView extends PreferenceScope {
  defaultCli: CliType
  updatedAt: number
}

export interface PreferenceScopePage {
  items: PreferenceScopeView[]
  nextCursor: string | null
}

export interface CliPreferenceView {
  cli: CliType
  cwd: string
  modelId: string | null
  modelName: string | null
}

export interface PreferenceSnapshot {
  scope: PreferenceScope
  language: UserLanguage
  defaultCli: CliType
  autoApproveEnabled: boolean
  autoApproveSeconds: number
  cli: CliPreferenceView[]
  updatedAt: number
}

export interface PreferenceUpdate {
  language?: UserLanguage
  defaultCli?: CliType
  autoApproveEnabled?: boolean
  autoApproveSeconds?: number
}

export interface CliPreferenceUpdate {
  cwd?: string
  modelId?: string | null
  modelName?: string | null
}

export interface MemoryListQuery extends CursorPageQuery {
  type?: MemoryType
  search?: string
}

export interface MemoryView {
  id: string
  namespace: string
  type: MemoryType
  content: string
  importance: number
  accessCount: number
  lastAccessedAt: number | null
  tag: string | null
  createdAt: number
  embeddingPresent: boolean
}

export interface MemoryPage {
  items: MemoryView[]
  nextCursor: string | null
}

export interface MemoryUpdate {
  content?: string
  type?: MemoryType
  importance?: number
}

export interface ApprovalView {
  id: string
  conversationId: ConversationId
  approvalId: string
  request: ApprovalAuditRequest
  status: ApprovalStatus
  operator: string | null
  automatic: boolean
  createdAt: number
}

export interface AuditView extends ApprovalView {
  platform: Platform
  userId: string
  cli: CliType
  cwd: string
}

export interface AuditListQuery extends CursorPageQuery {
  conversationId?: ConversationId
  platform?: Platform
  userId?: string
  cli?: CliType
  status?: ApprovalStatus
}

export interface AuditPage {
  items: AuditView[]
  nextCursor: string | null
}

export interface WebAdmin {
  listConversations(query: ConversationListQuery): Promise<CursorPage<ConversationView>>
  getConversation(id: ConversationId): Promise<ConversationDetail | null>
  getConversationTimeline(id: ConversationId, page: CursorPageQuery): Promise<TimelinePage | null>
  getConversationFiles(id: ConversationId, page: CursorPageQuery): Promise<ConversationFilePage | null>
  getConversationFile(id: ConversationId, fileId: string): Promise<ManagedFileResult | null>
  deleteConversation(id: ConversationId): Promise<ConversationDeletionResult | null>
  listPreferenceScopes(query: CursorPageQuery): Promise<PreferenceScopePage>
  getPreferences(scope: PreferenceScope): Promise<PreferenceSnapshot>
  updatePreferences(scope: PreferenceScope, input: PreferenceUpdate): Promise<PreferenceSnapshot>
  updateCliPreference(scope: PreferenceScope, cli: CliType, input: CliPreferenceUpdate): Promise<CliPreferenceView>
  listMemories(query: MemoryListQuery): Promise<MemoryPage>
  updateMemory(id: string, input: MemoryUpdate): Promise<MemoryView | null>
  deleteMemory(id: string): Promise<'deleted' | 'not_found' | 'read_only'>
  refreshEnvironmentMemories(): Promise<void>
  listAudits(query: AuditListQuery): Promise<AuditPage>
}
