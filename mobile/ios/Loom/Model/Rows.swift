import Foundation

// The runner's rows and pushes, as src/shared/ipc-contract.ts defines them. Only the fields this
// app shows or acts on are read; everything else in a row is ignored.

struct ProjectRow: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
}

enum SharedAccess: String, Decodable, Equatable {
    case view
    case control
}

struct WorkspaceRow: Decodable, Equatable, Identifiable {
    struct Bot: Decodable, Equatable {
        let id: String
        let access: String
    }

    let id: String
    let projectId: String
    var name: String
    let branch: String
    let archived: Bool
    /// initializing, setting_up, ready or error.
    var state: String
    /// machine or container.
    let runtime: String
    /// Present on a shared bot workspace; absent on the person's own.
    let bot: Bot?

    /// What the runner says this person may do in a shared workspace. A display hint: the runner
    /// checks every call itself. Anything but an explicit "control" is treated as view only.
    var sharedAccess: SharedAccess? {
        bot.map { SharedAccess(rawValue: $0.access) == .control ? .control : .view }
    }
}

struct WorkspacePower: Decodable, Equatable {
    /// stopped, starting, running, stopping or error.
    let state: String
    let error: String?
}

struct WorkspacePowerPush: Decodable, Equatable {
    let workspaceId: String
    let state: String
    let error: String?
}

struct WorkspaceStatePush: Decodable {
    let workspaceId: String
    let state: String
    let name: String?
}

struct SessionRow: Decodable, Equatable, Identifiable {
    let id: String
    let workspaceId: String
    let backend: String
    let model: String
    let effort: String
    var title: String
    let createdAt: Double
    let closedAt: Double?
}

/// The tabs with a turn in flight, each mapped to its workspace.
struct SessionActivity: Decodable {
    let revision: Int
    let bySession: [String: String]
}

struct SessionUnread: Decodable, Equatable {
    let workspaceId: String
    let seq: Int
}

struct SessionEventPush: Decodable {
    let sessionId: String
    let seq: Int
    let event: AgentEvent
    let unread: SessionUnread?
}

struct QueuedMessage: Decodable, Equatable, Identifiable {
    let id: String
    let text: String
}

struct SessionQueuePush: Decodable {
    let sessionId: String
    let items: [QueuedMessage]
}

struct SessionTitlePush: Decodable {
    let sessionId: String
    let title: String
}

struct BotChangedPush: Decodable {
    let accessChanged: Bool
}

struct FileNode: Decodable, Equatable, Identifiable {
    let name: String
    let path: String
    /// dir or file.
    let kind: String
    var id: String { path }
    var isDirectory: Bool { kind == "dir" }
}

struct FileText: Decodable, Equatable {
    let text: String
    let language: String
}

struct ChangeEntry: Decodable, Equatable, Identifiable {
    let path: String
    /// modified, added, deleted, renamed or untracked.
    let status: String
    let staged: Bool
    let unstaged: Bool
    var id: String { path }
}

// MARK: Call inputs

struct ProjectInput: Encodable { let projectId: String }
struct WorkspaceInput: Encodable { let workspaceId: String }
struct SessionInput: Encodable { let sessionId: String }
struct PathInput: Encodable {
    let workspaceId: String
    let path: String
}
struct EventsAfterInput: Encodable {
    let sessionId: String
    let afterSeq: Int
}
struct MarkReadInput: Encodable {
    let sessionId: String
    let seq: Int
}
/// A message with its identity across retries: the runner runs each `messageId` at most once.
struct SendInput: Encodable {
    let sessionId: String
    let text: String
    let attachments: [String]
    let messageId: String
}
struct AnswerInput: Encodable {
    struct Answer: Encodable {
        let requestId: String
        let answers: [String: [String]]
    }
    let sessionId: String
    let answer: Answer
}
