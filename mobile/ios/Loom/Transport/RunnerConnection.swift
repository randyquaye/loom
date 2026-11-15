import Foundation

enum ConnectionState: Equatable, Sendable {
    /// Not trying: before the first connection, or while the app is in the background.
    case idle
    case connecting
    case connected
    /// The runner cannot be reached or proven right now; trying again shortly.
    case unreachable
    /// The runner no longer accepts this sign-in.
    case signedOut
    /// The app and the runner speak different protocol versions.
    case update(String)
}

enum RunnerEvent: Sendable {
    case state(ConnectionState)
    /// A live update. `frame` is the whole push frame; decode `PushPayload<T>` from it.
    case push(channel: String, frame: Data)
}

enum RunnerCallError: LocalizedError, Equatable {
    /// The runner's own answer, in its words.
    case refused(String)
    case unreachable
    case timedOut
    case signedOut

    var errorDescription: String? {
        switch self {
        case .refused(let message): return message
        case .unreachable: return "Not connected to your organization's host."
        case .timedOut: return "The host took too long to answer."
        case .signedOut: return "Your sign-in has ended."
        }
    }
}

/// `{"type":"result","ok":true,"value":…}` with the value a call expects.
struct ResultValue<Value: Decodable>: Decodable {
    let value: Value
}

/// `{"type":"push","payload":…}` with the payload a channel carries.
struct PushPayload<Payload: Decodable>: Decodable {
    let payload: Payload
}

private struct FrameHeader: Decodable {
    let type: String
    let id: Int?
    let ok: Bool?
    let error: String?
    let channel: String?
    let `protocol`: Int?
    let capabilities: [String]?
}

/// The app's one connection to its runner, speaking src/shared/runner-contract.ts.
///
/// It reconnects on its own while the app is in the foreground. Callbacks from a socket that has
/// been replaced are ignored by generation. Ordinary calls fail with the connection that carried
/// them and are never replayed; only a call that carries its own identity (a message with a
/// `messageId`, which the runner runs at most once) is sent again, unchanged, after a reconnect.
actor RunnerConnection {
    /// The stable base protocol (RUNNER_PROTOCOL). Additions are negotiated as capabilities.
    static let protocolVersion = 6
    /// Asked for on every upgrade (`x-loom-capabilities`). The runner's hello grants a subset.
    static let requestedCapabilities = ["bots.v1", "mobile.v1"]
    /// Without it the runner neither lists projects for a phone nor applies mobile scope rules,
    /// so nothing is asked of a runner that did not grant it. Bots are optional.
    static let requiredCapability = "mobile.v1"
    private static let retryMax: TimeInterval = 10
    private static let helloDeadline: TimeInterval = 10

    /// State changes and pushes, in the order they happened.
    nonisolated let events: AsyncStream<RunnerEvent>
    private let feed: AsyncStream<RunnerEvent>.Continuation
    private let tokens: TokenSource
    private let open: (String) async throws -> RunnerSocket
    private let callDeadline: TimeInterval
    private let retryFirst: TimeInterval

    private struct Pending {
        let frame: Data
        let identified: Bool
        let continuation: CheckedContinuation<Data, Error>
        let deadline: Task<Void, Never>
    }

    private var state = ConnectionState.idle
    private var socket: RunnerSocket?
    /// Counts sockets and attempts; anything carrying an older number is stale.
    private var generation = 0
    private var active = false
    private var stopped = false
    private var ready = false
    /// True once a token has been turned away with nothing useful received since.
    private var refused = false
    private var retryDelay: TimeInterval
    private var retry: Task<Void, Never>?
    private var helloTimer: Task<Void, Never>?
    private var outbox: Task<Void, Never>?
    private var nextID = 1
    private var pending: [Int: Pending] = [:]

    init(
        tokens: TokenSource,
        open: @escaping (String) async throws -> RunnerSocket,
        callDeadline: TimeInterval = 30,
        retryFirst: TimeInterval = 0.5
    ) {
        self.tokens = tokens
        self.open = open
        self.callDeadline = callDeadline
        self.retryFirst = retryFirst
        retryDelay = retryFirst
        (events, feed) = AsyncStream.makeStream(of: RunnerEvent.self)
    }

    // MARK: Lifecycle

    /// Starts connecting, or tries again after a sign-in, an update notice or a return to the foreground.
    func resume() {
        guard !stopped, !active else { return }
        active = true
        refused = false
        retryDelay = retryFirst
        Task { await connect() }
    }

    /// The app left the foreground: the socket closes and nothing is retried until `resume`.
    func suspend() {
        guard active || socket != nil else { return }
        active = false
        generation += 1
        retry?.cancel()
        dropSocket(failing: .unreachable, everything: true)
        set(.idle)
    }

    /// Drops the current socket and connects again now.
    func reconnectNow() {
        guard active else { return resume() }
        generation += 1
        retry?.cancel()
        dropSocket(failing: .unreachable, everything: false)
        refused = false
        retryDelay = retryFirst
        Task { await connect() }
    }

    func shutdown() {
        stopped = true
        active = false
        generation += 1
        retry?.cancel()
        dropSocket(failing: .unreachable, everything: true)
        feed.finish()
    }

    private func set(_ next: ConnectionState) {
        guard next != state else { return }
        state = next
        feed.yield(.state(next))
    }

    // MARK: Connecting

    private func connect() async {
        guard active else { return }
        generation += 1
        let mine = generation
        retry?.cancel()
        set(.connecting)
        let bearer: String?
        do {
            bearer = try await tokens.accessToken()
        } catch {
            // Renewing needs the runner too; if it cannot be reached or proven, neither can a socket.
            if current(mine) { retryLater() }
            return
        }
        guard current(mine) else { return }
        guard let bearer else { return endSignedOut() }
        let opened: RunnerSocket
        do {
            opened = try await open(bearer)
        } catch {
            guard current(mine) else { return }
            if error as? SocketOpenError == .rejected {
                // One fresh token is worth trying. A second refusal is not proof the sign-in is
                // over (only the token endpoint or a 4401 close says that), so it just retries.
                guard !refused else { return retryLater() }
                refused = true
                await tokens.invalidateAccess()
                if current(mine) { await connect() }
                return
            }
            return retryLater()
        }
        guard current(mine) else { return opened.close() }
        socket = opened
        Task { [weak self] in
            for await event in opened.events { await self?.handle(event, generation: mine) }
            await self?.handle(.closed(code: nil), generation: mine)
        }
        transmit(Data(#"{"type":"hello","protocol":\#(Self.protocolVersion)}"#.utf8), on: opened)
        helloTimer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.helloDeadline * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.helloOverdue(mine)
        }
    }

    private func current(_ mine: Int) -> Bool { mine == generation && active }

    private func helloOverdue(_ mine: Int) {
        guard current(mine), !ready else { return }
        dropSocket(failing: .unreachable, everything: false)
        retryLater()
    }

    private func retryLater() {
        set(.unreachable)
        let delay = retryDelay
        retryDelay = min(retryDelay * 2, Self.retryMax)
        let mine = generation
        retry = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.retryNow(mine)
        }
    }

    private func retryNow(_ mine: Int) async {
        guard current(mine) else { return }
        await connect()
    }

    private func endSignedOut() {
        active = false
        generation += 1
        dropSocket(failing: .signedOut, everything: true)
        set(.signedOut)
    }

    private func endUpdateRequired(_ message: String) {
        active = false
        generation += 1
        dropSocket(failing: .unreachable, everything: true)
        set(.update(message))
    }

    /// Ordinary calls fail with their connection. Identified ones wait for the next, unless `everything`.
    private func dropSocket(failing error: RunnerCallError, everything: Bool) {
        socket?.close()
        socket = nil
        ready = false
        helloTimer?.cancel()
        outbox = nil
        for (id, call) in pending where everything || !call.identified {
            pending[id] = nil
            call.deadline.cancel()
            call.continuation.resume(throwing: error)
        }
    }

    /// Frames leave in the order they were queued.
    private func transmit(_ frame: Data, on socket: RunnerSocket) {
        let earlier = outbox
        outbox = Task {
            await earlier?.value
            try? await socket.send(frame)
        }
    }

    // MARK: Receiving

    private func handle(_ event: SocketEvent, generation mine: Int) async {
        // A replaced socket can still deliver: none of it may count.
        guard current(mine), socket != nil else { return }
        switch event {
        case .frame(let data): receive(data)
        case .closed(let code): await closed(code)
        }
    }

    private func receive(_ data: Data) {
        guard let header = try? JSONDecoder().decode(FrameHeader.self, from: data) else { return }
        switch header.type {
        case "hello":
            guard !ready, let theirs = header.protocol else { return }
            guard theirs == Self.protocolVersion else {
                return endUpdateRequired(
                    Self.protocolVersion < theirs
                        ? "Update Loom: this app is older than your organization's host."
                        : "Your organization's host is older than this app and needs updating."
                )
            }
            // Checked before anything waiting is released: an absent list is an older runner.
            guard header.capabilities?.contains(Self.requiredCapability) == true else {
                return endUpdateRequired("Your organization's host needs an update before Loom for iPhone can use it.")
            }
            ready = true
            helloTimer?.cancel()
            retryDelay = retryFirst
            // Whatever waited for a connection goes out again, under the identity it had.
            if let socket {
                for id in pending.keys.sorted() { transmit(pending[id]!.frame, on: socket) }
            }
            set(.connected)
        case "push":
            guard ready, let channel = header.channel else { return }
            refused = false
            feed.yield(.push(channel: channel, frame: data))
        case "result":
            guard ready, let id = header.id, let call = pending.removeValue(forKey: id) else { return }
            refused = false
            call.deadline.cancel()
            if header.ok == true {
                call.continuation.resume(returning: data)
            } else {
                call.continuation.resume(throwing: RunnerCallError.refused(header.error ?? "The host refused the request."))
            }
        default:
            break
        }
    }

    private func closed(_ code: Int?) async {
        if code == 4400 { return endUpdateRequired("Loom and your organization's host are different versions.") }
        dropSocket(failing: .unreachable, everything: false)
        guard code == 4401 else { return retryLater() }
        // The sign-in or membership ended, or the access token simply expired: try one fresh
        // token. Turned away again with nothing received in between, it is over.
        guard !refused else { return endSignedOut() }
        refused = true
        let mine = generation
        await tokens.invalidateAccess()
        if current(mine) { await connect() }
    }

    // MARK: Calls

    private func request(_ channel: String, input: Data?, identified: Bool) async throws -> Data {
        guard active, ready || identified else {
            throw state == .signedOut ? RunnerCallError.signedOut : RunnerCallError.unreachable
        }
        let id = nextID
        nextID += 1
        var frame = Data(#"{"type":"call","id":\#(id),"channel":"\#(channel)""#.utf8)
        if let input {
            frame.append(Data(#","input":"#.utf8))
            frame.append(input)
        }
        frame.append(UInt8(ascii: "}"))
        // An identified call may wait out one reconnect; it is still bounded, and failing it is
        // safe because a retry carries the same identity.
        let limit = identified ? callDeadline * 2 : callDeadline
        return try await withCheckedThrowingContinuation { continuation in
            let deadline = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(limit * 1_000_000_000))
                guard !Task.isCancelled else { return }
                await self?.expire(id)
            }
            pending[id] = Pending(frame: frame, identified: identified, continuation: continuation, deadline: deadline)
            if ready, let socket { transmit(frame, on: socket) }
        }
    }

    /// A late answer finds nothing waiting and is ignored.
    private func expire(_ id: Int) {
        pending.removeValue(forKey: id)?.continuation.resume(throwing: RunnerCallError.timedOut)
    }

    private func decode<Output: Decodable>(_ data: Data) throws -> Output {
        do {
            return try JSONDecoder().decode(ResultValue<Output>.self, from: data).value
        } catch {
            throw RunnerCallError.refused("The host sent a reply this version of Loom cannot read.")
        }
    }

    func call<Input: Encodable, Output: Decodable>(_ channel: String, _ input: Input, as: Output.Type = Output.self) async throws -> Output {
        try decode(try await request(channel, input: try JSONEncoder().encode(input), identified: false))
    }

    func call<Output: Decodable>(_ channel: String, as: Output.Type = Output.self) async throws -> Output {
        try decode(try await request(channel, input: nil, identified: false))
    }

    /// A call whose answer carries nothing. `identified` is only for inputs with a `messageId`.
    func send<Input: Encodable>(_ channel: String, _ input: Input, identified: Bool = false) async throws {
        _ = try await request(channel, input: try JSONEncoder().encode(input), identified: identified)
    }

    func send(_ channel: String) async throws {
        _ = try await request(channel, input: nil, identified: false)
    }
}
