import Foundation
import Observation

/// An unsent message. Memory only; kept until the runner acknowledges it.
struct Draft: Equatable {
    var text = ""
    var error: String?
    var isSending = false
    /// The identity of the last attempt and the text it carried. A retry of the same text reuses
    /// it, so a message the runner already accepted is not run twice.
    fileprivate var attemptID: String?
    fileprivate var attemptText: String?
}

/// Everything private that one sign-in has loaded or typed, and the work that fills it.
///
/// A scope is created when a sign-in begins and is dropped, never emptied, when it ends. Work
/// still in flight for an ended sign-in finishes into the scope it started in, which no screen
/// shows any more, and asks nothing further of the shared connection. That holds by ownership,
/// not by each operation remembering to compare a counter after every suspension.
///
/// Within a sign-in, visibility can still shrink (a bot grant revoked). Whatever the runner no
/// longer lists is evicted, and results are kept only for workspaces it still lists.
@MainActor
@Observable
final class AccountScope {
    private(set) var projects: [ProjectRow] = []
    private(set) var isLoadingInventory = false
    private(set) var hasLoadedInventory = false
    private(set) var inventoryError: String?
    /// Mirrors the connection, so controls are offered only while writes can reach the runner.
    var connection: ConnectionState
    let isPreview: Bool

    private var workspacesByProject: [String: [WorkspaceRow]] = [:]
    private var sessionsByWorkspace: [String: [SessionRow]] = [:]
    private var sessionsLoaded: Set<String> = []
    private var sessionErrors: [String: String] = [:]
    private var power: [String: WorkspacePower] = [:]
    private var powerBusy: Set<String> = []
    private var running: [String: String] = [:]
    private var activityRevision = Int.min
    private var unread: [String: SessionUnread] = [:]
    private var timelines: [String: SessionTimeline] = [:]
    private var timelineErrors: [String: String] = [:]
    private var catchingUp: Set<String> = []
    private var drafts: [String: Draft] = [:]
    private var questions: [String: QuestionDraft] = [:]
    private var queues: [String: [QueuedMessage]] = [:]
    private var actionErrors: [String: String] = [:]
    private var visibleSession: String?

    /// What is typed into a question card, minus its secret answers, by request.
    private struct QuestionDraft {
        let sessionId: String
        var form: QuestionForm?
        /// Accepted by the runner; the card waits for the transcript to close it.
        var sent = false
    }

    @ObservationIgnored private let runner: RunnerConnection?
    @ObservationIgnored private var ended = false
    @ObservationIgnored private var refreshing: Task<Void, Never>?
    @ObservationIgnored private var inventoryWanted = false

    init(runner: RunnerConnection, connection: ConnectionState) {
        self.runner = runner
        self.connection = connection
        isPreview = false
    }

    /// The sign-in is over. Nothing this scope still has in flight may use the connection again,
    /// which by then may carry someone else's sign-in.
    func end() {
        ended = true
        refreshing?.cancel()
    }

    /// The one way this scope reaches the runner.
    private var live: RunnerConnection {
        get throws {
            guard !ended, let runner else { throw RunnerCallError.unreachable }
            return runner
        }
    }

    #if DEBUG
    /// The disconnected preview: no connection at all, so nothing here can reach a host.
    init(previewing data: PreviewData) {
        runner = nil
        connection = .connected
        isPreview = true
        projects = data.projects
        workspacesByProject = data.workspaces
        sessionsByWorkspace = data.sessions
        sessionsLoaded = Set(data.sessions.keys)
        power = data.power
        running = data.running
        unread = data.unread
        timelines = data.timelines
        queues = data.queues
        hasLoadedInventory = true
        previewFiles = data
    }

    @ObservationIgnored private var previewFiles: PreviewData?
    #endif

    // MARK: Reading

    func workspaces(in projectId: String) -> [WorkspaceRow] { workspacesByProject[projectId] ?? [] }
    func workspace(_ id: String) -> WorkspaceRow? { workspacesByProject.values.lazy.flatMap { $0 }.first { $0.id == id } }
    func project(_ id: String) -> ProjectRow? { projects.first { $0.id == id } }
    func sessions(in workspaceId: String) -> [SessionRow] { sessionsByWorkspace[workspaceId] ?? [] }
    func hasLoadedSessions(in workspaceId: String) -> Bool { sessionsLoaded.contains(workspaceId) }
    func sessionsError(in workspaceId: String) -> String? { sessionErrors[workspaceId] }
    func session(_ id: String) -> SessionRow? { sessionsByWorkspace.values.lazy.flatMap { $0 }.first { $0.id == id } }
    func power(of workspaceId: String) -> WorkspacePower? { power[workspaceId] }
    func isChangingPower(_ workspaceId: String) -> Bool { powerBusy.contains(workspaceId) }
    func isRunning(sessionId: String) -> Bool { running[sessionId] != nil }
    func runningCount(in workspaceId: String) -> Int { running.values.filter { $0 == workspaceId }.count }
    func hasUnread(sessionId: String) -> Bool { (unread[sessionId]?.seq ?? 0) > 0 }
    func unreadCount(in workspaceId: String) -> Int { unread.values.filter { $0.workspaceId == workspaceId && $0.seq > 0 }.count }
    func timeline(_ sessionId: String) -> SessionTimeline? { timelines[sessionId] }
    func timelineError(_ sessionId: String) -> String? { timelineErrors[sessionId] }
    func draft(_ sessionId: String) -> Draft { drafts[sessionId] ?? Draft() }
    func queue(_ sessionId: String) -> [QueuedMessage] { queues[sessionId] ?? [] }
    func actionError(_ key: String) -> String? { actionErrors[key] }
    func clearActionError(_ key: String) { actionErrors[key] = nil }

    /// Whether this person may act in a workspace, as far as the runner has said. The runner
    /// enforces it on every call; this only decides which controls are offered.
    func canControl(_ workspaceId: String) -> Bool {
        guard let row = workspace(workspaceId) else { return false }
        return row.sharedAccess != .view
    }

    /// Writes are offered only on a live connection to a workspace this person controls.
    func canWrite(_ workspaceId: String) -> Bool { canControl(workspaceId) && connection == .connected }

    private func describe(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? "Something went wrong. Try again."
    }

    // MARK: Live updates

    /// A (re)connection: reload what this person may see now, and catch open conversations up.
    func connected() async {
        await refreshInventory()
        for sessionId in timelines.keys { await catchUp(sessionId) }
    }

    private func payload<Payload: Decodable>(_ frame: Data) -> Payload? {
        (try? JSONDecoder().decode(PushPayload<Payload>.self, from: frame))?.payload
    }

    func receive(_ channel: String, _ frame: Data) {
        switch channel {
        case "session:event":
            guard let push: SessionEventPush = payload(frame) else { return }
            // Only conversations this person has open are kept; the rest replay when opened.
            if timelines[push.sessionId] != nil {
                timelines[push.sessionId]?.ingest(seq: push.seq, event: push.event)
                settleQuestions(push.sessionId)
                if timelines[push.sessionId]?.hasGap == true {
                    let sessionId = push.sessionId
                    Task { await catchUp(sessionId) }
                }
            }
            if let mark = push.unread, session(push.sessionId) != nil || workspace(mark.workspaceId) != nil {
                if visibleSession == push.sessionId { markRead(push.sessionId, mark) } else { unread[push.sessionId] = mark }
            }
        case "session:activity":
            guard let activity: SessionActivity = payload(frame), activity.revision >= activityRevision else { return }
            activityRevision = activity.revision
            running = activity.bySession
        case "workspaces:powerChanged":
            guard let push: WorkspacePowerPush = payload(frame), workspace(push.workspaceId) != nil else { return }
            power[push.workspaceId] = WorkspacePower(state: push.state, error: push.error)
        case "workspace:state":
            guard let push: WorkspaceStatePush = payload(frame) else { return }
            for (projectId, rows) in workspacesByProject {
                guard let index = rows.firstIndex(where: { $0.id == push.workspaceId }) else { continue }
                workspacesByProject[projectId]?[index].state = push.state
                if let name = push.name { workspacesByProject[projectId]?[index].name = name }
            }
        case "session:queue":
            guard let push: SessionQueuePush = payload(frame), session(push.sessionId) != nil else { return }
            queues[push.sessionId] = push.items
        case "session:title":
            guard let push: SessionTitlePush = payload(frame) else { return }
            for (workspaceId, rows) in sessionsByWorkspace {
                guard let index = rows.firstIndex(where: { $0.id == push.sessionId }) else { continue }
                sessionsByWorkspace[workspaceId]?[index].title = push.title
            }
        case "bots:changed":
            // A grant changed: what this person may see is whatever the runner lists now.
            guard let push: BotChangedPush = payload(frame), push.accessChanged else { return }
            Task { await refreshInventory() }
        default:
            break
        }
    }

    // MARK: Inventory

    /// Reloads projects, workspaces, activity and unread marks. One listing runs at a time, and a
    /// request made while one runs starts another after it: replies can arrive in any order, so
    /// this is what makes the listing applied last always one asked for after the latest change.
    /// What was loaded stays on screen if a listing fails; what the runner no longer lists is
    /// forgotten when one succeeds.
    func refreshInventory() async {
        guard runner != nil, !ended else { return }
        inventoryWanted = true
        if let refreshing { return await refreshing.value }
        let task = Task {
            while inventoryWanted, !ended {
                inventoryWanted = false
                await listInventory()
            }
            refreshing = nil
        }
        refreshing = task
        await task.value
    }

    private func listInventory() async {
        isLoadingInventory = true
        defer { isLoadingInventory = false }
        do {
            let runner = try live
            let listed: [ProjectRow] = try await runner.call("projects:list")
            var byProject: [String: [WorkspaceRow]] = [:]
            for project in listed {
                byProject[project.id] = try await runner.call("workspaces:list", ProjectInput(projectId: project.id))
            }
            let activity: SessionActivity = try await runner.call("sessions:activity")
            let marks: [String: SessionUnread] = try await runner.call("sessions:unread")
            projects = listed
            workspacesByProject = byProject
            if activity.revision >= activityRevision {
                activityRevision = activity.revision
                running = activity.bySession
            }
            unread = marks
            inventoryError = nil
            hasLoadedInventory = true
            evictInvisible()
            await refreshPower()
        } catch {
            inventoryError = describe(error)
        }
    }

    /// Container power is separate from setup state; the list shows both.
    private func refreshPower() async {
        for row in workspacesByProject.values.flatMap({ $0 }) where row.runtime == "container" && !row.archived {
            guard let runner = try? live else { return }
            guard let state: WorkspacePower = try? await runner.call("workspaces:power", WorkspaceInput(workspaceId: row.id)) else { continue }
            if workspace(row.id) != nil { power[row.id] = state }
        }
    }

    /// Drops everything belonging to workspaces the runner did not list.
    private func evictInvisible() {
        let visible = Set(workspacesByProject.values.flatMap { $0 }.map(\.id))
        var gone: Set<String> = []
        for (workspaceId, rows) in sessionsByWorkspace where !visible.contains(workspaceId) {
            gone.formUnion(rows.map(\.id))
            sessionsByWorkspace[workspaceId] = nil
            sessionsLoaded.remove(workspaceId)
            sessionErrors[workspaceId] = nil
        }
        let known = Set(sessionsByWorkspace.values.flatMap { $0 }.map(\.id))
        gone.formUnion(timelines.keys.filter { !known.contains($0) })
        gone.formUnion(drafts.keys.filter { !known.contains($0) })
        for sessionId in gone {
            timelines[sessionId] = nil
            timelineErrors[sessionId] = nil
            drafts[sessionId] = nil
            queues[sessionId] = nil
        }
        questions = questions.filter { known.contains($0.value.sessionId) }
        power = power.filter { visible.contains($0.key) }
        powerBusy = powerBusy.filter { visible.contains($0) }
        running = running.filter { visible.contains($0.value) }
        unread = unread.filter { visible.contains($0.value.workspaceId) }
        if let open = visibleSession, !known.contains(open) { visibleSession = nil }
    }

    func loadSessions(workspaceId: String) async {
        guard workspace(workspaceId) != nil, let runner = try? live else { return }
        do {
            let rows: [SessionRow] = try await runner.call("sessions:list", WorkspaceInput(workspaceId: workspaceId))
            guard workspace(workspaceId) != nil else { return }
            sessionsByWorkspace[workspaceId] = rows.filter { $0.closedAt == nil }
            sessionsLoaded.insert(workspaceId)
            sessionErrors[workspaceId] = nil
        } catch {
            guard workspace(workspaceId) != nil else { return }
            sessionErrors[workspaceId] = describe(error)
        }
    }

    // MARK: Conversations

    /// Loads a conversation from the start, or catches an already loaded one up.
    func openSession(_ sessionId: String) async {
        guard session(sessionId) != nil else { return }
        if timelines[sessionId] == nil { timelines[sessionId] = SessionTimeline() }
        guard let runner = try? live else { return }
        await catchUp(sessionId)
        if let items: [QueuedMessage] = try? await runner.call("sessions:queue", SessionInput(sessionId: sessionId)), session(sessionId) != nil {
            queues[sessionId] = items
        }
    }

    /// Asks for what follows the last event applied in order, until nothing is missing.
    private func catchUp(_ sessionId: String) async {
        guard timelines[sessionId] != nil, !catchingUp.contains(sessionId), let runner = try? live else { return }
        catchingUp.insert(sessionId)
        defer { catchingUp.remove(sessionId) }
        for _ in 0..<4 {
            guard let after = timelines[sessionId]?.cursor else { return }
            do {
                let events: [SequencedEvent] = try await runner.call("sessions:eventsAfter", EventsAfterInput(sessionId: sessionId, afterSeq: after))
                guard timelines[sessionId] != nil else { return }
                timelines[sessionId]?.ingest(replay: events)
                settleQuestions(sessionId)
                timelineErrors[sessionId] = nil
                if events.isEmpty || timelines[sessionId]?.hasGap != true { return }
            } catch {
                guard timelines[sessionId] != nil else { return }
                timelineErrors[sessionId] = describe(error)
                return
            }
        }
    }

    /// The conversation on screen. Its replies are marked read as they arrive.
    func setVisibleSession(_ sessionId: String?) {
        visibleSession = sessionId
        if let sessionId, let mark = unread[sessionId], mark.seq > 0 { markRead(sessionId, mark) }
    }

    private func markRead(_ sessionId: String, _ mark: SessionUnread) {
        unread[sessionId] = nil
        guard mark.seq > 0, let runner = try? live else { return }
        Task { try? await runner.send("sessions:markRead", MarkReadInput(sessionId: sessionId, seq: mark.seq)) }
    }

    func setDraft(_ sessionId: String, _ text: String) {
        var draft = drafts[sessionId] ?? Draft()
        guard !draft.isSending else { return }
        draft.text = text
        if draft.error != nil, text != draft.attemptText { draft.error = nil }
        drafts[sessionId] = draft
    }

    /// Sends the draft. It leaves the composer only once the runner has acknowledged it.
    func sendDraft(sessionId: String) async {
        guard let workspaceId = session(sessionId)?.workspaceId, canControl(workspaceId) else { return }
        var draft = drafts[sessionId] ?? Draft()
        let text = draft.text
        guard !draft.isSending, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard connection == .connected, let runner = try? live else {
            draft.error = isPreview ? "Preview is not connected, so nothing is sent." : "Not connected. Your message is kept here until you can send it."
            drafts[sessionId] = draft
            return
        }
        // The same text tried again is the same message, so the runner runs it at most once.
        let messageId = draft.attemptText == text ? draft.attemptID ?? UUID().uuidString.lowercased() : UUID().uuidString.lowercased()
        draft.attemptID = messageId
        draft.attemptText = text
        draft.isSending = true
        draft.error = nil
        drafts[sessionId] = draft
        do {
            try await runner.send("sessions:send", SendInput(sessionId: sessionId, text: text, attachments: [], messageId: messageId), identified: true)
            guard drafts[sessionId] != nil else { return }
            drafts[sessionId] = Draft()
        } catch {
            guard drafts[sessionId] != nil else { return }
            drafts[sessionId]?.isSending = false
            drafts[sessionId]?.error = describe(error)
        }
    }

    /// Interrupts the turn in flight. Never retried on its own.
    func cancelTurn(sessionId: String) async {
        guard let workspaceId = session(sessionId)?.workspaceId, canWrite(workspaceId), let runner = try? live else { return }
        let key = "cancel:\(sessionId)"
        actionErrors[key] = nil
        do {
            try await runner.send("sessions:cancel", SessionInput(sessionId: sessionId))
        } catch {
            if session(sessionId) != nil { actionErrors[key] = describe(error) }
        }
    }

    // MARK: Questions

    /// What has been typed or chosen for a question so far. Secret answers are never in it.
    func questionForm(_ request: QuestionRequest) -> QuestionForm {
        questions[request.requestId]?.form ?? QuestionForm(request: request)
    }

    /// Keeps a question's answers while its card is off screen. Secret answers are dropped here,
    /// so they can only ever live in the card that is showing them.
    func keepQuestionForm(sessionId: String, _ form: QuestionForm) {
        let requestId = form.request.requestId
        guard session(sessionId) != nil, isWaiting(sessionId, requestId), questions[requestId]?.sent != true else { return }
        questions[requestId] = QuestionDraft(sessionId: sessionId, form: form.withoutSecrets)
    }

    /// Accepted by the runner and waiting for the transcript to close it.
    func isAnswerSent(_ requestId: String) -> Bool { questions[requestId]?.sent == true }

    private func isWaiting(_ sessionId: String, _ requestId: String) -> Bool {
        let state = timelines[sessionId]?.transcript.state(ofRequest: requestId)
        return state == .open || state == .followUp
    }

    /// A question the transcript has closed takes what was typed for it along.
    private func settleQuestions(_ sessionId: String) {
        questions = questions.filter { $0.value.sessionId != sessionId || isWaiting(sessionId, $0.key) }
    }

    /// Answers a question that is still waiting, once. Returns whether the runner accepted it.
    @discardableResult
    func answer(sessionId: String, requestId: String, answers: [String: [String]]) async -> Bool {
        guard let workspaceId = session(sessionId)?.workspaceId, canWrite(workspaceId), let runner = try? live else { return false }
        // A question that closed while its card was open must not be answered after the fact.
        guard isWaiting(sessionId, requestId), !isAnswerSent(requestId) else { return false }
        let key = "question:\(requestId)"
        actionErrors[key] = nil
        do {
            try await runner.send("sessions:answerQuestion", AnswerInput(sessionId: sessionId, answer: .init(requestId: requestId, answers: answers)))
            guard session(sessionId) != nil else { return false }
            // Sent once: nothing typed for it is kept, and it cannot be sent again from here.
            questions[requestId] = QuestionDraft(sessionId: sessionId, form: nil, sent: true)
            settleQuestions(sessionId)
            return true
        } catch {
            if session(sessionId) != nil { actionErrors[key] = describe(error) }
            return false
        }
    }

    // MARK: Power

    func setPower(workspaceId: String, running: Bool) async {
        guard canWrite(workspaceId), !powerBusy.contains(workspaceId), let runner = try? live else { return }
        let key = "power:\(workspaceId)"
        actionErrors[key] = nil
        powerBusy.insert(workspaceId)
        defer { powerBusy.remove(workspaceId) }
        do {
            let state: WorkspacePower = try await runner.call(running ? "workspaces:start" : "workspaces:stop", WorkspaceInput(workspaceId: workspaceId))
            guard workspace(workspaceId) != nil else { return }
            power[workspaceId] = state
        } catch {
            if workspace(workspaceId) != nil { actionErrors[key] = describe(error) }
        }
    }

    // MARK: Files and changes (read only, never kept)

    /// The runner lists the workspace root as ".", and names its children "./name".
    private func relative(_ path: String) -> String { path.hasPrefix("./") ? String(path.dropFirst(2)) : path }

    func listDirectory(workspaceId: String, path: String) async throws -> [FileNode] {
        #if DEBUG
        if let previewFiles { return previewFiles.files[path] ?? [] }
        #endif
        let nodes: [FileNode] = try await live.call("files:listDir", PathInput(workspaceId: workspaceId, path: path.isEmpty ? "." : path))
        return nodes.map { FileNode(name: $0.name, path: relative($0.path), kind: $0.kind) }
    }

    func readFile(workspaceId: String, path: String) async throws -> FileText {
        #if DEBUG
        if let previewFiles { return FileText(text: previewFiles.fileText, language: "swift") }
        #endif
        return try await live.call("files:read", PathInput(workspaceId: workspaceId, path: path))
    }

    func changes(workspaceId: String) async throws -> [ChangeEntry] {
        #if DEBUG
        if let previewFiles { return previewFiles.changes }
        #endif
        return try await live.call("git:status", WorkspaceInput(workspaceId: workspaceId))
    }

    func diff(workspaceId: String, path: String) async throws -> String {
        #if DEBUG
        if let previewFiles { return previewFiles.diff }
        #endif
        return try await live.call("git:diff", PathInput(workspaceId: workspaceId, path: path))
    }
}
